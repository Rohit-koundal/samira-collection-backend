const crypto = require('crypto');
const { logAudit } = require('../services/auditService');
const Order = require('../models/Order');
const InventoryTransaction = require('../models/InventoryTransaction');
const couponService = require('../services/couponService');
const inventoryService = require('../services/inventoryService');
const { buildOrderDraft } = require('../services/orderPricingService');
const { createRazorpayOrder, isRazorpayConfigured } = require('../services/razorpayService');
const { verifyRazorpaySignature } = require('../utils/paymentUtils');
const { runInTransaction } = require('../utils/transaction');
const { ApiError, notFound } = require('../utils/apiError');
const { assertCheckoutReady, assertShippingAddress, cancelOrderInternal } = require('./orderController');
const { buildPersistedOrderFields } = require('../services/orderSnapshotService');
const { notifyLater } = require('../services/notificationService');
const { readAttribution } = require('../utils/attribution');
const { recordEventLater } = require('../services/analyticsService');

/**
 * Razorpay flow.
 *
 * The priced order is written to the database *before* the customer is sent
 * to Razorpay. Verification then compares the gateway response against that
 * stored snapshot, so the browser never gets to restate items or amounts
 * after a successful payment.
 */

function amountToPaise(amount) {
  return Math.round(Number(amount || 0) * 100);
}

/**
 * Finalises a pending order exactly once.
 *
 * Both the customer callback and the webhook call this. The conditional
 * update on `paymentStatus` is the guard: whoever gets there first flips the
 * order to Paid, everyone else sees an already-paid order and stops.
 */
async function finalizePaidOrder(orderId, { razorpayPaymentId, note, req, source = 'SYSTEM' }) {
  return runInTransaction(async (session) => {
    const claimed = await Order.findOneAndUpdate(
      { _id: orderId, paymentStatus: { $ne: 'Paid' } },
      {
        $set: {
          paymentStatus: 'Paid',
          paymentState: 'PAID',
          orderStatus: 'Confirmed',
          razorpayPaymentId,
          paymentFailureReason: undefined,
        },
        $push: { statusTimeline: { status: 'Confirmed', date: new Date(), note } },
      },
      { new: true, session },
    );

    if (!claimed) {
      return { order: await Order.findById(orderId).session(session || null), alreadyPaid: true };
    }

    const deductionClaim = await inventoryService.claimInventoryDeduction(Order, claimed._id, session);
    if (deductionClaim) {
      // The customer has already paid, so a stock shortfall must not fail the
      // request. Take what is available and flag the gap for the admin.
      const applied = await inventoryService.deductStockForOrder(deductionClaim.orderItems, {
        orderId: claimed._id,
        userId: claimed.user,
        reason: 'Online payment captured',
        session,
        allowShortfall: true,
      });

      const shortfall = applied.reduce((sum, entry) => sum + (entry.shortfall || 0), 0);
      if (shortfall > 0) {
        await Order.updateOne({ _id: claimed._id }, {
          $push: {
            statusTimeline: {
              status: 'Confirmed',
              date: new Date(),
              note: `Paid, but ${shortfall} unit(s) were no longer in stock. Needs manual review.`,
            },
          },
        }, session ? { session } : {});
      }
    }

    const couponClaim = await Order.findOneAndUpdate(
      {
        _id: claimed._id,
        'coupon.code': { $exists: true, $ne: null },
        $or: [
          { couponConsumed: { $ne: true } },
          { couponReleased: true },
        ],
      },
      { $set: { couponConsumed: true, couponReleased: false } },
      { new: true, session },
    );
    if (couponClaim?.coupon?.code) {
      await couponService.consumeCoupon(couponClaim.coupon.code, { session });
    }

    const paid = await Order.findById(claimed._id).session(session || null);
    return { order: paid, alreadyPaid: false };
  }).then((result) => {
    if (result.order && !result.alreadyPaid) notifyPaid(result.order);
    if (result.order && !result.alreadyPaid) logAudit({ req, source, action: 'PAYMENT_CAPTURED', entityType: 'Order', entityId: result.order._id, storeId: result.order.storeId, after: { paymentStatus: result.order.paymentStatus, orderStatus: result.order.orderStatus, finalAmount: result.order.finalAmount } });
    return result;
  });
}

