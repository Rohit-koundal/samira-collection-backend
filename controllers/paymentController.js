const crypto = require('crypto');
const Order = require('../models/Order');
const PaymentWebhookEvent = require('../models/PaymentWebhookEvent');
const {
  createRazorpayOrder,
  fetchRazorpayPayment,
  isRazorpayConfigured,
} = require('../services/razorpayService');
const {
  beginPaymentProcessing,
  finalizePaidOrder,
  markPaymentFailed,
  applyRefundWebhook,
  refundUnfulfillablePayment,
} = require('../services/paymentService');
const {
  getReservationExpiry,
  releaseInventory,
  reserveInventory,
} = require('../services/inventoryService');
const {
  releaseCouponReservation,
  validateAndReserveCoupon,
} = require('../services/couponService');
const {
  applyReservedCoupon,
  prepareCheckout,
} = require('../services/checkoutService');
const {
  buildCheckoutSnapshotHash,
  pickOrderFields,
  validateRazorpayPayment,
  verifyRazorpaySignature,
  verifyWebhookSignature,
} = require('../utils/paymentUtils');

function assertCheckoutReady(req) {
  if (!req.user?.isPhoneVerified) {
    const error = new Error('Please verify your mobile number to continue checkout.');
    error.statusCode = 403;
    error.code = 'PHONE_VERIFICATION_REQUIRED';
    throw error;
  }
}

async function createPaymentOrder(req, res) {
  assertCheckoutReady(req);
  if (!isRazorpayConfigured()) {
    return res.status(503).json({ message: 'Online payments are temporarily unavailable', code: 'RAZORPAY_NOT_CONFIGURED' });
  }

  const orderFields = pickOrderFields(req.body);
  const couponCode = orderFields.coupon?.code;
  const checkout = await prepareCheckout(req.body.orderItems, couponCode, {
    userId: req.user._id,
    paymentMethod: orderFields.paymentMethod,
  });
  const snapshotHash = buildCheckoutSnapshotHash({
    userId: req.user._id,
    orderItems: checkout.items,
    shippingAddress: orderFields.shippingAddress,
    paymentMethod: orderFields.paymentMethod,
    couponCode,
  });
  const idempotencyKey = normalizeIdempotencyKey(req.get('Idempotency-Key'));
  if (idempotencyKey) {
    const existing = await Order.findOne({ user: req.user._id, idempotencyKey });
    if (existing) return respondToIdempotentCreate(existing, snapshotHash, res);
  }

  const reservationExpiresAt = getReservationExpiry();
  let order;
  try {
    order = await Order.create({
      ...orderFields,
      orderItems: checkout.items,
      user: req.user._id,
      paymentProvider: 'Razorpay',
      paymentStatus: 'Pending',
      orderStatus: 'Pending',
      inventoryStatus: 'Not Reserved',
      reservationExpiresAt,
      checkoutSnapshotHash: snapshotHash,
      idempotencyKey,
      currency: 'INR',
      expectedAmount: Math.round(checkout.totals.finalAmount * 100),
      ...checkout.totals,
      statusTimeline: [{ status: 'Pending', date: new Date(), note: 'Awaiting Razorpay payment' }],
      paymentAudit: [{ action: 'CHECKOUT_CREATED', status: 'Pending', at: new Date() }],
    });
  } catch (error) {
    if (error.code === 11000 && idempotencyKey) {
      const existing = await Order.findOne({ user: req.user._id, idempotencyKey });
      if (existing) return respondToIdempotentCreate(existing, snapshotHash, res);
    }
    throw error;
  }

  try {
    if (couponCode) {
      const reservation = await validateAndReserveCoupon({
        code: couponCode,
        userId: req.user._id,
        orderId: order._id,
        items: checkout.couponItems,
        subtotal: checkout.sellingTotal,
        paymentMethod: orderFields.paymentMethod,
        reservedUntil: reservationExpiresAt,
      });
      const authoritativeTotals = applyReservedCoupon(checkout.totals, checkout.sellingTotal, reservation);
      Object.assign(order, authoritativeTotals, {
        expectedAmount: Math.round(authoritativeTotals.finalAmount * 100),
      });
      await order.save();
    }
    if (!Number.isSafeInteger(order.expectedAmount) || order.expectedAmount < 100) {
      const error = new Error('Order amount must be at least Rs. 1 for online payment');
      error.statusCode = 400;
      error.code = 'INVALID_PAYMENT_AMOUNT';
      throw error;
    }

    order = await reserveInventory(order, req.user._id);
    const razorpayOrder = await createRazorpayOrder({
      amountInPaise: order.expectedAmount,
      receipt: `sc_${String(order._id)}`,
      notes: {
        internalOrderId: String(order._id),
        userId: String(req.user._id),
      },
    });
    if (Number(razorpayOrder.amount) !== Number(order.expectedAmount)
      || String(razorpayOrder.currency || '').toUpperCase() !== order.currency) {
      const error = new Error('Payment provider returned an inconsistent checkout');
      error.statusCode = 502;
      error.code = 'RAZORPAY_ORDER_MISMATCH';
      throw error;
    }
    order = await Order.findOneAndUpdate(
      {
        _id: order._id,
        paymentStatus: 'Pending',
        inventoryStatus: 'Reserved',
        reservationExpiresAt: { $gt: new Date() },
        razorpayOrderId: { $exists: false },
      },
      {
        $set: { razorpayOrderId: razorpayOrder.id },
        $push: {
          paymentAudit: {
            action: 'RAZORPAY_ORDER_CREATED',
            referenceId: razorpayOrder.id,
            amount: order.expectedAmount,
            status: 'Pending',
            at: new Date(),
          },
        },
      },
      { new: true },
    );
    if (!order) throw checkoutConflict('Checkout state changed before provider order could be saved');
    return respondWithCheckout(order, razorpayOrder, res);
  } catch (error) {
    await failCheckoutCreation(order, req.user._id, error.code || 'CHECKOUT_CREATION_FAILED');
    throw error;
  }
}

