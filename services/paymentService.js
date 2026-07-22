const Order = require('../models/Order');
const Cart = require('../models/Cart');
const ReturnExchange = require('../models/ReturnExchange');
const {
  commitInventory,
  releaseInventory,
  restoreCommittedInventory,
} = require('./inventoryService');
const {
  redeemCouponReservation,
  releaseCouponReservation,
} = require('./couponService');
const {
  createRazorpayRefund,
  fetchRazorpayRefunds,
} = require('./razorpayService');

async function beginPaymentProcessing(order, paymentId) {
  if (order.paymentStatus === 'Paid') {
    if (String(order.razorpayPaymentId) !== String(paymentId)) {
      throw paymentConflict('Order was paid with a different payment', 'ORDER_ALREADY_PAID');
    }
    return { order, idempotent: true };
  }
  if (order.paymentStatus === 'Processing') {
    if (String(order.razorpayPaymentId) !== String(paymentId)) {
      throw paymentConflict('Another payment is already being processed', 'PAYMENT_PROCESSING');
    }
    return { order, inProgress: true };
  }
  if (order.paymentStatus !== 'Pending' || order.inventoryStatus !== 'Reserved') {
    throw paymentConflict('Checkout is no longer payable', 'CHECKOUT_NOT_PAYABLE');
  }

  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      user: order.user,
      paymentStatus: 'Pending',
      inventoryStatus: 'Reserved',
      $or: [
        { razorpayPaymentId: { $exists: false } },
        { razorpayPaymentId: null },
        { razorpayPaymentId: paymentId },
      ],
    },
    {
      $set: {
        paymentStatus: 'Processing',
        razorpayPaymentId: paymentId,
      },
      $push: {
        paymentAudit: {
          action: 'PAYMENT_PROCESSING',
          referenceId: paymentId,
          status: 'Processing',
          at: new Date(),
        },
      },
    },
    { new: true },
  );
  if (claimed) return { order: claimed };

  const current = await Order.findById(order._id);
  if (current?.paymentStatus === 'Paid' && String(current.razorpayPaymentId) === String(paymentId)) {
    return { order: current, idempotent: true };
  }
  if (current?.paymentStatus === 'Processing' && String(current.razorpayPaymentId) === String(paymentId)) {
    return { order: current, inProgress: true };
  }
  throw paymentConflict('Another payment is already being processed', 'PAYMENT_PROCESSING');
}

async function finalizePaidOrder(order, payment, { actor, eventId } = {}) {
  let current = await Order.findById(order._id);
  if (!current) throw paymentConflict('Order no longer exists', 'ORDER_NOT_FOUND', 404);
  if (current.paymentStatus === 'Paid') {
    if (String(current.razorpayPaymentId) !== String(payment.id)) {
      throw paymentConflict('Order was paid with a different payment', 'ORDER_ALREADY_PAID');
    }
    return current;
  }
  if (current.inventoryStatus === 'Reserved') {
    current = await commitInventory(current, actor || current.user);
  } else if (current.inventoryStatus !== 'Committed') {
    throw paymentConflict('Reserved stock is no longer available for this payment', 'RESERVATION_NOT_AVAILABLE');
  }

  await redeemCouponReservation({ orderId: current._id });
  const nextOrderStatus = current.orderStatus === 'Pending' ? 'Confirmed' : current.orderStatus;
  const paid = await Order.findOneAndUpdate(
    {
      _id: current._id,
      razorpayPaymentId: payment.id,
      paymentStatus: { $in: ['Pending', 'Processing'] },
      inventoryStatus: 'Committed',
    },
    {
      $set: {
        paymentStatus: 'Paid',
        orderStatus: nextOrderStatus,
        paymentProcessedAt: new Date(),
        paymentFailureReason: null,
      },
      $push: {
        statusTimeline: {
          status: nextOrderStatus,
          date: new Date(),
          note: 'Razorpay payment verified and inventory committed',
        },
        paymentAudit: {
          action: 'PAYMENT_CAPTURED',
          referenceId: eventId || payment.id,
          amount: Number(payment.amount),
          status: 'Paid',
          at: new Date(),
        },
      },
    },
    { new: true },
  );
  if (!paid) {
    const idempotent = await Order.findById(current._id);
    if (idempotent?.paymentStatus === 'Paid'
      && String(idempotent.razorpayPaymentId) === String(payment.id)) return idempotent;
    throw paymentConflict('Payment finalization conflicted with another update', 'PAYMENT_FINALIZATION_CONFLICT');
  }
  await removePurchasedCartLines(paid);
  return paid;
}

