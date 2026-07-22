const Cart = require('../models/Cart');
const Coupon = require('../models/Coupon');
const { validateCouponForCheckout } = require('../services/couponService');
const {
  assertObjectId,
  cleanString,
  finiteMoney,
  paginationEnvelope,
  parsePagination,
  pick,
} = require('../utils/requestValidation');

const MUTABLE_FIELDS = [
  'code', 'type', 'discountValue', 'minOrderAmount', 'maxDiscountAmount', 'startDate', 'expiryDate',
  'usageLimit', 'perCustomerUsageLimit', 'applicableProducts', 'applicableCategories', 'excludedProducts',
  'firstOrderOnly', 'allowedPaymentMethods', 'customers', 'isPrivate', 'isActive',
];

exports.getCoupons = async (req, res) => {
  if (['admin', 'owner'].includes(req.user?.role)) return exports.adminCoupons(req, res);
  const now = new Date();
  const coupons = await Coupon.find({
    isActive: true,
    isPrivate: false,
    startDate: { $lte: now },
    expiryDate: { $gt: now },
  }).select('code type discountValue minOrderAmount maxDiscountAmount startDate expiryDate').sort('expiryDate').lean();
  return res.json(coupons);
};

exports.adminCoupons = async (req, res) => {
  const { page, limit, skip, sort } = parsePagination(req.query, {
    allowedSorts: ['createdAt', 'expiryDate', 'code', 'usedCount'],
  });
  const filter = {};
  if (req.query.active === 'true') filter.isActive = true;
  if (req.query.active === 'false') filter.isActive = false;
  if (req.query.search) filter.code = { $regex: escapeRegex(String(req.query.search).trim()), $options: 'i' };
  const [items, total] = await Promise.all([
    Coupon.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Coupon.countDocuments(filter),
  ]);
  return res.json(paginationEnvelope(items, total, page, limit));
};

exports.createCoupon = async (req, res) => {
  const payload = normalizeCouponPayload(pick(req.body, MUTABLE_FIELDS), true);
  return res.status(201).json(await Coupon.create(payload));
};

exports.updateCoupon = async (req, res) => {
  assertObjectId(req.params.id, 'coupon id');
  const payload = normalizeCouponPayload(pick(req.body, MUTABLE_FIELDS), false);
  const coupon = await Coupon.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
  if (!coupon) return res.status(404).json({ message: 'Coupon not found' });
  return res.json(coupon);
};

exports.deleteCoupon = async (req, res) => {
  assertObjectId(req.params.id, 'coupon id');
  const coupon = await Coupon.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!coupon) return res.status(404).json({ message: 'Coupon not found' });
  return res.json({ message: 'Coupon archived', coupon });
};

exports.applyCoupon = async (req, res) => {
  const cart = await Cart.findOne({ user: req.user._id }).populate('items.product');
  if (!cart?.items?.length) return res.status(400).json({ message: 'Cart is empty', code: 'CART_EMPTY' });
  const items = cart.items.map((item) => {
    const variant = item.product?.variants?.id?.(item.variantId)
      || item.product?.variants?.find?.((entry) => String(entry._id) === String(item.variantId));
    return {
      productId: item.product?._id,
      categoryId: item.product?.category,
      quantity: Number(item.quantity || 0),
      unitPrice: Number(variant?.price ?? item.product?.price ?? 0),
    };
  });
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const { snapshot } = await validateCouponForCheckout({
    code: req.body.code,
    userId: req.user._id,
    items,
    subtotal,
    paymentMethod: req.body.paymentMethod,
  });
  return res.json({
    success: true,
    couponCode: snapshot.code,
    discountAmount: snapshot.discountAmount,
    discount: snapshot.discountAmount,
    subtotal: snapshot.subtotal,
    message: `${snapshot.code} applied`,
  });
};

function normalizeCouponPayload(data, creating) {
  const payload = { ...data };
  if (creating || payload.code !== undefined) payload.code = cleanString(payload.code, { field: 'code', min: 2, max: 40, required: true }).toUpperCase();
  if (creating || payload.type !== undefined) {
    if (!['Percentage', 'Flat'].includes(payload.type)) throw badRequest('Coupon type must be Percentage or Flat');
  }
  if (creating || payload.discountValue !== undefined) {
    payload.discountValue = finiteMoney(payload.discountValue, { field: 'discountValue', min: 0.01 });
    if (payload.type === 'Percentage' && payload.discountValue > 100) throw badRequest('Percentage discount cannot exceed 100');
  }
  for (const field of ['minOrderAmount', 'maxDiscountAmount']) {
    if (payload[field] !== undefined && payload[field] !== null && payload[field] !== '') {
      payload[field] = finiteMoney(payload[field], { field });
    }
  }
  for (const field of ['usageLimit', 'perCustomerUsageLimit']) {
    if (payload[field] !== undefined && payload[field] !== null && payload[field] !== '') {
      const value = Number(payload[field]);
      if (!Number.isSafeInteger(value) || value < 1) throw badRequest(`${field} must be a positive integer`);
      payload[field] = value;
    }
  }
  if (creating || payload.expiryDate !== undefined) {
    const expiry = new Date(payload.expiryDate);
    if (Number.isNaN(expiry.getTime())) throw badRequest('A valid expiry date is required');
    payload.expiryDate = expiry;
  }
  if (payload.startDate !== undefined) {
    const start = new Date(payload.startDate);
    if (Number.isNaN(start.getTime())) throw badRequest('A valid start date is required');
    payload.startDate = start;
  }
  if (payload.startDate && payload.expiryDate && payload.expiryDate <= payload.startDate) {
    throw badRequest('Expiry date must be after the start date');
  }
  for (const field of ['applicableProducts', 'applicableCategories', 'excludedProducts', 'customers']) {
    if (payload[field] !== undefined) {
      if (!Array.isArray(payload[field])) throw badRequest(`${field} must be an array`);
      payload[field] = [...new Set(payload[field].map((value) => assertObjectId(value, field)))];
    }
  }
  if (payload.allowedPaymentMethods !== undefined) {
    if (!Array.isArray(payload.allowedPaymentMethods)) throw badRequest('allowedPaymentMethods must be an array');
    const allowed = ['COD', 'Razorpay', 'UPI', 'CARD', 'NETBANKING', 'WALLET'];
    payload.allowedPaymentMethods = [...new Set(payload.allowedPaymentMethods)];
    if (payload.allowedPaymentMethods.some((method) => !allowed.includes(method))) throw badRequest('Unsupported coupon payment method');
  }
  return payload;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