async function verifyPayment(req, res) {
  assertCheckoutReady(req);
  assertOnlyFields(req.body, [
    'razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature',
    'order_id', 'payment_id', 'signature',
  ]);
  const razorpayOrderId = req.body.razorpay_order_id || req.body.order_id;
  const razorpayPaymentId = req.body.razorpay_payment_id || req.body.payment_id;
  const razorpaySignature = req.body.razorpay_signature || req.body.signature;
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ message: 'Missing payment verification fields', code: 'PAYMENT_FIELDS_REQUIRED' });
  }
  if (!process.env.RAZORPAY_KEY_SECRET) {
    return res.status(503).json({ message: 'Online payments are temporarily unavailable', code: 'RAZORPAY_NOT_CONFIGURED' });
  }
  if (!verifyRazorpaySignature({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
    secret: process.env.RAZORPAY_KEY_SECRET,
  })) {
    return res.status(400).json({ message: 'Payment verification failed', code: 'INVALID_PAYMENT_SIGNATURE' });
  }

  const order = await Order.findOne(ownedCheckoutQuery(req.user._id, razorpayOrderId));
  if (!order) return res.status(404).json({ message: 'Pending checkout not found', code: 'CHECKOUT_NOT_FOUND' });
  if (order.paymentStatus === 'Paid') {
    if (String(order.razorpayPaymentId) !== String(razorpayPaymentId)) {
      return res.status(409).json({ message: 'Order is already paid with another payment', code: 'ORDER_ALREADY_PAID' });
    }
    return res.json({ success: true, idempotent: true, order });
  }

  const providerPayment = await fetchRazorpayPayment(razorpayPaymentId);
  validateRazorpayPayment(providerPayment, order);
  let processing;
  try {
    processing = await beginPaymentProcessing(order, razorpayPaymentId);
  } catch (error) {
    const latest = error.code === 'CHECKOUT_NOT_PAYABLE' ? await Order.findById(order._id) : order;
    if (error.code === 'CHECKOUT_NOT_PAYABLE'
      && ['Released', 'Restored'].includes(latest?.inventoryStatus)) {
      await refundUnfulfillablePayment(latest, providerPayment);
      return res.status(409).json({
        success: false,
        refunded: true,
        message: 'The stock reservation expired before payment completed; a refund has been initiated',
        code: 'PAYMENT_REFUNDED_AFTER_EXPIRY',
      });
    }
    throw error;
  }
  if (processing.idempotent) return res.json({ success: true, idempotent: true, order: processing.order });
  try {
    const paidOrder = await finalizePaidOrder(processing.order, providerPayment, {
      actor: req.user._id,
    });
    return res.json({ success: true, order: paidOrder });
  } catch (error) {
    if (processing.inProgress && error.code === 'INVENTORY_CONFLICT') {
      return res.status(202).json({ success: false, processing: true, message: 'Payment is still being finalized' });
    }
    throw error;
  }
}

