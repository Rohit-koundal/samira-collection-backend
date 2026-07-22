const Order = require('../models/Order');
const Settings = require('../models/Settings');
const {
  applyReservedCoupon,
  prepareCheckout,
} = require('../services/checkoutService');
const {
  commitInventory,
  getReservationExpiry,
  releaseInventory,
  reserveInventory,
  restoreCommittedInventory,
} = require('../services/inventoryService');
const {
  releaseCouponReservation,
  redeemCouponReservation,
  validateAndReserveCoupon,
} = require('../services/couponService');
const {
  cancelOrderFinancials,
  initiateRefund,
  removePurchasedCartLines,
} = require('../services/paymentService');
const { effectivePermissions } = require('../config/adminPermissions');
const { assertOrderTransition } = require('../services/orderStateService');
const {
  buildCheckoutSnapshotHash,
  pickOrderFields,
} = require('../utils/paymentUtils');
const {
  assertObjectId,
  paginationEnvelope,
  parsePagination,
} = require('../utils/requestValidation');

exports.createOrder = async (req, res, next) => {
  try {
    if (!req.user?.isPhoneVerified) {
      return res.status(403).json({ message: 'Please verify your mobile number to continue checkout.' });
    }
    if (req.body.paymentMethod
      && String(req.body.paymentMethod).toUpperCase() !== 'COD') {
      return res.status(400).json({
        message: 'Online orders must be created through the payment checkout endpoint',
        code: 'PAYMENT_VERIFICATION_REQUIRED',
      });
    }
    const orderFields = pickOrderFields({ ...req.body, paymentMethod: 'COD' }, { allowCod: true });
    const couponCode = orderFields.coupon?.code;
    const checkout = await prepareCheckout(req.body.orderItems, couponCode, {
      userId: req.user._id,
      paymentMethod: 'COD',
    });
    const snapshotHash = buildCheckoutSnapshotHash({
      userId: req.user._id,
      orderItems: checkout.items,
      shippingAddress: orderFields.shippingAddress,
      paymentMethod: 'COD',
      couponCode,
    });
    const idempotencyKey = normalizeIdempotencyKey(req.get('Idempotency-Key'));
    if (idempotencyKey) {
      const existing = await Order.findOne({ user: req.user._id, idempotencyKey });
      if (existing) return respondToExistingCodOrder(existing, snapshotHash, res);
    }

    let order;
    const checkoutExpiresAt = getReservationExpiry();
    try {
      order = await Order.create({
        ...orderFields,
        orderItems: checkout.items,
        user: req.user._id,
        paymentMethod: 'COD',
        paymentProvider: 'COD',
        paymentStatus: 'Pending',
        orderStatus: 'Pending',
        inventoryStatus: 'Not Reserved',
        reservationExpiresAt: checkoutExpiresAt,
        checkoutSnapshotHash: snapshotHash,
        idempotencyKey,
        currency: 'INR',
        expectedAmount: Math.round(checkout.totals.finalAmount * 100),
        ...checkout.totals,
        statusTimeline: [{ status: 'Pending', date: new Date(), note: 'COD order placed' }],
        paymentAudit: [{ action: 'COD_ORDER_CREATED', status: 'Pending', at: new Date() }],
      });
    } catch (error) {
      if (error.code === 11000 && idempotencyKey) {
        const existing = await Order.findOne({ user: req.user._id, idempotencyKey });
        if (existing) return respondToExistingCodOrder(existing, snapshotHash, res);
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
          paymentMethod: 'COD',
          reservedUntil: checkoutExpiresAt,
        });
        const totals = applyReservedCoupon(checkout.totals, checkout.sellingTotal, reservation);
        Object.assign(order, totals, { expectedAmount: Math.round(totals.finalAmount * 100) });
        await order.save();
      }
      order = await reserveInventory(order, req.user._id);
      order = await commitInventory(order, req.user._id);
      await redeemCouponReservation({ orderId: order._id });
      order = await Order.findById(order._id);
      await removePurchasedCartLines(order);
      return res.status(201).json(order);
    } catch (error) {
      await cleanupFailedCodOrder(order, req.user._id, error.code || 'COD_ORDER_FAILED');
      throw error;
    }
  } catch (error) {
    return next(error);
  }
};

exports.createCodOrder = exports.createOrder;

