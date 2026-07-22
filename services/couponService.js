const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const CouponUsageCounter = require('../models/CouponUsageCounter');
const Order = require('../models/Order');

class CouponError extends Error {
  constructor(message, code = 'COUPON_INVALID', statusCode = 400) {
    super(message);
    this.name = 'CouponError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function validateCouponForCheckout({
  code,
  userId,
  items = [],
  subtotal,
  paymentMethod,
  session,
  now = new Date(),
}) {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!normalizedCode) throw new CouponError('Coupon code is required', 'COUPON_REQUIRED');

  let query = Coupon.findOne({ code: normalizedCode }).select('+reservedCount');
  if (session) query = query.session(session);
  const coupon = await query;
  if (!coupon || !coupon.isActive || coupon.startDate > now || coupon.expiryDate <= now) {
    throw new CouponError('Invalid or expired coupon', 'COUPON_INVALID');
  }
  if (coupon.usageLimit && Number(coupon.usedCount || 0) + Number(coupon.reservedCount || 0) >= coupon.usageLimit) {
    throw new CouponError('Coupon usage limit reached', 'COUPON_LIMIT_REACHED', 409);
  }
  if (coupon.customers?.length && !coupon.customers.some((id) => String(id) === String(userId))) {
    throw new CouponError('Coupon is not available for this account', 'COUPON_NOT_ELIGIBLE');
  }
  if (coupon.allowedPaymentMethods?.length && paymentMethod && !coupon.allowedPaymentMethods.includes(paymentMethod)) {
    throw new CouponError('Coupon is not valid for this payment method', 'COUPON_PAYMENT_METHOD');
  }

  if (userId) {
    let counterQuery = CouponUsageCounter.findOne({ coupon: coupon._id, user: userId });
    if (session) counterQuery = counterQuery.session(session);
    const counter = await counterQuery.lean();
    if (coupon.perCustomerUsageLimit
      && Number(counter?.redeemedCount || 0) + Number(counter?.reservedCount || 0) >= coupon.perCustomerUsageLimit) {
      throw new CouponError('Coupon usage limit reached for this account', 'COUPON_CUSTOMER_LIMIT', 409);
    }
    if (coupon.firstOrderOnly) {
      let orderQuery = Order.exists({
        user: userId,
        paymentStatus: { $in: ['Paid', 'Refund Pending', 'Partially Refunded', 'Refunded'] },
      });
      if (session) orderQuery = orderQuery.session(session);
      if (await orderQuery) throw new CouponError('Coupon is only valid on a first order', 'COUPON_FIRST_ORDER_ONLY');
    }
  }

  const authoritativeSubtotal = Number(subtotal);
  if (!Number.isFinite(authoritativeSubtotal) || authoritativeSubtotal < coupon.minOrderAmount) {
    throw new CouponError('Minimum order amount not met', 'COUPON_MINIMUM_NOT_MET');
  }
  const eligibleSubtotal = calculateEligibleSubtotal(coupon, items, authoritativeSubtotal);
  if (eligibleSubtotal <= 0) throw new CouponError('Coupon does not apply to these products', 'COUPON_NOT_APPLICABLE');
  const rawDiscount = coupon.type === 'Percentage'
    ? (eligibleSubtotal * coupon.discountValue) / 100
    : coupon.discountValue;
  const discountAmount = roundMoney(Math.min(
    rawDiscount,
    coupon.maxDiscountAmount || rawDiscount,
    eligibleSubtotal,
    authoritativeSubtotal,
  ));

  return {
    coupon,
    snapshot: {
      couponId: coupon._id,
      code: coupon.code,
      type: coupon.type,
      discountValue: coupon.discountValue,
      discountAmount,
      subtotal: roundMoney(authoritativeSubtotal),
    },
  };
}

async function validateAndReserveCoupon(input) {
  const { orderId, userId, session } = input;
  if (!orderId || !userId) throw new CouponError('Order and user are required', 'COUPON_CONTEXT_REQUIRED');

  let existingQuery = CouponRedemption.findOne({ order: orderId });
  if (session) existingQuery = existingQuery.session(session);
  const existing = await existingQuery;
  if (existing) {
    if (['Reserved', 'Redeemed'].includes(existing.status)) return redemptionSnapshot(existing);
    throw new CouponError('Coupon reservation was already released', 'COUPON_RESERVATION_RELEASED', 409);
  }

  const { coupon, snapshot } = await validateCouponForCheckout(input);
  const globalFilter = { _id: coupon._id, isActive: true };
  if (coupon.usageLimit) {
    globalFilter.$expr = {
      $lt: [{ $add: [{ $ifNull: ['$usedCount', 0] }, { $ifNull: ['$reservedCount', 0] }] }, '$usageLimit'],
    };
  }
  const options = { new: true };
  if (session) options.session = session;
  const reservedCoupon = await Coupon.findOneAndUpdate(globalFilter, { $inc: { reservedCount: 1 } }, options);
  if (!reservedCoupon) throw new CouponError('Coupon usage limit reached', 'COUPON_LIMIT_REACHED', 409);

  try {
    const counter = await reserveCustomerSlot(coupon, userId, session);
    if (!counter) throw new CouponError('Coupon usage limit reached for this account', 'COUPON_CUSTOMER_LIMIT', 409);
    const docs = await CouponRedemption.create([{
      coupon: coupon._id,
      user: userId,
      order: orderId,
      code: coupon.code,
      discountAmount: snapshot.discountAmount,
      subtotal: snapshot.subtotal,
      status: 'Reserved',
      reservedUntil: input.reservedUntil,
    }], session ? { session } : undefined);
    return redemptionSnapshot(docs[0]);
  } catch (error) {
    await Promise.all([
      Coupon.updateOne(
        { _id: coupon._id, reservedCount: { $gt: 0 } },
        { $inc: { reservedCount: -1 } },
        session ? { session } : undefined,
      ),
      CouponUsageCounter.updateOne(
        { coupon: coupon._id, user: userId, reservedCount: { $gt: 0 } },
        { $inc: { reservedCount: -1 } },
        session ? { session } : undefined,
      ),
    ]);
    if (error.code === 11000) {
      let duplicateQuery = CouponRedemption.findOne({ order: orderId });
      if (session) duplicateQuery = duplicateQuery.session(session);
      const duplicate = await duplicateQuery;
      if (duplicate) return redemptionSnapshot(duplicate);
    }
    throw error;
  }
}