async function recordPaymentFailure(req, res) {
  assertCheckoutReady(req);
  assertOnlyFields(req.body, ['razorpayOrderId', 'razorpay_order_id', 'reason', 'reasonCode']);
  const razorpayOrderId = req.body.razorpayOrderId || req.body.razorpay_order_id;
  if (!razorpayOrderId) {
    return res.status(400).json({ message: 'Razorpay order ID is required', code: 'CHECKOUT_ID_REQUIRED' });
  }
  const order = await Order.findOne(ownedCheckoutQuery(req.user._id, razorpayOrderId));
  if (!order) return res.status(404).json({ message: 'Pending checkout not found', code: 'CHECKOUT_NOT_FOUND' });
  if (order.paymentStatus === 'Paid') {
    return res.status(409).json({ success: false, message: 'Order is already paid', code: 'ORDER_ALREADY_PAID', order });
  }
  const reason = clientFailureReason(req.body.reasonCode || req.body.reason);
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: 'Pending' },
    {
      $set: { paymentFailureReason: reason },
      $push: {
        paymentAudit: {
          action: 'CLIENT_REPORTED_PAYMENT_FAILURE',
          status: 'Pending',
          at: new Date(),
          note: reason,
        },
      },
    },
    { new: true },
  ) || order;
  return res.status(202).json({
    success: false,
    retryAllowed: true,
    message: 'Payment was not completed. You may retry until the reservation expires.',
    order: updated,
  });
}

async function handleWebhook(req, res) {
  const rawBody = req.body;
  const signature = req.get('x-razorpay-signature');
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ message: 'Webhook processing is not configured' });
  }
  if (!verifyWebhookSignature({ rawBody, signature, secret })) {
    return res.status(401).json({ message: 'Invalid webhook signature' });
  }
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    return res.status(400).json({ message: 'Invalid webhook payload' });
  }
  const eventType = String(payload.event || '');
  if (!eventType) return res.status(400).json({ message: 'Webhook event type is required' });
  const eventId = normalizeWebhookEventId(req.get('x-razorpay-event-id'), rawBody);
  const claim = await claimWebhookEvent(eventId, eventType);
  if (claim.duplicate) return res.json({ received: true, duplicate: true });
  if (claim.inProgress) return res.status(202).json({ received: true, processing: true });

  try {
    const result = await processWebhookEvent(eventType, payload, eventId);
    await PaymentWebhookEvent.updateOne(
      { eventId },
      {
        $set: {
          status: 'Processed',
          processedAt: new Date(),
          order: result?.orderId,
          providerOrderId: result?.providerOrderId,
          providerPaymentId: result?.providerPaymentId,
          providerRefundId: result?.providerRefundId,
          lastErrorCode: null,
        },
      },
    );
    return res.json({ received: true, ignored: Boolean(result?.ignored) });
  } catch (error) {
    await PaymentWebhookEvent.updateOne(
      { eventId },
      { $set: { status: 'Failed', lastErrorCode: error.code || 'WEBHOOK_PROCESSING_FAILED' } },
    );
    throw error;
  }
}

