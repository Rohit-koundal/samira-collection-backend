const Order = require('../models/Order');
const orderController = require('./orderController');
const { createRazorpayOrder, isRazorpayConfigured } = require('../services/razorpayService');
const { pickOrderFields, verifyRazorpaySignature } = require('../utils/paymentUtils');
const { incrementCouponUsage } = require('../utils/couponUtils');

function assertCheckoutReady(req) {
  if (!req.user?.isPhoneVerified) {
    const error = new Error('Please verify your mobile number to continue checkout.');
    error.statusCode = 403;
    throw error;
  }
}

async function createPaymentOrder(req, res) {
  assertCheckoutReady(req);

  if (!isRazorpayConfigured()) {
    return res.status(503).json({ message: 'Razorpay is not configured. Use COD or add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.' });
  }

  const orderFields = pickOrderFields(req.body);
  const { items, totals } = await orderController.prepareOrder(req.body.orderItems, req.body.coupon?.code);
  const amountInPaise = Math.round(totals.finalAmount * 100);

  if (amountInPaise < 100) {
    return res.status(400).json({ message: 'Order amount must be at least Rs. 1 for online payment.' });
  }

  const razorpayOrder = await createRazorpayOrder({
    amountInPaise,
    receipt: `samira_${Date.now()}`,
    notes: {
      userId: String(req.user._id),
      paymentMethod: orderFields.paymentMethod || 'UPI',
    },
  });

  const order = await Order.create({
    ...orderFields,
    orderItems: items,
    user: req.user._id,
    paymentMethod: orderFields.paymentMethod || 'UPI',
    paymentProvider: 'Razorpay',
    paymentStatus: 'Pending',
    orderStatus: 'Pending',
    razorpayOrderId: razorpayOrder.id,
    ...totals,
    statusTimeline: [{ status: 'Pending', date: new Date(), note: 'Awaiting Razorpay payment' }],
  });

  return res.json({
    orderId: order._id,
    order_id: razorpayOrder.id,
    razorpayOrderId: razorpayOrder.id,
    amount: razorpayOrder.amount,
    currency: razorpayOrder.currency,
    keyId: process.env.RAZORPAY_KEY_ID,
  });
}

async function verifyPayment(req, res) {
  assertCheckoutReady(req);

  const razorpay_order_id = req.body.razorpay_order_id || req.body.order_id;
  const razorpay_payment_id = req.body.razorpay_payment_id || req.body.payment_id;
  const razorpay_signature = req.body.razorpay_signature || req.body.signature;
  const { orderPayload } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ message: 'Missing payment verification fields' });
  }

  const secret = process.env.RAZORPAY_KEY_SECRET;

  if (!secret) return res.status(503).json({ message: 'Razorpay is not configured' });
  if (!verifyRazorpaySignature({
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
    razorpaySignature: razorpay_signature,
    secret,
  })) {
    return res.status(400).json({ message: 'Payment verification failed' });
  }

  if (!orderPayload?.orderItems?.length) {
    return res.status(400).json({ message: 'Order payload is required for verification' });
  }

  const { items, totals } = await orderController.prepareOrder(orderPayload.orderItems, orderPayload.coupon?.code);
  let order = await Order.findOne({ razorpayOrderId: razorpay_order_id, user: req.user._id });

  if (order) {
    if (order.paymentStatus === 'Paid') {
      return res.json({ success: true, order });
    }

    Object.assign(order, pickOrderFields(orderPayload), totals, {
      orderItems: items,
      paymentMethod: orderPayload.paymentMethod || order.paymentMethod || 'UPI',
      paymentProvider: 'Razorpay',
      paymentStatus: 'Paid',
      orderStatus: 'Confirmed',
      razorpayPaymentId: razorpay_payment_id,
      paymentFailureReason: undefined,
    });
    order.statusTimeline.push({ status: 'Confirmed', date: new Date(), note: 'Payment verified and order placed' });
    await order.save();
    await orderController.reduceStock(items);
    await incrementCouponUsage(order.coupon?.code);
    return res.json({ success: true, order });
  }

  order = await Order.create({
    ...pickOrderFields(orderPayload),
    orderItems: items,
    user: req.user._id,
    paymentMethod: orderPayload.paymentMethod || 'UPI',
    paymentProvider: 'Razorpay',
    paymentStatus: 'Paid',
    orderStatus: 'Confirmed',
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
    ...totals,
    statusTimeline: [{ status: 'Confirmed', date: new Date(), note: 'Payment verified and order placed' }],
  });
  await orderController.reduceStock(items);
  await incrementCouponUsage(order.coupon?.code);
  return res.json({ success: true, order });
}

async function recordPaymentFailure(req, res) {
  assertCheckoutReady(req);

  const reason = String(req.body.reason || 'Payment failed. Please retry or choose COD.').trim();
  const orderPayload = req.body.orderPayload || req.body;
  const razorpayOrderId = req.body.razorpayOrderId || req.body.razorpay_order_id;

  let order = null;
  if (razorpayOrderId) {
    order = await Order.findOne({ razorpayOrderId, user: req.user._id });
  }

  if (order) {
    if (order.paymentStatus === 'Paid') {
      return res.status(409).json({ success: false, message: 'Order is already paid', order });
    }

    order.paymentStatus = 'Failed';
    order.orderStatus = 'Cancelled';
    order.paymentFailureReason = reason;
    order.statusTimeline.push({ status: 'Cancelled', date: new Date(), note: reason });
    await order.save();
    return res.status(202).json({ success: false, message: reason, order });
  }

  const { items, totals } = await orderController.prepareOrder(orderPayload.orderItems, orderPayload.coupon?.code);
  order = await Order.create({
    ...pickOrderFields(orderPayload),
    orderItems: items,
    user: req.user._id,
    paymentMethod: orderPayload.paymentMethod || 'UPI',
    paymentProvider: 'Razorpay',
    paymentStatus: 'Failed',
    orderStatus: 'Cancelled',
    paymentFailureReason: reason,
    razorpayOrderId: razorpayOrderId || undefined,
    ...totals,
    statusTimeline: [
      { status: 'Pending', date: new Date(), note: 'Checkout started' },
      { status: 'Cancelled', date: new Date(), note: reason },
    ],
  });

  return res.status(202).json({ success: false, message: reason, order });
}

module.exports = {
  createPaymentOrder,
  verifyPayment,
  recordPaymentFailure,
};