async function reserveCustomerSlot(coupon, userId, session) {
  await CouponUsageCounter.updateOne(
    { coupon: coupon._id, user: userId },
    { $setOnInsert: { coupon: coupon._id, user: userId, reservedCount: 0, redeemedCount: 0 } },
    { upsert: true, ...(session ? { session } : {}) },
  );
  const filter = { coupon: coupon._id, user: userId };
  if (coupon.perCustomerUsageLimit) {
    filter.$expr = {
      $lt: [{ $add: [{ $ifNull: ['$redeemedCount', 0] }, { $ifNull: ['$reservedCount', 0] }] }, coupon.perCustomerUsageLimit],
    };
  }
  const options = { new: true };
  if (session) options.session = session;
  return CouponUsageCounter.findOneAndUpdate(filter, { $inc: { reservedCount: 1 } }, options);
}

async function redeemCouponReservation({ orderId, session }) {
  const options = { new: false };
  if (session) options.session = session;
  const reservation = await CouponRedemption.findOneAndUpdate(
    { order: orderId, status: 'Reserved' },
    { $set: { status: 'Redeemed', redeemedAt: new Date() } },
    options,
  );
  if (!reservation) {
    let existingQuery = CouponRedemption.findOne({ order: orderId });
    if (session) existingQuery = existingQuery.session(session);
    const existing = await existingQuery;
    return existing ? redemptionSnapshot(existing) : null;
  }
  await Promise.all([
    Coupon.updateOne(
      { _id: reservation.coupon, reservedCount: { $gt: 0 } },
      { $inc: { reservedCount: -1, usedCount: 1 } },
      session ? { session } : undefined,
    ),
    CouponUsageCounter.updateOne(
      { coupon: reservation.coupon, user: reservation.user, reservedCount: { $gt: 0 } },
      { $inc: { reservedCount: -1, redeemedCount: 1 } },
      session ? { session } : undefined,
    ),
  ]);
  return { ...redemptionSnapshot(reservation), status: 'Redeemed' };
}

async function releaseCouponReservation({ orderId, reason = 'Order not completed', session, reverseRedeemed = false }) {
  const allowedStatuses = reverseRedeemed ? ['Reserved', 'Redeemed'] : ['Reserved'];
  const nextStatus = reverseRedeemed ? 'Reversed' : 'Released';
  const options = { new: false };
  if (session) options.session = session;
  const reservation = await CouponRedemption.findOneAndUpdate(
    { order: orderId, status: { $in: allowedStatuses } },
    { $set: { status: nextStatus, releasedAt: new Date(), releaseReason: String(reason).slice(0, 200) } },
    options,
  );
  if (!reservation) return null;
  const wasRedeemed = reservation.status === 'Redeemed';
  await Promise.all([
    Coupon.updateOne(
      { _id: reservation.coupon },
      { $inc: wasRedeemed ? { usedCount: -1 } : { reservedCount: -1 } },
      session ? { session } : undefined,
    ),
    CouponUsageCounter.updateOne(
      { coupon: reservation.coupon, user: reservation.user },
      { $inc: wasRedeemed ? { redeemedCount: -1 } : { reservedCount: -1 } },
      session ? { session } : undefined,
    ),
  ]);
  return { ...redemptionSnapshot(reservation), status: nextStatus };
}

function calculateEligibleSubtotal(coupon, items, fallbackSubtotal) {
  if (!Array.isArray(items) || !items.length) return fallbackSubtotal;
  const includedProducts = new Set((coupon.applicableProducts || []).map(String));
  const includedCategories = new Set((coupon.applicableCategories || []).map(String));
  const excludedProducts = new Set((coupon.excludedProducts || []).map(String));
  const scoped = includedProducts.size > 0 || includedCategories.size > 0;
  return roundMoney(items.reduce((sum, item) => {
    const productId = String(item.productId || item.product?._id || item.product || '');
    const categoryId = String(item.categoryId || item.product?.category?._id || item.product?.category || '');
    if (excludedProducts.has(productId)) return sum;
    if (scoped && !includedProducts.has(productId) && !includedCategories.has(categoryId)) return sum;
    return sum + Number(item.unitPrice || item.price || 0) * Number(item.quantity || 0);
  }, 0));
}

function redemptionSnapshot(redemption) {
  return {
    couponId: redemption.coupon,
    code: redemption.code,
    discountAmount: Number(redemption.discountAmount || 0),
    subtotal: Number(redemption.subtotal || 0),
    status: redemption.status,
  };
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

module.exports = {
  CouponError,
  releaseCouponReservation,
  redeemCouponReservation,
  validateAndReserveCoupon,
  validateCouponForCheckout,
};