async function processWebhookEvent(eventType, payload, eventId) {
  if (['payment.captured', 'order.paid'].includes(eventType)) {
    let payment = payload.payload?.payment?.entity;
    const providerOrderId = payment?.order_id || payload.payload?.order?.entity?.id;
    if (!providerOrderId) return { ignored: true };
    const order = await Order.findOne({ razorpayOrderId: providerOrderId });
    if (!order) return { ignored: true, providerOrderId };
    if (!payment?.id) return { ignored: true, orderId: order._id, providerOrderId };
    if (String(payment.status).toLowerCase() !== 'captured') {
      payment = await fetchRazorpayPayment(payment.id);
    }
    validateRazorpayPayment(payment, order);
    if (order.paymentStatus !== 'Paid') {
      try {
        const processing = await beginPaymentProcessing(order, payment.id);
        await finalizePaidOrder(processing.order, payment, { eventId });
      } catch (error) {
        const latest = error.code === 'CHECKOUT_NOT_PAYABLE' ? await Order.findById(order._id) : order;
        if (error.code === 'CHECKOUT_NOT_PAYABLE'
          && ['Released', 'Restored'].includes(latest?.inventoryStatus)) {
          await refundUnfulfillablePayment(latest, payment, { eventId });
        } else {
          throw error;
        }
      }
    } else if (String(order.razorpayPaymentId) !== String(payment.id)) {
      throw checkoutConflict('Webhook payment conflicts with the paid order');
    }
    return {
      orderId: order._id,
      providerOrderId,
      providerPaymentId: payment.id,
    };
  }

  if (eventType === 'payment.failed') {
    const payment = payload.payload?.payment?.entity;
    if (!payment?.order_id) return { ignored: true };
    const order = await Order.findOne({ razorpayOrderId: payment.order_id });
    if (!order) return { ignored: true, providerOrderId: payment.order_id };
    await markPaymentFailed(order, {
      reason: 'Payment failed at Razorpay',
      paymentId: payment.id,
      eventId,
    });
    return {
      orderId: order._id,
      providerOrderId: payment.order_id,
      providerPaymentId: payment.id,
    };
  }

  if (['refund.processed', 'refund.failed', 'refund.created'].includes(eventType)) {
    const refund = payload.payload?.refund?.entity;
    const order = await applyRefundWebhook(refund, eventId);
    return {
      ignored: !order,
      orderId: order?._id,
      providerPaymentId: refund?.payment_id,
      providerRefundId: refund?.id,
    };
  }
  return { ignored: true };
}

async function claimWebhookEvent(eventId, eventType) {
  try {
    const event = await PaymentWebhookEvent.create({ eventId, eventType, status: 'Processing' });
    return { event };
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await PaymentWebhookEvent.findOne({ eventId });
    if (existing?.status === 'Processed') return { duplicate: true };
    if (existing?.status === 'Processing'
      && Date.now() - new Date(existing.updatedAt).getTime() < 5 * 60 * 1000) {
      return { inProgress: true };
    }
    const reclaimed = await PaymentWebhookEvent.findOneAndUpdate(
      { eventId, status: { $in: ['Failed', 'Processing'] } },
      {
        $set: { status: 'Processing', eventType, lastErrorCode: null },
        $inc: { attempts: 1 },
      },
      { new: true },
    );
    return { event: reclaimed };
  }
}

async function failCheckoutCreation(order, actor, reason) {
  if (!order) return;
  try {
    const current = await Order.findById(order._id);
    if (current?.inventoryStatus === 'Reserved') {
      await releaseInventory(current, actor, reason);
    }
    await releaseCouponReservation({ orderId: order._id, reason });
    await Order.updateOne(
      { _id: order._id, paymentStatus: 'Pending' },
      {
        $set: {
          paymentStatus: 'Failed',
          orderStatus: 'Cancelled',
          paymentFailureReason: reason,
          reservationExpiresAt: null,
        },
        $push: {
          statusTimeline: {
            status: 'Cancelled',
            date: new Date(),
            note: 'Checkout could not be created; reservations were released',
          },
        },
      },
    );
  } catch (cleanupError) {
    console.error('Checkout cleanup failed', {
      orderId: String(order._id),
      code: cleanupError.code || 'CHECKOUT_CLEANUP_FAILED',
    });
  }
}