async function notifyPaid(order) {
  if (!order) return;
  notifyLater({
    userId: order.user,
    storeId: order.storeId,
    event: 'ORDER_CONFIRMED',
    title: 'Payment received',
    message: `Your order ${order.invoiceNumber || ''} is confirmed.`,
    metadata: { orderId: String(order._id) },
  });
}

/**
 * Step 1: price the cart server-side, persist a pending order and hand the
 * frontend only the Razorpay handles it needs to open checkout.
 */
async function createPaymentOrder(req, res) {
  assertCheckoutReady(req);

  if (!isRazorpayConfigured()) {
    throw new ApiError('SERVICE_UNAVAILABLE', 'Online payment is not available right now. Please choose Cash on Delivery.');
  }

  const shippingAddress = assertShippingAddress(req.body?.shippingAddress);
  const draft = await buildOrderDraft({
    orderItems: req.body?.orderItems,
    couponCode: req.body?.coupon?.code,
    paymentMethod: req.body?.paymentMethod || 'UPI',
    userId: req.user?._id,
    shippingAddress,
    tenantFilter: req.tenantFilter,
  });

  const amountInPaise = amountToPaise(draft.totals.finalAmount);
  if (amountInPaise < 100) {
    throw new ApiError('VALIDATION_ERROR', 'Order amount must be at least Rs. 1 for online payment.');
  }

  const razorpayOrder = await createRazorpayOrder({
    amountInPaise,
    receipt: `samira_${Date.now()}`,
    notes: { userId: String(req.user._id), paymentMethod: draft.paymentMethod },
  });

  const order = await runInTransaction(async (session) => {
    const [created] = await Order.create([{
      ...buildPersistedOrderFields({
        userId: req.user._id,
        draft,
        shippingAddress,
        billingAddress: req.body?.billingAddress,
        extra: {
          storeId: draft.storeId || undefined,
          attribution: readAttribution(req.body?.attribution || req.body),
          prepaidDiscount: draft.totals.prepaidDiscount || 0,
          paymentProvider: 'Razorpay',
          paymentStatus: 'Pending',
          paymentState: 'PENDING',
          orderStatus: 'Pending',
          razorpayOrderId: razorpayOrder.id,
          inventoryDeducted: true,
          inventoryDeductedAt: new Date(),
          couponConsumed: Boolean(draft.totals.coupon?.code),
          statusTimeline: [{ status: 'Pending', date: new Date(), note: 'Awaiting Razorpay payment' }],
        },
      }),
    }], session ? { session } : {});

    let stockTaken = false;
    try {
      await inventoryService.deductStockForOrder(draft.items, {
        orderId: created._id,
        userId: req.user._id,
        reason: 'Reserved for online payment',
        session,
      });
      stockTaken = true;

      if (draft.totals.coupon?.code) {
        await couponService.consumeCoupon(draft.totals.coupon.code, { session });
      }
    } catch (error) {
      if (!session) {
        if (stockTaken) {
          await inventoryService.restoreStockForOrder(draft.items, {
            orderId: created._id,
            userId: req.user._id,
            type: 'CANCELLATION',
            reason: 'Online checkout failed after stock was reserved',
          }).catch(() => null);
        }
        await Order.deleteOne({ _id: created._id }).catch(() => null);
        await InventoryTransaction.deleteMany({ order: created._id }).catch(() => null);
      }
      throw error;
    }

    return created;
  });

  logAudit({ req, action: 'PAYMENT_STARTED', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod, finalAmount: order.finalAmount } });

  recordEventLater({
    name: 'PAYMENT_STARTED',
    storeId: order.storeId,
    userId: req.user._id,
    orderId: order._id,
    source: order.attribution?.source,
    campaign: order.attribution?.campaign,
    reelId: order.attribution?.reelId,
  });

  return res.json({
    orderId: order._id,
    order_id: razorpayOrder.id,
    razorpayOrderId: razorpayOrder.id,
    amount: razorpayOrder.amount,
    currency: razorpayOrder.currency,
    keyId: process.env.RAZORPAY_KEY_ID,
    totals: draft.totals,
  });
}

