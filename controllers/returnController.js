const crypto = require('crypto');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ReturnExchange = require('../models/ReturnExchange');
const { effectivePermissions } = require('../config/adminPermissions');
const { restoreReturnedItem } = require('../services/inventoryService');
const { initiateRefund } = require('../services/paymentService');
const {
  assertObjectId,
  cleanMultilineText,
  cleanString,
  paginationEnvelope,
  parsePagination,
  positiveInteger,
} = require('../utils/requestValidation');

const RETURN_REASONS = new Set([
  'Damaged item', 'Wrong item', 'Wrong size', 'Quality issue', 'Not as described', 'Changed mind', 'Other',
]);
const INELIGIBLE_ALLOCATIONS = ['Rejected'];
const STATUS_TRANSITIONS = {
  Requested: new Set(['Approved', 'Rejected']),
  Approved: new Set(['Pickup Scheduled', 'Received', 'Closed']),
  'Pickup Scheduled': new Set(['Received', 'Closed']),
  Received: new Set(['Refunded', 'Exchanged', 'Closed']),
  Rejected: new Set(['Closed']),
  Refunded: new Set(['Closed']),
  Exchanged: new Set(['Closed']),
  Closed: new Set(),
};

exports.createReturn = async (req, res) => {
  const orderId = assertObjectId(req.body.order || req.body.orderId, 'order id');
  const orderItemId = assertObjectId(req.body.orderItemId || req.body.itemId, 'order item id');
  const type = String(req.body.type || '').toLowerCase();
  if (!['return', 'exchange'].includes(type)) return res.status(400).json({ message: 'Type must be return or exchange' });

  const order = await Order.findOne({ _id: orderId, user: req.user._id });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  const delivered = order.orderStatus === 'Delivered'
    || order.statusTimeline?.some((event) => event.status === 'Delivered');
  if (!delivered || ['Cancelled', 'Return Rejected', 'Returned', 'Refunded'].includes(order.orderStatus)) {
    return res.status(409).json({ message: 'Only delivered items can be returned or exchanged', code: 'ORDER_NOT_DELIVERED' });
  }
  const orderItem = order.orderItems.id(orderItemId);
  if (!orderItem) return res.status(404).json({ message: 'Order item not found' });

  const deliveredAt = order.statusTimeline?.slice().reverse().find((event) => event.status === 'Delivered')?.date || order.updatedAt;
  const returnWindowDays = boundedEnvNumber('RETURN_WINDOW_DAYS', 7, 1, 60);
  if (Date.now() > new Date(deliveredAt).getTime() + returnWindowDays * 24 * 60 * 60 * 1000) {
    return res.status(409).json({ message: 'The return window has expired', code: 'RETURN_WINDOW_EXPIRED' });
  }

  const product = await Product.findById(orderItem.product);
  if (!product) return res.status(404).json({ message: 'Product no longer exists' });
  if (product.isReturnable === false) return res.status(409).json({ message: 'This product is not returnable', code: 'PRODUCT_NOT_RETURNABLE' });

  const quantity = positiveInteger(req.body.quantity, {
    field: 'quantity',
    min: 1,
    max: Number(orderItem.quantity || 1),
  });
  const allocated = await ReturnExchange.aggregate([
    {
      $match: {
        order: order._id,
        orderItemId: orderItem._id,
        status: { $nin: INELIGIBLE_ALLOCATIONS },
      },
    },
    { $group: { _id: null, quantity: { $sum: '$quantity' } } },
  ]);
  if (Number(allocated[0]?.quantity || 0) + quantity > Number(orderItem.quantity || 1)) {
    return res.status(409).json({ message: 'Requested quantity exceeds the quantity eligible for return', code: 'RETURN_QUANTITY_EXCEEDED' });
  }

  const reason = cleanString(req.body.reason, { field: 'reason', min: 2, max: 100, required: true });
  if (!RETURN_REASONS.has(reason)) return res.status(400).json({ message: 'Select a valid return reason' });
  const comment = cleanMultilineText(req.body.comment, { field: 'comment', max: 1000 });
  const evidenceImages = normalizeEvidenceImages(req.body.evidenceImages);
  let exchangeVariant;
  if (type === 'exchange') {
    const exchangeVariantId = cleanString(req.body.exchangeVariantId, {
      field: 'exchangeVariantId',
      min: 1,
      max: 100,
      required: true,
    });
    const variant = product.variants?.id?.(exchangeVariantId)
      || product.variants?.find?.((entry) => String(entry._id) === exchangeVariantId || entry.sku === exchangeVariantId);
    if (!variant || variant.isActive === false || Number(variant.stock || 0) < quantity) {
      return res.status(409).json({ message: 'The selected exchange variant is unavailable', code: 'EXCHANGE_VARIANT_UNAVAILABLE' });
    }
    exchangeVariant = { id: String(variant._id), sku: variant.sku, size: variant.size, color: variant.color };
  }

  const requestKeyHeader = String(req.get('Idempotency-Key') || '').trim();
  const requestKey = requestKeyHeader
    ? crypto.createHash('sha256').update(`${req.user._id}:${requestKeyHeader}`).digest('hex')
    : undefined;
  if (requestKey) {
    const existing = await ReturnExchange.findOne({ user: req.user._id, requestKey });
    if (existing) return res.status(200).json(existing);
  }

  const request = await ReturnExchange.create({
    order: order._id,
    orderItemId: orderItem._id,
    product: orderItem.product,
    user: req.user._id,
    type,
    quantity,
    variantId: orderItem.variantId,
    purchasedVariant: { sku: orderItem.sku, size: orderItem.size, color: orderItem.color },
    exchangeVariantId: exchangeVariant?.id,
    exchangeVariant,
    reason,
    comment,
    evidenceImages,
    requestKey,
    auditTrail: [{
      actor: req.user._id,
      action: 'return_requested',
      toStatus: 'Requested',
      ip: req.ip,
    }],
  });
  const requestedOrderStatus = type === 'exchange' ? 'Exchange Requested' : 'Return Requested';
  await Order.updateOne(
    { _id: order._id, orderStatus: 'Delivered' },
    {
      $set: { orderStatus: requestedOrderStatus },
      $push: {
        statusTimeline: {
          status: requestedOrderStatus,
          date: new Date(),
          note: `${type === 'exchange' ? 'Exchange' : 'Return'} requested for order item ${orderItem._id}`,
        },
      },
    },
  );
  return res.status(201).json(request);
};