async function markPaymentFailed(order, {
  reason = 'Payment failed at provider',
  paymentId,
  eventId,
} = {}) {
  const current = await Order.findById(order._id);
  if (!current || current.paymentStatus === 'Paid') return current;
  if (current.paymentStatus === 'Processing' && current.razorpayPaymentId
    && paymentId && String(current.razorpayPaymentId) !== String(paymentId)) {
    return current;
  }
  if (current.inventoryStatus === 'Reserved') {
    await releaseInventory(current, current.user, reason);
  }
  await releaseCouponReservation({ orderId: current._id, reason });
  return Order.findOneAndUpdate(
    { _id: current._id, paymentStatus: { $in: ['Pending', 'Processing'] } },
    {
      $set: {
        paymentStatus: 'Failed',
        orderStatus: 'Cancelled',
        paymentFailureReason: String(reason).slice(0, 200),
        reservationExpiresAt: null,
      },
      $push: {
        statusTimeline: {
          status: 'Cancelled',
          date: new Date(),
          note: 'Payment failed and reserved stock was released',
        },
        paymentAudit: {
          action: 'PAYMENT_FAILED',
          referenceId: eventId || paymentId,
          status: 'Failed',
          at: new Date(),
          note: String(reason).slice(0, 200),
        },
      },
    },
    { new: true },
  );
}

async function refundUnfulfillablePayment(order, payment, { eventId } = {}) {
  const paid = await Order.findOneAndUpdate(
    {
      _id: order._id,
      paymentStatus: { $in: ['Pending', 'Failed'] },
      inventoryStatus: { $in: ['Released', 'Restored'] },
      $or: [
        { razorpayPaymentId: { $exists: false } },
        { razorpayPaymentId: null },
        { razorpayPaymentId: payment.id },
      ],
    },
    {
      $set: {
        paymentStatus: 'Paid',
        razorpayPaymentId: payment.id,
        paymentProcessedAt: new Date(),
      },
      $push: {
        paymentAudit: {
          action: 'PAYMENT_CAPTURED_AFTER_RESERVATION',
          referenceId: eventId || payment.id,
          amount: Number(payment.amount),
          status: 'Paid',
          at: new Date(),
          note: 'Captured after stock reservation expired; automatic refund required',
        },
      },
    },
    { new: true },
  );
  const current = paid || await Order.findById(order._id);
  if (String(current?.razorpayPaymentId) !== String(payment.id)) {
    throw paymentConflict('Captured payment conflicts with another payment', 'PAYMENT_CONFLICT');
  }
  return initiateRefund({
    order: current,
    reason: 'Stock reservation expired before payment capture',
    idempotencyKey: `unfulfillable:${payment.id}`,
  });
}

async function cancelOrderFinancials(order, {
  actor,
  reason = 'Order cancelled',
} = {}) {
  let current = await Order.findById(order._id);
  if (!current) throw paymentConflict('Order not found', 'ORDER_NOT_FOUND', 404);
  if (current.inventoryStatus === 'Reserved') {
    current = await releaseInventory(current, actor, reason);
  } else if (current.inventoryStatus === 'Committed') {
    current = await restoreCommittedInventory(current, actor, reason);
  }
  await releaseCouponReservation({
    orderId: current._id,
    reason,
    reverseRedeemed: true,
  });
  if (current.paymentStatus === 'Paid' && current.razorpayPaymentId) {
    return initiateRefund({
      order: current,
      actor,
      reason,
      idempotencyKey: `cancel:${String(current._id)}:full`,
    });
  }
  return { order: await Order.findById(current._id), refund: null };
}