/**
 * Step 2: verify the gateway signature and finalise the stored order.
 *
 * Nothing from the request body is used to price or populate the order.
 */
async function verifyPayment(req, res) {
  assertCheckoutReady(req);

  const razorpayOrderId = req.body.razorpay_order_id || req.body.order_id;
  const razorpayPaymentId = req.body.razorpay_payment_id || req.body.payment_id;
  const razorpaySignature = req.body.razorpay_signature || req.body.signature;

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw new ApiError('VALIDATION_ERROR', 'Missing payment verification fields');
  }

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) throw new ApiError('SERVICE_UNAVAILABLE', 'Razorpay is not configured');

  if (!verifyRazorpaySignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature, secret })) {
    throw new ApiError('PAYMENT_FAILED', 'Payment verification failed');
  }

  const pending = await Order.findOne({ razorpayOrderId, user: req.user._id });
  if (!pending) throw notFound('We could not find a pending order for this payment. Please contact support.');

  const { order, alreadyPaid } = await finalizePaidOrder(pending._id, {
    razorpayPaymentId,
    note: 'Payment verified and order placed', req, source: 'CUSTOMER',
  });

  recordEventLater({
    name: alreadyPaid ? 'PAYMENT_SUCCESS' : 'PURCHASE',
    storeId: order.storeId,
    userId: req.user._id,
    orderId: order._id,
    source: order.attribution?.source,
    campaign: order.attribution?.campaign,
    reelId: order.attribution?.reelId,
  });
  if (!alreadyPaid) {
    recordEventLater({
      name: 'PAYMENT_SUCCESS',
      storeId: order.storeId,
      userId: req.user._id,
      orderId: order._id,
    });
  }

  return res.json({ success: true, alreadyPaid, order });
}

/**
 * Razorpay webhook. Recovers payments where the browser never came back.
 *
 * Requires the raw request body for signature verification, mounted with
 * express.raw in app.js.
 */