exports.myOrders = async (req, res, next) => {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query, {
      allowedSorts: ['createdAt', 'orderStatus', 'finalAmount'],
    });
    const filter = { user: req.user._id };
    if (req.query.status) filter.orderStatus = safeOrderStatus(req.query.status);
    const [items, total] = await Promise.all([
      Order.find(filter).sort(sort).skip(skip).limit(limit),
      Order.countDocuments(filter),
    ]);
    return res.json(paginationEnvelope(items, total, page, limit));
  } catch (error) {
    return next(error);
  }
};

exports.getOrder = async (req, res, next) => {
  try {
    assertObjectId(req.params.id, 'order id');
    const order = await Order.findById(req.params.id).populate('user', 'name email phone');
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (!canAccessOrder(req.user, order.user)) {
      return res.status(403).json({ message: 'Not allowed to view this order' });
    }
    return res.json(order);
  } catch (error) {
    return next(error);
  }
};

exports.adminOrders = async (req, res, next) => {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query, {
      allowedSorts: ['createdAt', 'orderStatus', 'paymentStatus', 'finalAmount'],
    });
    const filter = {};
    if (req.query.status) filter.orderStatus = safeOrderStatus(req.query.status);
    if (req.query.paymentStatus) filter.paymentStatus = safePaymentStatus(req.query.paymentStatus);
    if (req.query.user) filter.user = assertObjectId(req.query.user, 'user id');
    const [items, total] = await Promise.all([
      Order.find(filter).populate('user', 'name email phone').sort(sort).skip(skip).limit(limit),
      Order.countDocuments(filter),
    ]);
    return res.json(paginationEnvelope(items, total, page, limit));
  } catch (error) {
    return next(error);
  }
};

exports.updateOrderStatus = async (req, res, next) => {
  try {
    assertObjectId(req.params.id, 'order id');
    const nextStatus = String(req.body.orderStatus || '').trim();
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    assertOrderTransition(order.orderStatus, nextStatus);
    if (order.orderStatus === nextStatus) return res.json(order);
    const note = sanitizeNote(req.body.note) || `Order moved to ${nextStatus}`;
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, orderStatus: order.orderStatus },
      {
        $set: { orderStatus: nextStatus },
        $push: { statusTimeline: { status: nextStatus, date: new Date(), note } },
      },
      { new: true },
    );
    if (!updated) return res.status(409).json({ message: 'Order status changed; refresh and retry' });
    if (nextStatus === 'Cancelled') {
      const financials = await cancelOrderFinancials(updated, {
        actor: req.user._id,
        reason: note,
      });
      return res.json(financials.order);
    }
    return res.json(updated);
  } catch (error) {
    return next(error);
  }
};

exports.updatePaymentStatus = async (req, res) => res.status(405).json({
  message: 'Payment status is controlled by the payment provider and refund workflow',
  code: 'PAYMENT_STATUS_PROVIDER_CONTROLLED',
});

exports.deleteOrder = async (req, res) => res.status(405).json({
  message: 'Financial order records cannot be permanently deleted',
  code: 'ORDER_DELETION_DISABLED',
});

exports.cancelOrder = async (req, res, next) => {
  try {
    assertObjectId(req.params.id, 'order id');
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (!canAccessOrder(req.user, order.user)) {
      return res.status(403).json({ message: 'Not allowed' });
    }
    assertOrderTransition(order.orderStatus, 'Cancelled');
    const reason = sanitizeNote(req.body?.reason) || 'Order cancelled by customer';
    const cancelled = await Order.findOneAndUpdate(
      { _id: order._id, orderStatus: order.orderStatus },
      {
        $set: { orderStatus: 'Cancelled' },
        $push: { statusTimeline: { status: 'Cancelled', date: new Date(), note: reason } },
      },
      { new: true },
    );
    if (!cancelled) return res.status(409).json({ message: 'Order status changed; refresh and retry' });
    const financials = await cancelOrderFinancials(cancelled, {
      actor: req.user._id,
      reason,
    });
    return res.json(financials.order);
  } catch (error) {
    return next(error);
  }
};

exports.receipt = async (req, res, next) => {
  try {
    assertObjectId(req.params.id, 'order id');
    const order = await Order.findById(req.params.id).populate('user', 'name email phone');
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (!canAccessOrder(req.user, order.user)) {
      return res.status(403).json({ message: 'Not allowed to view this receipt' });
    }
    return res.json(await buildReceipt(order.toObject ? order.toObject() : order));
  } catch (error) {
    return next(error);
  }
};