function respondToIdempotentCreate(existing, snapshotHash, res) {
  if (existing.checkoutSnapshotHash !== snapshotHash) {
    return res.status(409).json({
      message: 'Idempotency key was already used for a different checkout',
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  }
  if (!existing.razorpayOrderId) {
    return res.status(409).json({ message: 'Checkout is still being created', code: 'CHECKOUT_IN_PROGRESS' });
  }
  if (existing.paymentStatus === 'Paid') {
    return res.json({
      success: true,
      alreadyPaid: true,
      orderId: existing._id,
      order: existing,
      idempotent: true,
    });
  }
  if (existing.paymentStatus === 'Processing') {
    return res.status(409).json({ message: 'Payment is still being finalized', code: 'PAYMENT_PROCESSING' });
  }
  if (existing.paymentStatus !== 'Pending') {
    return res.status(409).json({ message: 'This checkout can no longer be retried', code: 'CHECKOUT_NOT_PAYABLE' });
  }
  return respondWithCheckout(existing, {
    id: existing.razorpayOrderId,
    amount: existing.expectedAmount,
    currency: existing.currency,
  }, res, true);
}

function respondWithCheckout(order, razorpayOrder, res, idempotent = false) {
  return res.json({
    orderId: order._id,
    order_id: razorpayOrder.id,
    razorpayOrderId: razorpayOrder.id,
    amount: Number(razorpayOrder.amount),
    currency: razorpayOrder.currency,
    keyId: process.env.RAZORPAY_KEY_ID,
    items: order.orderItems,
    totals: {
      totalMRP: order.totalMRP,
      productDiscount: order.productDiscount,
      couponDiscount: order.couponDiscount,
      discount: order.discount,
      deliveryCharge: order.deliveryCharge,
      codCharge: order.codCharge,
      taxAmount: order.taxAmount,
      finalAmount: order.finalAmount,
    },
    reservationExpiresAt: order.reservationExpiresAt,
    idempotent,
  });
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const key = String(value).trim();
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(key)) {
    const error = new Error('Idempotency-Key must be 8-128 safe characters');
    error.statusCode = 400;
    error.code = 'INVALID_IDEMPOTENCY_KEY';
    throw error;
  }
  return key;
}

function normalizeWebhookEventId(headerValue, rawBody) {
  const supplied = String(headerValue || '').trim();
  if (supplied && /^[A-Za-z0-9:_-]{6,200}$/.test(supplied)) return supplied;
  return `sha256:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
}

function assertOnlyFields(body, allowedFields) {
  const allowed = new Set(allowedFields);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((field) => !allowed.has(field))) {
    const error = new Error('Payment request contains unsupported fields');
    error.statusCode = 400;
    error.code = 'UNSUPPORTED_PAYMENT_FIELDS';
    throw error;
  }
}

function clientFailureReason(value) {
  const reasons = {
    cancelled: 'Customer closed the payment window',
    timeout: 'Payment window timed out',
    declined: 'Payment was declined',
    network: 'Payment could not complete due to a network error',
  };
  return reasons[String(value || '').toLowerCase()] || 'Customer reported that payment did not complete';
}

function checkoutConflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'CHECKOUT_CONFLICT';
  return error;
}

function ownedCheckoutQuery(userId, razorpayOrderId) {
  return { razorpayOrderId, user: userId };
}

module.exports = {
  assertOnlyFields,
  claimWebhookEvent,
  createPaymentOrder,
  handleWebhook,
  normalizeWebhookEventId,
  ownedCheckoutQuery,
  processWebhookEvent,
  recordPaymentFailure,
  verifyPayment,
};
