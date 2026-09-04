const Coupon = require('../models/Coupon');
const Order = require('../models/Order');
const { ApiError } = require('../utils/apiError');
const { requireCouponCode } = require('../utils/validators');
const { andFilter } = require('./storeService');

/**
 * Single source of truth for coupon rules.
 *
 * Every entry point (apply preview, COD checkout, Razorpay checkout, payment
 * verification) must go through here so a customer cannot get a different
 * answer depending on which door they knock on.
 */

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function idList(value) {
  return (Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean);
}

function itemProductId(item) {
  return String(item?.product?._id || item?.product || item?.productId || '');
}

function itemCategoryId(item) {
  return String(item?.category?._id || item?.category || '');
}

function itemLineTotal(item) {
  const storedLineTotal = Number(item?.lineTotal);
  if (Number.isFinite(storedLineTotal) && storedLineTotal >= 0) return storedLineTotal;
  return Number(item?.price || 0) * Math.max(1, Number(item?.quantity || 1));
}

/**
 * When a coupon is restricted to products or categories, the discount is
 * computed only against matching lines. A cart with no matching lines is
 * refused rather than silently discounted at Rs. 0.
 */
function eligibleCartTotal(coupon, cartTotal, items) {
  const productIds = idList(coupon?.applicableProducts);
  const categoryIds = idList(coupon?.applicableCategories);
  if (!productIds.length && !categoryIds.length) return Number(cartTotal || 0);

  if (!Array.isArray(items) || !items.length) {
    throw new ApiError('INVALID_COUPON', 'This coupon does not apply to the items in your bag');
  }

  let eligible = 0;
  for (const item of items) {
    const productOk = !productIds.length || productIds.includes(itemProductId(item));
    const categoryOk = !categoryIds.length || categoryIds.includes(itemCategoryId(item));
    if (productOk && categoryOk) eligible += itemLineTotal(item);
  }

  if (eligible <= 0) {
    throw new ApiError('INVALID_COUPON', 'This coupon does not apply to the items in your bag');
  }
  return eligible;
}

async function assertCustomerRules(coupon, userId, tenantFilter = {}) {
  if (!userId || !coupon) return;

  if (coupon.firstOrderOnly) {
    const prior = await Order.countDocuments(andFilter({
      user: userId,
      orderStatus: { $ne: 'Cancelled' },
      paymentStatus: { $ne: 'Failed' },
    }, tenantFilter));
    if (prior > 0) {
      throw new ApiError('INVALID_COUPON', 'This coupon is valid on your first order only');
    }
  }

  const customerLimit = Number(coupon.customerLimit || 0);
  if (customerLimit > 0) {
    const usedByCustomer = await Order.countDocuments(andFilter({
      user: userId,
      'coupon.code': coupon.code,
      orderStatus: { $ne: 'Cancelled' },
      paymentStatus: { $ne: 'Failed' },
    }, tenantFilter));
    if (usedByCustomer >= customerLimit) {
      throw new ApiError('INVALID_COUPON', 'You have already used this coupon the maximum number of times');
    }
  }
}

/**
 * Loads a coupon and checks every rule. Never trusts a client-sent discount.
 */
async function assertCouponRules(coupon, { cartTotal, paymentMethod, items, userId, tenantFilter = {} } = {}) {
  if (!coupon || !coupon.isActive) {
    throw new ApiError('INVALID_COUPON', 'This coupon code is not valid');
  }
  const now = new Date();
  if (coupon.validFrom && new Date(coupon.validFrom) > now) {
    throw new ApiError('INVALID_COUPON', 'This coupon is not active yet');
  }
  if (coupon.expiryDate && new Date(coupon.expiryDate) < now) {
    throw new ApiError('COUPON_EXPIRED', 'This coupon has expired');
  }
  if (coupon.usageLimit && Number(coupon.usedCount || 0) >= Number(coupon.usageLimit)) {
    throw new ApiError('INVALID_COUPON', 'This coupon has reached its usage limit');
  }

  const amount = Number(cartTotal || 0);
  if (amount <= 0) {
    throw new ApiError('INVALID_COUPON', 'Add items to your bag before applying a coupon');
  }
  if (coupon.minOrderAmount && amount < Number(coupon.minOrderAmount)) {
    const amountNeeded = Math.ceil(Number(coupon.minOrderAmount) - amount);
    const error = new ApiError('INVALID_COUPON', `Add items worth Rs. ${amountNeeded} more to use this coupon`);
    error.amountNeeded = amountNeeded;
    throw error;
  }

  const method = String(paymentMethod || '').toUpperCase();
  const allowedMethods = Array.isArray(coupon.applicablePaymentMethods)
    ? coupon.applicablePaymentMethods.map((item) => String(item).toUpperCase()).filter(Boolean)
    : [];
  if (method && allowedMethods.length && !allowedMethods.includes(method)) {
    throw new ApiError('INVALID_COUPON', `This coupon cannot be used with ${method} payments`);
  }

  eligibleCartTotal(coupon, cartTotal, items);
  await assertCustomerRules(coupon, userId, tenantFilter);
  return coupon;
}