exports.myReturns = async (req, res) => {
  const { page, limit, skip, sort } = parsePagination(req.query, { allowedSorts: ['createdAt', 'status'] });
  const filter = { user: req.user._id };
  const [items, total] = await Promise.all([
    ReturnExchange.find(filter).populate('order product').sort(sort).skip(skip).limit(limit),
    ReturnExchange.countDocuments(filter),
  ]);
  return res.json(paginationEnvelope(items, total, page, limit));
};

exports.adminReturns = async (req, res) => {
  const { page, limit, skip, sort } = parsePagination(req.query, { allowedSorts: ['createdAt', 'status'] });
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.type && ['return', 'exchange'].includes(req.query.type)) filter.type = req.query.type;
  const [items, total] = await Promise.all([
    ReturnExchange.find(filter).populate('user order product').sort(sort).skip(skip).limit(limit),
    ReturnExchange.countDocuments(filter),
  ]);
  return res.json(paginationEnvelope(items, total, page, limit));
};

exports.updateReturnStatus = async (req, res) => {
  assertObjectId(req.params.id, 'return request id');
  const request = await ReturnExchange.findById(req.params.id);
  if (!request) return res.status(404).json({ message: 'Return request not found' });
  const nextStatus = cleanString(req.body.status, { field: 'status', min: 3, max: 30, required: true });
  const isRestoreRetry = request.status === 'Received'
    && nextStatus === 'Received'
    && request.inventoryRestoreStatus === 'Failed';
  if (!isRestoreRetry && !STATUS_TRANSITIONS[request.status]?.has(nextStatus)) {
    return res.status(409).json({
      message: `Cannot transition return request from ${request.status} to ${nextStatus}`,
      code: 'INVALID_RETURN_TRANSITION',
    });
  }
  const adminComment = cleanMultilineText(req.body.adminComment, { field: 'adminComment', max: 1000 });
  if (nextStatus === 'Received') return receiveReturnedInventory({ req, res, request, adminComment });
  if (nextStatus === 'Refunded') return processReturnRefund({ req, res, request, adminComment });

  const updated = await ReturnExchange.findOneAndUpdate(
    { _id: request._id, status: request.status },
    {
      $set: {
        status: nextStatus,
        ...(adminComment ? { adminComment } : {}),
      },
      $push: {
        auditTrail: {
          actor: req.user._id,
          action: 'return_status_changed',
          fromStatus: request.status,
          toStatus: nextStatus,
          note: adminComment,
          ip: req.ip,
        },
      },
    },
    { new: true, runValidators: true },
  );
  if (!updated) return res.status(409).json({ message: 'Return request was updated by another administrator', code: 'RETURN_UPDATE_CONFLICT' });
  await syncOrderReturnState(updated);
  return res.json(updated);
};