async function initiateRefund({
  order,
  orderId,
  amountInPaise,
  actor,
  reason = 'Approved refund',
  idempotencyKey,
}) {
  let current = order || await Order.findById(orderId);
  if (!current) throw paymentConflict('Order not found', 'ORDER_NOT_FOUND', 404);
  if (!current.razorpayPaymentId || !['Paid', 'Refund Pending', 'Partially Refunded'].includes(current.paymentStatus)) {
    throw paymentConflict('Order is not eligible for a Razorpay refund', 'REFUND_NOT_ELIGIBLE');
  }
  const key = String(idempotencyKey || `refund:${String(current._id)}:full`).slice(0, 150);
  const existing = current.refunds?.find((refund) => refund.idempotencyKey === key);
  if (existing && existing.status !== 'Failed') return { order: current, refund: existing };

  const expectedAmount = Number(current.expectedAmount || Math.round(Number(current.finalAmount) * 100));
  const committedRefunds = (current.refunds || [])
    .filter((refund) => ['Initiating', 'Pending', 'Processed'].includes(refund.status) && refund.idempotencyKey !== key)
    .reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
  const remaining = expectedAmount - committedRefunds;
  const refundAmount = amountInPaise === undefined ? remaining : Number(amountInPaise);
  if (!Number.isSafeInteger(refundAmount) || refundAmount < 1 || refundAmount > remaining) {
    throw paymentConflict('Refund amount exceeds the refundable balance', 'INVALID_REFUND_AMOUNT', 400);
  }

  if (!existing) {
    const claimed = await Order.findOneAndUpdate(
      { _id: current._id, 'refunds.idempotencyKey': { $ne: key } },
      {
        $push: {
          refunds: {
            idempotencyKey: key,
            amount: refundAmount,
            currency: current.currency || 'INR',
            status: 'Initiating',
            reason: String(reason).slice(0, 200),
            initiatedBy: actor,
          },
          paymentAudit: {
            action: 'REFUND_INITIATED',
            actor,
            referenceId: key,
            amount: refundAmount,
            status: 'Initiating',
            at: new Date(),
          },
        },
        $set: { paymentStatus: 'Refund Pending' },
      },
      { new: true },
    );
    if (!claimed) {
      current = await Order.findById(current._id);
      return { order: current, refund: current.refunds.find((refund) => refund.idempotencyKey === key) };
    }
    current = claimed;
  } else {
    await Order.updateOne(
      { _id: current._id, 'refunds.idempotencyKey': key, 'refunds.status': 'Failed' },
      {
        $set: {
          'refunds.$.status': 'Initiating',
          'refunds.$.failureReason': null,
          paymentStatus: 'Refund Pending',
        },
      },
    );
  }

  try {
    const providerRefunds = await fetchRazorpayRefunds(current.razorpayPaymentId);
    let providerRefund = (providerRefunds?.items || []).find((refund) => (
      refund.notes?.internalRefundKey === key
    ));
    if (!providerRefund) {
      providerRefund = await createRazorpayRefund({
        paymentId: current.razorpayPaymentId,
        amountInPaise: refundAmount,
        receipt: `sc_${String(current._id).slice(-18)}`,
        notes: {
          internalOrderId: String(current._id),
          internalRefundKey: key,
          reason: String(reason).slice(0, 100),
        },
      });
    }
    const status = normalizeRefundStatus(providerRefund.status);
    const updated = await updateRefundRecord(current._id, key, {
      razorpayRefundId: providerRefund.id,
      status,
      ...(status === 'Processed' ? { processedAt: new Date() } : {}),
    });
    return {
      order: await reconcileOrderRefundStatus(updated),
      refund: updated.refunds.find((refund) => refund.idempotencyKey === key),
    };
  } catch (error) {
    const failedOrder = await updateRefundRecord(current._id, key, {
      status: 'Failed',
      failureReason: error.code || 'REFUND_PROVIDER_ERROR',
    });
    await Order.updateOne(
      { _id: current._id },
      {
        $push: {
          paymentAudit: {
            action: 'REFUND_FAILED',
            actor,
            referenceId: key,
            amount: refundAmount,
            status: 'Failed',
            at: new Date(),
            note: error.code || 'REFUND_PROVIDER_ERROR',
          },
        },
      },
    );
    if (failedOrder) await reconcileOrderRefundStatus(failedOrder);
    throw error;
  }
}