async function razorpayWebhook(req, res) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ success: false, code: 'SERVICE_UNAVAILABLE', message: 'Webhook secret is not configured' });

  const signature = req.headers['x-razorpay-signature'];
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const signatureBuffer = Buffer.from(String(signature || ''));
  const expectedBuffer = Buffer.from(expected);
  const signatureValid = signatureBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

  if (!signatureValid) {
    return res.status(400).json({ success: false, code: 'UNAUTHORIZED', message: 'Invalid webhook signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid webhook payload' });
  }

  const event = String(payload.event || '');
  const paymentEntity = payload.payload?.payment?.entity;
  const refundEntity = payload.payload?.refund?.entity;
  const razorpayOrderId = paymentEntity?.order_id || payload.payload?.order?.entity?.id || refundEntity?.notes?.order_id;

  // Always acknowledge: Razorpay retries on any non-2xx, and a retry storm
  // for an event we cannot map to an order helps nobody.
  const refundPaymentId = event === 'refund.processed' ? refundEntity?.payment_id : null;
  if (!razorpayOrderId && !refundPaymentId) return res.json({ success: true, ignored: true });

  const order = await Order.findOne(razorpayOrderId ? { razorpayOrderId } : { razorpayPaymentId: refundPaymentId });
  if (!order) return res.json({ success: true, ignored: true });

  try {
    if (event === 'payment.captured' || event === 'order.paid') {
      await finalizePaidOrder(order._id, {
        razorpayPaymentId: paymentEntity?.id || order.razorpayPaymentId,
        note: 'Payment confirmed by Razorpay webhook', req, source: 'WEBHOOK',
      });
    } else if (event === 'payment.authorized') {
      const result = await Order.updateOne(
        { _id: order._id, paymentStatus: { $ne: 'Paid' } },
        { $set: { paymentState: 'AUTHORIZED' } },
      );
      if (result.modifiedCount) logAudit({ req, source: 'WEBHOOK', action: 'PAYMENT_AUTHORIZED', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { paymentState: 'AUTHORIZED' } });
    } else if (event === 'payment.failed') {
      await failUnpaidOrder(order, paymentEntity?.error_description || 'Payment failed at gateway', { req, source: 'WEBHOOK' });
    } else if (event === 'refund.processed') {
      const refunded = Number(refundEntity?.amount || 0) / 100;
      const isFullRefund = refunded >= Number(order.finalAmount || 0);
      const result = await Order.updateOne({ _id: order._id }, {
        $set: {
          paymentState: isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          ...(isFullRefund ? { paymentStatus: 'Refunded' } : {}),
        },
      });
      if (result.modifiedCount) logAudit({ req, source: 'WEBHOOK', action: 'PAYMENT_REFUND_PROCESSED', entityType: 'Order', entityId: order._id, storeId: order.storeId, before: { paymentState: order.paymentState }, after: { paymentState: isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED', refundAmount: refunded } });
      notifyLater({
        userId: order.user, storeId: order.storeId, event: 'REFUND_PROCESSED',
        title: isFullRefund ? 'Refund processed' : 'Partial refund processed',
        message: `Your refund of Rs. ${refunded.toLocaleString('en-IN')} has been processed by the payment provider. The time it takes to appear depends on your bank.`,
        metadata: { orderId: String(order._id), refundId: refundEntity?.id, amount: refunded },
      });
    }
  } catch (error) {
    console.error('Razorpay webhook processing failed:', error.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Webhook processing failed' });
  }

  return res.json({ success: true });
}

/**
 * Records an abandoned or failed attempt against the pending order.
 *
 * Stock is reserved when the Razorpay order is created, so failure must
 * restore it exactly once through the same cancellation path COD uses.
 */
async function recordPaymentFailure(req, res) {
  assertCheckoutReady(req);

  const reason = String(req.body.reason || 'Payment failed. Please retry or choose Cash on Delivery.').trim().slice(0, 300);
  const razorpayOrderId = req.body.razorpayOrderId || req.body.razorpay_order_id;

  if (!razorpayOrderId) {
    return res.status(202).json({ success: false, message: reason, order: null });
  }

  const order = await Order.findOne({ razorpayOrderId, user: req.user._id });
  if (!order) return res.status(202).json({ success: false, message: reason, order: null });

  if (order.paymentStatus === 'Paid') {
    return res.status(409).json({ success: false, code: 'DUPLICATE_REQUEST', message: 'Order is already paid', order });
  }

  const updated = await failUnpaidOrder(order, reason, { req, source: 'CUSTOMER' });
  recordEventLater({
    name: 'PAYMENT_FAILED',
    storeId: order.storeId,
    userId: req.user._id,
    orderId: order._id,
  });
  return res.status(202).json({ success: false, message: reason, order: updated || order });
}

async function failUnpaidOrder(order, reason, { req, source = 'SYSTEM' } = {}) {
  if (!order || order.paymentStatus === 'Paid') return order;

  const cancelled = order.orderStatus === 'Cancelled'
    ? order
    : await cancelOrderInternal(order, { req, source, actor: req?.user, note: reason });

  const previous = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: { $ne: 'Paid' } },
    {
      $set: {
        paymentStatus: 'Failed',
        paymentState: 'FAILED',
        paymentFailureReason: reason,
      },
    },
    { new: false },
  );
  if (!previous) return cancelled;
  if (previous.paymentStatus !== 'Failed') notifyLater({
    userId: order.user, storeId: order.storeId, event: 'PAYMENT_FAILED',
    title: 'Payment was not completed',
    message: 'Your payment attempt was unsuccessful. Open your order for details and help with any amount debited.',
    metadata: { orderId: String(order._id) },
  });
  if (previous.paymentStatus !== 'Failed') logAudit({ req, source, action: 'PAYMENT_FAILED', entityType: 'Order', entityId: order._id, storeId: order.storeId, before: { paymentStatus: previous.paymentStatus }, after: { paymentStatus: 'Failed' }, summary: source === 'CUSTOMER' ? 'Customer reported a failed or abandoned payment attempt' : 'Payment gateway reported a failed payment' });
  previous.paymentStatus = 'Failed';
  previous.paymentState = 'FAILED';
  previous.paymentFailureReason = reason;
  return previous;
}

module.exports = {
  createPaymentOrder,
  finalizePaidOrder,
  razorpayWebhook,
  recordPaymentFailure,
  verifyPayment,
};