async function receiveReturnedInventory({ req, res, request, adminComment }) {
  if (request.inventoryRestoreStatus === 'Restored') return res.json(request);
  const allowedStatus = request.status === 'Received' ? 'Received' : request.status;
  const claimed = await ReturnExchange.findOneAndUpdate(
    {
      _id: request._id,
      status: allowedStatus,
      inventoryRestoreStatus: { $in: ['Not Started', 'Failed'] },
    },
    {
      $set: {
        status: 'Received',
        inventoryRestoreStatus: 'Processing',
        ...(adminComment ? { adminComment } : {}),
      },
      $push: {
        auditTrail: {
          actor: req.user._id,
          action: 'inventory_restore_started',
          fromStatus: request.status,
          toStatus: 'Received',
          note: adminComment,
          ip: req.ip,
        },
      },
    },
    { new: true },
  );
  if (!claimed) {
    const latest = await ReturnExchange.findById(request._id);
    if (latest?.inventoryRestoreStatus === 'Restored') return res.json(latest);
    return res.status(409).json({ message: 'Inventory restoration is already being processed', code: 'INVENTORY_RESTORE_IN_PROGRESS' });
  }

  try {
    const order = await Order.findById(claimed.order);
    const item = order?.orderItems?.id(claimed.orderItemId);
    if (!order || !item) throw Object.assign(new Error('Original order item not found'), { statusCode: 409, code: 'ORDER_ITEM_NOT_FOUND' });
    await restoreReturnedItem(order, item, claimed.quantity, {
      actor: req.user._id,
      returnRequestId: claimed._id,
    });
    const restored = await ReturnExchange.findByIdAndUpdate(claimed._id, {
      $set: { inventoryRestoreStatus: 'Restored', inventoryRestoredAt: new Date() },
      $push: {
        auditTrail: {
          actor: req.user._id,
          action: 'inventory_restored',
          fromStatus: 'Received',
          toStatus: 'Received',
          ip: req.ip,
        },
      },
    }, { new: true });
    await syncOrderReturnState(restored);
    return res.json(restored);
  } catch (error) {
    await ReturnExchange.updateOne({ _id: claimed._id }, {
      $set: { inventoryRestoreStatus: 'Failed' },
      $push: {
        auditTrail: {
          actor: req.user._id,
          action: 'inventory_restore_failed',
          fromStatus: 'Received',
          toStatus: 'Received',
          note: String(error.code || 'INVENTORY_RESTORE_FAILED'),
          ip: req.ip,
        },
      },
    });
    throw error;
  }
}