exports.retryCancellationRefund = async (req, res, next) => {
  try {
    assertObjectId(req.params.id, 'order id');
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.orderStatus !== 'Cancelled') {
      return res.status(409).json({ message: 'Only cancelled orders can use this refund retry', code: 'ORDER_NOT_CANCELLED' });
    }
    if (order.paymentStatus === 'Refunded') return res.json(order);
    const reason = sanitizeNote(req.body?.reason) || 'Retry refund for cancelled order';
    const result = await initiateRefund({
      order,
      actor: req.user._id,
      reason,
      idempotencyKey: `cancel:${String(order._id)}:full`,
    });
    return res.status(result.refund?.status === 'Processed' ? 200 : 202).json(result.order);
  } catch (error) {
    return next(error);
  }
};

async function cleanupFailedCodOrder(order, actor, reason) {
  if (!order) return;
  try {
    let current = await Order.findById(order._id);
    if (current?.inventoryStatus === 'Reserved') {
      current = await releaseInventory(current, actor, reason);
    } else if (current?.inventoryStatus === 'Committed') {
      current = await restoreCommittedInventory(current, actor, reason);
    }
    await releaseCouponReservation({
      orderId: order._id,
      reason,
      reverseRedeemed: true,
    });
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          orderStatus: 'Cancelled',
          paymentStatus: 'Failed',
          paymentFailureReason: reason,
        },
        $push: {
          statusTimeline: {
            status: 'Cancelled',
            date: new Date(),
            note: 'COD order failed and stock was restored',
          },
        },
      },
    );
  } catch (cleanupError) {
    console.error('COD checkout cleanup failed', {
      orderId: String(order._id),
      code: cleanupError.code || 'COD_CLEANUP_FAILED',
    });
  }
}

async function buildReceipt(order) {
  const settings = await Settings.findOne().lean();
  return {
    orderId: order._id,
    orderDate: order.createdAt,
    customer: order.user,
    shippingAddress: order.shippingAddress,
    items: order.orderItems,
    paymentMethod: order.paymentMethod,
    paymentProvider: order.paymentProvider,
    paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus,
    statusTimeline: order.statusTimeline,
    totalMRP: order.totalMRP,
    productDiscount: order.productDiscount || 0,
    couponDiscount: order.couponDiscount || 0,
    deliveryCharge: order.deliveryCharge || 0,
    codCharge: order.codCharge || 0,
    taxAmount: order.taxAmount || 0,
    finalAmount: order.finalAmount,
    currency: order.currency || 'INR',
    coupon: order.coupon,
    razorpayOrderId: order.razorpayOrderId,
    razorpayPaymentId: order.razorpayPaymentId,
    refunds: order.refunds,
    storeDetails: {
      storeName: settings?.storeName || 'Samira Collection',
      contactEmail: settings?.contactEmail,
      contactPhone: settings?.contactPhone,
      whatsappNumber: settings?.whatsappNumber,
      address: settings?.address,
    },
    policies: {
      returnPolicy: settings?.returnPolicy || 'Return/exchange as per store policy.',
    },
  };
}

function respondToExistingCodOrder(existing, snapshotHash, res) {
  if (existing.checkoutSnapshotHash !== snapshotHash) {
    return res.status(409).json({
      message: 'Idempotency key was already used for a different order',
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  }
  if (['Not Reserved', 'Reserving', 'Reserved', 'Committing'].includes(existing.inventoryStatus)) {
    return res.status(409).json({
      message: 'COD order is still being created',
      code: 'CHECKOUT_IN_PROGRESS',
    });
  }
  if (existing.inventoryStatus !== 'Committed' || existing.orderStatus === 'Cancelled') {
    return res.status(409).json({
      message: 'This COD checkout can no longer be completed',
      code: 'CHECKOUT_NOT_PAYABLE',
    });
  }
  return res.json(existing);
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

function sanitizeNote(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
}

function canAccessOrder(user, orderUser) {
  const ownerId = orderUser?._id || orderUser;
  if (String(ownerId) === String(user?._id)) return true;
  if (!['admin', 'owner'].includes(user?.role) || user.activeMode !== 'admin') return false;
  return effectivePermissions(user).has('manage_orders');
}

function safeOrderStatus(value) {
  const allowed = Order.schema.path('orderStatus').enumValues;
  const status = String(value || '');
  if (!allowed.includes(status)) {
    const error = new Error('Invalid order status filter');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  return status;
}

function safePaymentStatus(value) {
  const allowed = Order.schema.path('paymentStatus').enumValues;
  const status = String(value || '');
  if (!allowed.includes(status)) {
    const error = new Error('Invalid payment status filter');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  return status;
}

exports.prepareOrder = async (orderItems, couponCode, options = {}) => {
  const checkout = await prepareCheckout(orderItems, couponCode, options);
  return { items: checkout.items, totals: checkout.totals };
};
