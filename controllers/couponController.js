const mongoose = require('mongoose');
const Coupon = require('../models/Coupon');
const couponService = require('../services/couponService');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, notFound } = require('../utils/apiError');
const {
  buildPaginatedResponse,
  optionalString,
  readPagination,
  requireBoolean,
  requireCouponCode,
  requireEnum,
  requireObjectId,
  wantsPagination,
} = require('../utils/validators');
const { andFilter } = require('../services/storeService');
const { logAudit } = require('../services/auditService');
const { auditSnapshot } = require('../utils/auditData');
const COUPON_AUDIT_FIELDS = ['code', 'type', 'discountValue', 'minOrderAmount', 'maxDiscountAmount', 'validFrom', 'expiryDate', 'usageLimit', 'customerLimit', 'firstOrderOnly', 'isActive', 'isPublic', 'applicablePaymentMethods', 'applicableProducts', 'applicableCategories'];

const PAYMENT_METHODS = ['COD', 'UPI', 'CARD', 'NETBANKING', 'WALLET'];

function livePublicQuery(now = new Date()) {
  return {
    $and: [
      { isActive: true },
      { isPublic: { $ne: false } },
      { expiryDate: { $gte: now } },
      { $or: [{ validFrom: { $exists: false } }, { validFrom: null }, { validFrom: { $lte: now } }] },
      {
        $or: [
          { usageLimit: { $exists: false } },
          { usageLimit: null },
          { usageLimit: 0 },
          { $expr: { $lt: ['$usedCount', '$usageLimit'] } },
        ],
      },
    ],
  };
}

function publicCouponView(coupon, eligibility = {}) {
  const value = typeof coupon?.toObject === 'function' ? coupon.toObject() : { ...(coupon || {}) };
  return {
    _id: value._id,
    code: value.code,
    title: value.title || '',
    description: value.description || '',
    terms: value.terms || '',
    type: value.type,
    discountValue: value.discountValue,
    minOrderAmount: value.minOrderAmount || 0,
    maxDiscountAmount: value.maxDiscountAmount || 0,
    validFrom: value.validFrom || null,
    expiryDate: value.expiryDate,
    applicablePaymentMethods: value.applicablePaymentMethods || [],
    applicableProducts: value.applicableProducts || [],
    applicableCategories: value.applicableCategories || [],
    customerLimit: value.customerLimit || 0,
    firstOrderOnly: Boolean(value.firstOrderOnly),
    ...eligibility,
  };
}

exports.getCoupons = asyncHandler(async (req, res) => {
  const isAdminRequest = (req.user?.role === 'admin'
    && (req.query.admin === 'true' || String(req.baseUrl || '').startsWith('/api/admin')))
    || String(req.baseUrl || '').startsWith('/api/seller');
  const query = andFilter(isAdminRequest ? {} : livePublicQuery(), req.tenantFilter);
  const finder = () => Coupon.find(query).sort(isAdminRequest ? '-createdAt' : { discountValue: -1, expiryDate: 1 });
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([finder().skip(skip).limit(limit), Coupon.countDocuments(query)]);
    return res.json(buildPaginatedResponse(isAdminRequest ? items : items.map((item) => publicCouponView(item)), { page, limit, total }));
  }
  const items = await finder().limit(200);
  return res.json(isAdminRequest ? items : items.map((item) => publicCouponView(item)));
});

exports.getAvailableCoupons = asyncHandler(async (req, res) => {
  const cart = await resolvePreviewCart(req.body, req.tenantFilter);
  const coupons = await Coupon.find(andFilter(livePublicQuery(), req.tenantFilter)).sort({ discountValue: -1, expiryDate: 1 }).limit(200);
  const context = {
    cartTotal: cart.cartTotal,
    items: cart.items,
    paymentMethod: req.body?.paymentMethod,
    userId: req.user?._id,
    tenantFilter: req.tenantFilter,
  };
  const evaluated = await Promise.all(coupons.map(async (coupon) => publicCouponView(coupon, await couponService.evaluateCoupon(coupon, context))));
  evaluated.sort((left, right) => Number(right.eligible) - Number(left.eligible)
    || Number(right.estimatedDiscount || 0) - Number(left.estimatedDiscount || 0)
    || String(left.code).localeCompare(String(right.code)));
  res.json({
    items: evaluated,
    cartTotal: cart.cartTotal,
    bestCouponCode: evaluated.find((coupon) => coupon.eligible && coupon.estimatedDiscount > 0)?.code || null,
  });
});