async function processReturnRefund({ req, res, request, adminComment }) {
  if (!effectivePermissions(req.user).has('refund_payments')) {
    return res.status(403).json({ message: 'This admin account cannot issue refunds', code: 'PERMISSION_DENIED' });
  }
  if (request.status !== 'Received' || request.inventoryRestoreStatus !== 'Restored') {
    return res.status(409).json({ message: 'Returned inventory must be received and restored before refunding', code: 'RETURN_NOT_RECEIVED' });
  }
  if (request.refund?.status === 'Processed') {
    const alreadyProcessed = request.status === 'Refunded'
      ? request
      : await ReturnExchange.findByIdAndUpdate(request._id, { status: 'Refunded' }, { new: true });
    return res.json(alreadyProcessed);
  }
  const order = await Order.findById(request.order);
  const item = order?.orderItems?.id(request.orderItemId);
  if (!order || !item) return res.status(409).json({ message: 'Original order item not found', code: 'ORDER_ITEM_NOT_FOUND' });
  const refundAmount = calculateReturnRefundAmount(order, item, request.quantity);

  if (order.paymentProvider === 'Razorpay' || order.razorpayPaymentId) {
    const claimed = await ReturnExchange.findOneAndUpdate(
      {
        _id: request._id,
        status: 'Received',
        'refund.status': { $in: ['Not Started', 'Failed'] },
      },
      {
        $set: {
          'refund.method': 'Razorpay',
          'refund.status': 'Pending',
          'refund.amount': refundAmount,
          'refund.initiatedAt': new Date(),
          'refund.failureReason': null,
        },
        $push: {
          auditTrail: {
            actor: req.user._id,
            action: 'refund_initiation_claimed',
            fromStatus: 'Received',
            toStatus: 'Received',
            note: adminComment,
            ip: req.ip,
          },
        },
      },
      { new: true },
    );
    if (!claimed) {
      const latest = await ReturnExchange.findById(request._id);
      if (latest?.refund?.status === 'Processed') return res.json(latest);
      return res.status(202).json(latest);
    }
    let result;
    try {
      result = await initiateRefund({
        order,
        amountInPaise: Math.max(1, Math.round(refundAmount * 100)),
        actor: req.user._id,
        reason: `Return ${request._id}: ${request.reason}`,
        idempotencyKey: `return:${request._id}:${request.orderItemId}`,
      });
    } catch (error) {
      await ReturnExchange.updateOne(
        { _id: request._id, 'refund.status': 'Pending' },
        {
          $set: {
            'refund.status': 'Failed',
            'refund.failureReason': String(error.code || 'REFUND_INITIATION_FAILED').slice(0, 200),
          },
          $push: {
            auditTrail: {
              actor: req.user._id,
              action: 'refund_initiation_failed',
              fromStatus: 'Received',
              toStatus: 'Received',
              note: String(error.code || 'REFUND_INITIATION_FAILED'),
              ip: req.ip,
            },
          },
        },
      );
      throw error;
    }
    const providerRefund = result.refund;
    const processed = providerRefund.status === 'Processed';
    const updated = await ReturnExchange.findOneAndUpdate({
      _id: request._id,
      'refund.status': 'Pending',
    }, {
      $set: {
        ...(processed ? { status: 'Refunded' } : {}),
        adminComment: adminComment || request.adminComment,
        'refund.status': processed ? 'Processed' : 'Pending',
        'refund.providerRefundId': providerRefund.razorpayRefundId,
        ...(processed ? { 'refund.processedAt': providerRefund.processedAt || new Date() } : {}),
      },
      $push: {
        auditTrail: {
          actor: req.user._id,
          action: processed ? 'refund_processed' : 'refund_initiated',
          fromStatus: 'Received',
          toStatus: processed ? 'Refunded' : 'Received',
          note: adminComment,
          ip: req.ip,
        },
      },
    }, { new: true });
    const latest = updated || await ReturnExchange.findById(request._id);
    return res.status(latest?.refund?.status === 'Processed' ? 200 : 202).json(latest);
  }

  const method = String(req.body.refundMethod || '');
  if (!['Bank Transfer', 'UPI', 'Store Credit'].includes(method)) {
    return res.status(400).json({ message: 'A valid offline refund method is required for COD orders' });
  }
  const reference = cleanString(req.body.refundReference, {
    field: 'refundReference',
    min: 3,
    max: 120,
    required: true,
  });
  const updated = await ReturnExchange.findOneAndUpdate(
    { _id: request._id, status: 'Received', 'refund.status': { $ne: 'Processed' } },
    {
      $set: {
        status: 'Refunded',
        adminComment: adminComment || request.adminComment,
        refund: {
          method,
          status: 'Processed',
          amount: refundAmount,
          reference,
          initiatedAt: new Date(),
          processedAt: new Date(),
        },
      },
      $push: {
        auditTrail: {
          actor: req.user._id,
          action: 'offline_refund_recorded',
          fromStatus: 'Received',
          toStatus: 'Refunded',
          note: adminComment,
          ip: req.ip,
        },
      },
    },
    { new: true, runValidators: true },
  );
  if (!updated) return res.status(409).json({ message: 'Refund was already processed', code: 'REFUND_ALREADY_PROCESSED' });
  await syncOrderReturnState(updated);
  return res.json(updated);
}