async function applyRefundWebhook(refundEntity, eventId) {
  if (!refundEntity?.id || !refundEntity.payment_id) return null;
  let order = await Order.findOne({ razorpayPaymentId: refundEntity.payment_id });
  if (!order) return null;
  let refund = order.refunds?.find((entry) => entry.razorpayRefundId === refundEntity.id);
  if (!refund) {
    const amount = Number(refundEntity.amount);
    if (!Number.isSafeInteger(amount) || amount < 1) return order;
    order = await Order.findOneAndUpdate(
      { _id: order._id, 'refunds.razorpayRefundId': { $ne: refundEntity.id } },
      {
        $push: {
          refunds: {
            idempotencyKey: `provider:${refundEntity.id}`,
            razorpayRefundId: refundEntity.id,
            amount,
            currency: refundEntity.currency || order.currency || 'INR',
            status: normalizeRefundStatus(refundEntity.status),
            reason: 'Provider refund reconciliation',
          },
        },
      },
      { new: true },
    ) || order;
    refund = order.refunds.find((entry) => entry.razorpayRefundId === refundEntity.id);
  }
  const status = normalizeRefundStatus(refundEntity.status);
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, 'refunds.razorpayRefundId': refundEntity.id },
    {
      $set: {
        'refunds.$.status': status,
        ...(status === 'Processed' ? { 'refunds.$.processedAt': new Date() } : {}),
      },
      $push: {
        paymentAudit: {
          action: status === 'Processed' ? 'REFUND_PROCESSED' : 'REFUND_UPDATED',
          referenceId: eventId || refundEntity.id,
          amount: Number(refundEntity.amount || refund.amount),
          status,
          at: new Date(),
        },
      },
    },
    { new: true },
  );
  const reconciledOrder = await reconcileOrderRefundStatus(updated);
  if (status === 'Processed') {
    await reconcileReturnRefund(updated, refundEntity);
  }
  return reconciledOrder;
}

async function reconcileReturnRefund(order, refundEntity, ReturnModel = ReturnExchange) {
  if (!order || !refundEntity?.id) return null;
  const refund = order.refunds?.find((entry) => entry.razorpayRefundId === refundEntity.id);
  const match = String(refund?.idempotencyKey || '').match(/^return:([a-f\d]{24}):/i);
  if (!match) return null;
  const processedAt = new Date();
  return ReturnModel.findOneAndUpdate(
    {
      _id: match[1],
      order: order._id,
      status: 'Received',
      'refund.status': { $in: ['Pending', 'Failed'] },
    },
    {
      $set: {
        status: 'Refunded',
        'refund.status': 'Processed',
        'refund.providerRefundId': refundEntity.id,
        'refund.processedAt': processedAt,
        'refund.failureReason': null,
      },
      $push: {
        auditTrail: {
          action: 'refund_webhook_processed',
          fromStatus: 'Received',
          toStatus: 'Refunded',
          note: 'Razorpay confirmed the refund',
          at: processedAt,
        },
      },
    },
    { new: true },
  );
}

async function reconcileOrderRefundStatus(order) {
  const processedAmount = (order.refunds || [])
    .filter((refund) => refund.status === 'Processed')
    .reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
  const pending = (order.refunds || []).some((refund) => ['Initiating', 'Pending'].includes(refund.status));
  const expectedAmount = Number(order.expectedAmount || Math.round(Number(order.finalAmount) * 100));
  let paymentStatus = order.paymentStatus;
  if (processedAmount >= expectedAmount && expectedAmount > 0) paymentStatus = 'Refunded';
  else if (processedAmount > 0) paymentStatus = 'Partially Refunded';
  else if (pending) paymentStatus = 'Refund Pending';
  else paymentStatus = 'Paid';
  const set = { paymentStatus };
  if (paymentStatus === 'Refunded' && order.orderStatus === 'Returned') set.orderStatus = 'Refunded';
  return Order.findByIdAndUpdate(order._id, { $set: set }, { new: true });
}

async function updateRefundRecord(orderId, key, values) {
  return Order.findOneAndUpdate(
    { _id: orderId, 'refunds.idempotencyKey': key },
    { $set: Object.fromEntries(Object.entries(values).map(([field, value]) => [`refunds.$.${field}`, value])) },
    { new: true },
  );
}

async function removePurchasedCartLines(order) {
  const cart = await Cart.findOne({ user: order.user });
  if (!cart) return;
  const purchased = order.orderItems.map((item) => ({
    product: String(item.product),
    variantId: String(item.variantId || ''),
    size: String(item.size || ''),
    color: String(item.color || ''),
  }));
  cart.items = cart.items.filter((item) => !purchased.some((line) => (
    String(item.product) === line.product
    && String(item.variantId || '') === line.variantId
    && String(item.size || '') === line.size
    && String(item.color || '') === line.color
  )));
  await cart.save();
}

function normalizeRefundStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'processed') return 'Processed';
  if (normalized === 'failed') return 'Failed';
  return 'Pending';
}

function paymentConflict(message, code, statusCode = 409) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

module.exports = {
  applyRefundWebhook,
  beginPaymentProcessing,
  cancelOrderFinancials,
  finalizePaidOrder,
  initiateRefund,
  markPaymentFailed,
  removePurchasedCartLines,
  reconcileOrderRefundStatus,
  reconcileReturnRefund,
  refundUnfulfillablePayment,
};