exports.createCoupon = asyncHandler(async (req, res) => {
  const payload = readCouponPayload(req.body);
  delete payload.storeId;
  if (req.store?._id) payload.storeId = req.store._id;
  try {
    const coupon = await Coupon.create(payload);
    logAudit({ req, action: 'COUPON_CREATE', entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, after: auditSnapshot(coupon, COUPON_AUDIT_FIELDS) });
    res.status(201).json(coupon);
  } catch (error) {
    if (error?.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'A coupon with this code already exists');
    throw error;
  }
});

exports.updateCoupon = asyncHandler(async (req, res) => {
  const couponId = requireObjectId(req.params.id, 'coupon id');
  const coupon = await Coupon.findOne(andFilter({ _id: couponId }, req.tenantFilter));
  if (!coupon) throw notFound('Coupon not found');
  const before = auditSnapshot(coupon, COUPON_AUDIT_FIELDS);
  const payload = readCouponPayload({ ...coupon.toObject(), ...req.body });
  Object.assign(coupon, payload);
  try {
    await coupon.save();
  } catch (error) {
    if (error?.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'A coupon with this code already exists');
    throw error;
  }
  logAudit({ req, action: 'COUPON_UPDATE', entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, before, after: auditSnapshot(coupon, COUPON_AUDIT_FIELDS) });
  res.json(coupon);
});

exports.deleteCoupon = asyncHandler(async (req, res) => {
  const couponId = requireObjectId(req.params.id, 'coupon id');
  const coupon = await Coupon.findOne(andFilter({ _id: couponId }, req.tenantFilter));
  if (!coupon) throw notFound('Coupon not found');
  const before = auditSnapshot(coupon, COUPON_AUDIT_FIELDS);
  if (Number(coupon.usedCount || 0) > 0) {
    coupon.isActive = false;
    coupon.isPublic = false;
    await coupon.save();
    logAudit({ req, action: 'COUPON_ARCHIVE', entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, before, after: auditSnapshot(coupon, COUPON_AUDIT_FIELDS) });
    return res.json({ success: true, archived: true, message: 'Used coupon archived to preserve redemption history', coupon });
  }
  await coupon.deleteOne();
  logAudit({ req, action: 'COUPON_DELETE', entityType: 'Coupon', entityId: coupon._id, storeId: coupon.storeId, before });
  return res.json({ success: true, archived: false, message: 'Coupon deleted' });
});

exports.applyCoupon = asyncHandler(async (req, res) => {
  const cart = await resolvePreviewCart(req.body, req.tenantFilter);
  const { coupon, discountAmount } = await couponService.validateAndPrice({
    code: req.body?.code,
    cartTotal: cart.cartTotal,
    paymentMethod: req.body?.paymentMethod,
    items: cart.items,
    userId: req.user?._id,
    tenantFilter: req.tenantFilter,
  });

  res.json({
    success: true,
    couponCode: coupon.code,
    discountAmount,
    discount: discountAmount,
    message: `${coupon.code} applied. You saved Rs. ${discountAmount}.`,
    coupon: publicCouponView(coupon, { eligible: true, estimatedDiscount: discountAmount }),
  });
});

async function resolvePreviewCart(body = {}, tenantFilter = {}) {
  if (Array.isArray(body.items) && body.items.length) {
    const { loadOrderItems } = require('../services/orderPricingService');
    const priced = await loadOrderItems(body.items, { tenantFilter });
    return { items: priced.items, cartTotal: priced.sellingTotal };
  }
  const cartTotal = Number(body.cartTotal || body.amount || 0);
  return { items: [], cartTotal: Number.isFinite(cartTotal) ? cartTotal : 0 };
}