async function validateCoupon({ code, cartTotal, paymentMethod, items, userId, tenantFilter = {} } = {}) {
  const normalizedCode = requireCouponCode(code);
  const coupon = await Coupon.findOne(andFilter({ code: normalizedCode }, tenantFilter));
  return assertCouponRules(coupon, { cartTotal, paymentMethod, items, userId, tenantFilter });
}

/** Discount is always recomputed from the stored coupon definition. */
function calculateDiscount(coupon, cartTotal, items) {
  const amount = eligibleCartTotal(coupon, cartTotal, items);
  if (!coupon || amount <= 0) return 0;

  const raw = coupon.type === 'Percentage'
    ? (amount * Number(coupon.discountValue || 0)) / 100
    : Number(coupon.discountValue || 0);

  const cap = Number(coupon.maxDiscountAmount || 0) > 0 ? Number(coupon.maxDiscountAmount) : raw;
  return round(Math.max(0, Math.min(raw, cap, amount)));
}

/** Convenience wrapper returning both the coupon and its computed discount. */
async function validateAndPrice({ code, cartTotal, paymentMethod, items, userId, tenantFilter = {} } = {}) {
  const coupon = await validateCoupon({ code, cartTotal, paymentMethod, items, userId, tenantFilter });
  return { coupon, discountAmount: calculateDiscount(coupon, cartTotal, items) };
}

async function evaluateCoupon(coupon, context = {}) {
  try {
    await assertCouponRules(coupon, context);
    return {
      eligible: true,
      estimatedDiscount: calculateDiscount(coupon, context.cartTotal, context.items),
      reason: '',
      reasonCode: '',
      amountNeeded: 0,
    };
  } catch (error) {
    return {
      eligible: false,
      estimatedDiscount: 0,
      reason: error.message || 'This coupon is not eligible for your bag',
      reasonCode: error.errorCode || 'INVALID_COUPON',
      amountNeeded: Number(error.amountNeeded || 0),
    };
  }
}

/**
 * Increments usage only while the limit still allows it, so two orders racing
 * for the last redemption cannot both consume it.
 */
async function consumeCoupon(code, { session, tenantFilter = {} } = {}) {
  if (!code) return null;
  const normalizedCode = String(code).toUpperCase();

  const withinLimit = await Coupon.findOneAndUpdate(
    andFilter({
      code: normalizedCode,
      $or: [
        { usageLimit: { $exists: false } },
        { usageLimit: null },
        { usageLimit: 0 },
        { $expr: { $lt: ['$usedCount', '$usageLimit'] } },
      ],
    }, tenantFilter),
    { $inc: { usedCount: 1 } },
    { new: true, session },
  );

  if (!withinLimit) {
    throw new ApiError('INVALID_COUPON', 'This coupon has reached its usage limit');
  }
  return withinLimit;
}

/** Gives a redemption back; never drives usedCount below zero. */
async function releaseCoupon(code, { session, tenantFilter = {} } = {}) {
  if (!code) return null;
  return Coupon.findOneAndUpdate(
    andFilter({ code: String(code).toUpperCase(), usedCount: { $gt: 0 } }, tenantFilter),
    { $inc: { usedCount: -1 } },
    { new: true, session },
  );
}

module.exports = {
  calculateDiscount,
  consumeCoupon,
  evaluateCoupon,
  releaseCoupon,
  validateAndPrice,
  validateCoupon,
};
