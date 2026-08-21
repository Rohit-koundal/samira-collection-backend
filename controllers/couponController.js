const mongoose = require('mongoose');
const Coupon = require('../models/Coupon');
const couponService = require('../services/couponService');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, notFound } = require('../utils/apiError');
const { requireCouponCode, requireEnum, requireObjectId, wantsPagination, readPagination, buildPaginatedResponse } = require('../utils/validators');
const { andFilter } = require('../services/storeService');
const { logAudit } = require('../services/auditService');

exports.getCoupons = asyncHandler(async (req, res) => {
  const isAdminRequest = (req.query.admin === 'true' && req.user?.role === 'admin')
    || String(req.baseUrl || '').startsWith('/api/seller');
  const query = andFilter(isAdminRequest ? {} : { isActive: true, expiryDate: { $gte: new Date() } }, req.tenantFilter);
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([Coupon.find(query).sort('-createdAt').skip(skip).limit(limit), Coupon.countDocuments(query)]);
    return res.json(buildPaginatedResponse(items, { page, limit, total }));
  }
  res.json(await Coupon.find(query).sort('-createdAt').limit(200));
});

exports.createCoupon = asyncHandler(async (req, res) => {
  const payload = readCouponPayload(req.body);
  delete payload.storeId;
  if (req.store?._id) payload.storeId = req.store._id;
  const coupon = await Coupon.create(payload);
  logAudit({ req, action: 'COUPON_CREATE', entityType: 'Coupon', entityId: coupon._id, after: { code: coupon.code } });
  res.status(201).json(coupon);
});

exports.updateCoupon = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'coupon id');
  const coupon = await Coupon.findByIdAndUpdate(req.params.id, readCouponPayload(req.body, { partial: true }), {
    new: true,
    runValidators: true,
  });
  if (!coupon) throw notFound('Coupon not found');
  res.json(coupon);
});

exports.deleteCoupon = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'coupon id');
  const coupon = await Coupon.findByIdAndDelete(req.params.id);
  if (!coupon) throw notFound('Coupon not found');
  res.json({ success: true, message: 'Coupon deleted' });
});

/**
 * Preview endpoint for the checkout screen. The discount shown here is
 * recalculated at order time by the same service, so this response is only a
 * preview and never the number the customer is charged against.
 */
exports.applyCoupon = asyncHandler(async (req, res) => {
  const { coupon, discountAmount } = await couponService.validateAndPrice({
    code: req.body?.code,
    cartTotal: Number(req.body?.cartTotal || req.body?.amount || 0),
    paymentMethod: req.body?.paymentMethod,
    items: req.body?.items,
    userId: req.user?._id,
  });

  res.json({
    success: true,
    couponCode: coupon.code,
    discountAmount,
    discount: discountAmount,
    message: `${coupon.code} applied`,
    coupon,
  });
});

function readObjectIdList(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item?._id || item || '').trim())
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
}

/**
 * Admin coupon writes never accept usedCount or other ledger fields from the
 * client. usedCount is owned by consumeCoupon / releaseCoupon.
 */
function readCouponPayload(body = {}, { partial = false } = {}) {
  const payload = {};

  if (!partial || body.code !== undefined) payload.code = requireCouponCode(body.code);
  if (!partial || body.type !== undefined) payload.type = requireEnum(body.type, ['Percentage', 'Flat'], 'type');
  if (!partial || body.discountValue !== undefined) {
    const discountValue = Number(body.discountValue);
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      throw new ApiError('VALIDATION_ERROR', 'Discount value must be positive');
    }
    payload.discountValue = discountValue;
  }
  if (payload.type === 'Percentage' && payload.discountValue > 100) {
    throw new ApiError('VALIDATION_ERROR', 'Percentage discount cannot exceed 100');
  }
  if (!partial || body.minOrderAmount !== undefined) {
    const minOrderAmount = Number(body.minOrderAmount || 0);
    if (!Number.isFinite(minOrderAmount) || minOrderAmount < 0) {
      throw new ApiError('VALIDATION_ERROR', 'Minimum order amount cannot be negative');
    }
    payload.minOrderAmount = minOrderAmount;
  }
  if (!partial || body.maxDiscountAmount !== undefined) {
    payload.maxDiscountAmount = Number(body.maxDiscountAmount || 0) || undefined;
  }
  if (!partial || body.validFrom !== undefined) {
    payload.validFrom = body.validFrom ? new Date(body.validFrom) : undefined;
    if (payload.validFrom && Number.isNaN(payload.validFrom.getTime())) {
      throw new ApiError('VALIDATION_ERROR', 'Start date is invalid');
    }
  }
  if (!partial || body.expiryDate !== undefined) {
    if (!body.expiryDate) throw new ApiError('VALIDATION_ERROR', 'Expiry date is required');
    payload.expiryDate = new Date(body.expiryDate);
    if (Number.isNaN(payload.expiryDate.getTime())) throw new ApiError('VALIDATION_ERROR', 'Expiry date is invalid');
  }
  if (!partial || body.usageLimit !== undefined) {
    payload.usageLimit = Number(body.usageLimit || 0) || undefined;
  }
  if (!partial || body.applicablePaymentMethods !== undefined) {
    payload.applicablePaymentMethods = Array.isArray(body.applicablePaymentMethods)
      ? body.applicablePaymentMethods.map((method) => String(method || '').toUpperCase()).filter(Boolean)
      : [];
  }
  if (!partial || body.applicableProducts !== undefined) {
    payload.applicableProducts = readObjectIdList(body.applicableProducts);
  }
  if (!partial || body.applicableCategories !== undefined) {
    payload.applicableCategories = readObjectIdList(body.applicableCategories);
  }
  if (!partial || body.customerLimit !== undefined) {
    payload.customerLimit = Number(body.customerLimit || 0) || undefined;
  }
  if (!partial || body.firstOrderOnly !== undefined) {
    payload.firstOrderOnly = Boolean(body.firstOrderOnly);
  }
  if (!partial || body.isActive !== undefined) {
    payload.isActive = body.isActive !== false;
  }

  return payload;
}