function readObjectIdList(value, field) {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => String(item?._id || item || '').trim()).filter(Boolean);
  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new ApiError('VALIDATION_ERROR', `${field} contains an invalid selection`);
  }
  return Array.from(new Set(ids));
}

function readOptionalLimit(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ApiError('VALIDATION_ERROR', `${field} must be a whole number of 0 or more`);
  return parsed || undefined;
}

function readCouponPayload(body = {}) {
  const payload = {
    code: requireCouponCode(body.code),
    title: optionalString(body.title, 'title', { max: 120 }),
    description: optionalString(body.description, 'description', { max: 500 }),
    terms: optionalString(body.terms, 'terms', { max: 1200 }),
    type: requireEnum(body.type, ['Percentage', 'Flat'], 'type'),
  };

  const discountValue = Number(body.discountValue);
  if (!Number.isFinite(discountValue) || discountValue <= 0) throw new ApiError('VALIDATION_ERROR', 'Discount value must be positive');
  if (payload.type === 'Percentage' && discountValue > 100) throw new ApiError('VALIDATION_ERROR', 'Percentage discount cannot exceed 100');
  payload.discountValue = discountValue;

  const minOrderAmount = Number(body.minOrderAmount || 0);
  if (!Number.isFinite(minOrderAmount) || minOrderAmount < 0) throw new ApiError('VALIDATION_ERROR', 'Minimum order amount cannot be negative');
  payload.minOrderAmount = minOrderAmount;

  const maxDiscountAmount = Number(body.maxDiscountAmount || 0);
  if (!Number.isFinite(maxDiscountAmount) || maxDiscountAmount < 0) throw new ApiError('VALIDATION_ERROR', 'Maximum discount cannot be negative');
  payload.maxDiscountAmount = maxDiscountAmount || undefined;

  payload.validFrom = body.validFrom ? new Date(body.validFrom) : undefined;
  if (payload.validFrom && Number.isNaN(payload.validFrom.getTime())) throw new ApiError('VALIDATION_ERROR', 'Start date is invalid');
  if (!body.expiryDate) throw new ApiError('VALIDATION_ERROR', 'Expiry date is required');
  payload.expiryDate = new Date(body.expiryDate);
  if (Number.isNaN(payload.expiryDate.getTime())) throw new ApiError('VALIDATION_ERROR', 'Expiry date is invalid');
  if (payload.validFrom && payload.expiryDate <= payload.validFrom) throw new ApiError('VALIDATION_ERROR', 'Expiry date must be after the start date');

  payload.usageLimit = readOptionalLimit(body.usageLimit, 'Usage limit');
  payload.customerLimit = readOptionalLimit(body.customerLimit, 'Per-customer limit');

  const methods = Array.isArray(body.applicablePaymentMethods) ? body.applicablePaymentMethods : [];
  payload.applicablePaymentMethods = Array.from(new Set(methods.map((method) => String(method || '').toUpperCase()).filter(Boolean)));
  if (payload.applicablePaymentMethods.some((method) => !PAYMENT_METHODS.includes(method))) {
    throw new ApiError('VALIDATION_ERROR', 'Applicable payment methods contain an unsupported option');
  }
  payload.applicableProducts = readObjectIdList(body.applicableProducts, 'Applicable products');
  payload.applicableCategories = readObjectIdList(body.applicableCategories, 'Applicable categories');
  payload.firstOrderOnly = requireBoolean(body.firstOrderOnly ?? false, 'firstOrderOnly');
  payload.isPublic = requireBoolean(body.isPublic ?? true, 'isPublic');
  payload.isActive = requireBoolean(body.isActive ?? true, 'isActive');
  return payload;
}

exports.livePublicQuery = livePublicQuery;
exports.publicCouponView = publicCouponView;
exports.readCouponPayload = readCouponPayload;