async function syncOrderReturnState(returnRequest) {
  const order = await Order.findById(returnRequest.order);
  if (!order) return;
  if (returnRequest.status === 'Approved'
    && ['Return Requested', 'Exchange Requested'].includes(order.orderStatus)) {
    await transitionOrderIfCurrent(order, 'Return Approved', `Return request ${returnRequest._id} approved`);
    return;
  }
  if (returnRequest.status === 'Rejected'
    && ['Return Requested', 'Exchange Requested'].includes(order.orderStatus)) {
    const otherActive = await ReturnExchange.exists({
      order: order._id,
      _id: { $ne: returnRequest._id },
      status: { $nin: ['Rejected', 'Closed'] },
    });
    if (!otherActive) await transitionOrderIfCurrent(order, 'Return Rejected', `Return request ${returnRequest._id} rejected`);
    return;
  }
  if (!['Received', 'Refunded', 'Exchanged'].includes(returnRequest.status)
    || order.orderStatus !== 'Return Approved') return;
  const returned = await ReturnExchange.aggregate([
    {
      $match: {
        order: order._id,
        status: { $in: ['Received', 'Refunded', 'Exchanged'] },
      },
    },
    { $group: { _id: '$orderItemId', quantity: { $sum: '$quantity' } } },
  ]);
  const returnedByItem = new Map(returned.map((entry) => [String(entry._id), Number(entry.quantity)]));
  const wholeOrderReturned = order.orderItems.every(
    (item) => Number(returnedByItem.get(String(item._id)) || 0) >= Number(item.quantity || 0),
  );
  if (wholeOrderReturned) await transitionOrderIfCurrent(order, 'Returned', 'All order items were received back');
}

async function transitionOrderIfCurrent(order, nextStatus, note) {
  await Order.updateOne(
    { _id: order._id, orderStatus: order.orderStatus },
    {
      $set: { orderStatus: nextStatus },
      $push: { statusTimeline: { status: nextStatus, date: new Date(), note } },
    },
  );
}

function calculateReturnRefundAmount(order, item, quantity) {
  const merchandise = (order.orderItems || []).reduce(
    (sum, entry) => sum + Number(entry.price || 0) * Number(entry.quantity || 0),
    0,
  );
  const netMerchandise = Math.max(0, merchandise - Number(order.couponDiscount || 0));
  const linePaid = merchandise > 0
    ? (Number(item.price || 0) * Number(item.quantity || 0) / merchandise) * netMerchandise
    : 0;
  const amount = linePaid * (Number(quantity) / Number(item.quantity || 1));
  return Math.round((Math.max(0, amount) + Number.EPSILON) * 100) / 100;
}

function normalizeEvidenceImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) {
    const error = new Error('Evidence images must contain at most 5 uploaded images');
    error.statusCode = 400;
    throw error;
  }
  return value.map((entry) => {
    const url = String(typeof entry === 'string' ? entry : entry?.url || '').trim();
    if (!/^https:\/\//i.test(url) && !/^\/uploads\/[a-z0-9._-]+$/i.test(url)) {
      const error = new Error('Evidence image must reference a secure uploaded image');
      error.statusCode = 400;
      throw error;
    }
    return { url, publicId: typeof entry === 'object' ? cleanString(entry.publicId, { field: 'publicId', max: 300 }) : undefined };
  });
}

function boundedEnvNumber(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

exports.STATUS_TRANSITIONS = STATUS_TRANSITIONS;
