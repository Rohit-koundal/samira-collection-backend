const Order = require('../models/Order');
const Settings = require('../models/Settings');
const InventoryTransaction = require('../models/InventoryTransaction');
const couponService = require('../services/couponService');
const inventoryService = require('../services/inventoryService');
const { buildOrderDraft } = require('../services/orderPricingService');
const { buildPaymentOptions, getStoreSettings } = require('../services/paymentSettingsService');
const { isRazorpayConfigured } = require('../services/razorpayService');
const { runInTransaction } = require('../utils/transaction');
const { ApiError, forbidden, notFound } = require('../utils/apiError');
const { asyncHandler } = require('../middleware/validate');
const { readPagination, requireEnum, requireObjectId, optionalString, wantsPagination, buildPaginatedResponse } = require('../utils/validators');
const { syncPaidOnlineOrderStatus } = require('../utils/orderStatusUtils');
const { buildPersistedOrderFields } = require('../services/orderSnapshotService');
const { notifyLater } = require('../services/notificationService');
const { toShipmentStatus, upsertShipmentForOrder } = require('../services/shippingService');
const { andFilter } = require('../services/storeService');
const { readAttribution } = require('../utils/attribution');
const { logAudit } = require('../services/auditService');
const { recordEventLater } = require('../services/analyticsService');

const ORDER_STATUSES = ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'];
const PAYMENT_STATUSES = ['Pending', 'Paid', 'Failed', 'Refunded'];
const CANCELLABLE_STATUSES = ['Pending', 'Confirmed', 'Packed'];

function assertCheckoutReady(req) {
  if (!req.user?.isPhoneVerified) {
    throw new ApiError('FORBIDDEN', 'Please verify your mobile number to continue checkout.');
  }
}

function assertShippingAddress(address) {
  if (!address || typeof address !== 'object') {
    throw new ApiError('VALIDATION_ERROR', 'Please select a delivery address');
  }
  const pincode = String(address.pincode || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(pincode)) throw new ApiError('VALIDATION_ERROR', 'Please select an address with a valid 6-digit pincode');
  if (!String(address.fullName || '').trim()) throw new ApiError('VALIDATION_ERROR', 'Delivery address needs a contact name');
  if (!/^[6-9]\d{9}$/.test(String(address.mobile || address.phone || '').replace(/\D/g, '').replace(/^91/, ''))) {
    throw new ApiError('VALIDATION_ERROR', 'Delivery address needs a valid 10-digit mobile number');
  }
  return address;
}

function isOwnerOrAdmin(order, user, req) {
  const ownerId = String(order.user?._id || order.user || '');
  if (user.role === 'admin' || ownerId === String(user._id)) return true;
  if (req?.store?._id && order.storeId && String(order.storeId) === String(req.store._id)) return true;
  return false;
}

/**
 * Returns the authoritative price breakdown plus the payment methods the
 * store currently allows. The checkout screen renders this instead of
 * calculating totals in the browser.
 */
exports.quoteOrder = asyncHandler(async (req, res) => {
  const settings = await getStoreSettings();
  const paymentOptions = buildPaymentOptions(settings, { razorpayConfigured: isRazorpayConfigured() });

  if (!Array.isArray(req.body?.orderItems) || !req.body.orderItems.length) {
    return res.json({ paymentOptions, totals: null });
  }

  const draft = await buildOrderDraft({
    orderItems: req.body.orderItems,
    couponCode: req.body.coupon?.code || req.body.couponCode,
    paymentMethod: req.body.paymentMethod,
    settings,
    userId: req.user?._id,
    shippingAddress: req.body.shippingAddress,
  });

  return res.json({
    paymentMethod: draft.paymentMethod,
    totals: draft.totals,
    items: draft.items,
    paymentOptions: buildPaymentOptions(settings, {
      razorpayConfigured: isRazorpayConfigured(),
      orderAmount: draft.totals.finalAmount - draft.totals.codCharge,
    }),
  });
});

/**
 * COD checkout. Order creation, stock deduction and coupon consumption are
 * applied together so we never end up with an order whose stock was never
 * taken, or stock taken for an order that failed to save.
 */
exports.createOrder = asyncHandler(async (req, res) => {
  assertCheckoutReady(req);

  const shippingAddress = assertShippingAddress(req.body?.shippingAddress);
  const draft = await buildOrderDraft({
    orderItems: req.body?.orderItems,
    couponCode: req.body?.coupon?.code,
    paymentMethod: req.body?.paymentMethod || 'COD',
    userId: req.user?._id,
    shippingAddress,
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
          codConfirmationStatus: draft.paymentMethod === 'COD' && draft.settings?.codConfirmationRequired ? 'PENDING' : 'NOT_REQUIRED',
          paymentProvider: draft.paymentMethod === 'COD' ? 'COD' : 'Razorpay',
          paymentStatus: 'Pending',
          paymentState: 'PENDING',
          orderStatus: 'Pending',
          inventoryDeducted: true,
          inventoryDeductedAt: new Date(),
          couponConsumed: Boolean(draft.totals.coupon?.code),
          statusTimeline: [{ status: 'Pending', date: new Date(), note: 'Order placed' }],
        },
      }),
    }], session ? { session } : {});

    let stockTaken = false;
    try {
      await inventoryService.deductStockForOrder(draft.items, {
        orderId: created._id,
        userId: req.user._id,
        reason: 'Order placed',
        session,
      });
      stockTaken = true;

      if (draft.totals.coupon?.code) {
        await couponService.consumeCoupon(draft.totals.coupon.code, { session });
      }
    } catch (error) {
      // A transaction rolls all of this back on its own. Without one, undo the
      // side effects by hand so a coupon failure cannot leave stock consumed
      // by an order that was never created.
      if (!session) {
        if (stockTaken) {
          await inventoryService.restoreStockForOrder(draft.items, {
            orderId: created._id,
            userId: req.user._id,
            type: 'CANCELLATION',
            reason: 'Checkout failed after stock was reserved',
          }).catch(() => null);
        }
        await Order.deleteOne({ _id: created._id }).catch(() => null);
        await InventoryTransaction.deleteMany({ order: created._id }).catch(() => null);
      }
      throw error;
    }

    return created;
  });

  recordEventLater({
    name: 'PURCHASE',
    storeId: order.storeId,
    userId: req.user._id,
    orderId: order._id,
    source: order.attribution?.source,
    campaign: order.attribution?.campaign,
    reelId: order.attribution?.reelId,
  });

  notifyLater({
    userId: req.user._id,
    event: 'ORDER_PLACED',
    title: 'Order placed',
    message: `Your order ${order.invoiceNumber || ''} has been placed.`,
    metadata: { orderId: String(order._id) },
  });

  res.status(201).json(order);
});

exports.createCodOrder = (req, res, next) => {
  req.body = { ...(req.body || {}), paymentMethod: 'COD', paymentProvider: 'COD' };
  return exports.createOrder(req, res, next);
};

exports.myOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find({ user: req.user._id }).populate('shipment').sort('-createdAt').limit(200);
  await Promise.all(orders.map((order) => syncPaidOnlineOrderStatus(order)));
  res.json(orders);
});

exports.getOrder = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter)).populate('user', 'name email phone').populate('shipment');
  if (!order) throw notFound('Order not found');
  if (!isOwnerOrAdmin(order, req.user, req)) throw forbidden('Not allowed to view this order');
  await syncPaidOnlineOrderStatus(order);
  res.json(order);
});

exports.adminOrders = asyncHandler(async (req, res) => {
  const filter = andFilter({}, req.tenantFilter);
  const finder = () => Order.find(filter).populate('user', 'name email phone').sort('-createdAt');
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([
      finder().skip(skip).limit(limit),
      Order.countDocuments(filter),
    ]);
    return res.json(buildPaginatedResponse(items, { page, limit, total }));
  }
  const { limit, skip } = readPagination(req.query, { defaultLimit: 200, maxLimit: 500 });
  res.json(await finder().skip(skip).limit(limit));
});

exports.updateOrderStatus = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const orderStatus = requireEnum(req.body?.orderStatus, ORDER_STATUSES, 'orderStatus');
  const note = optionalString(req.body?.note, 'note', { max: 300 });

  const order = await Order.findById(req.params.id);
  if (!order) throw notFound('Order not found');

  // Cancelling from the admin screen must follow the same restore rules as a
  // customer cancellation, otherwise stock silently disappears.
  if (orderStatus === 'Cancelled') {
    return res.json(await cancelOrderInternal(order, { actor: req.user, note: note || 'Cancelled by admin', force: true }));
  }

  order.orderStatus = orderStatus;
  order.statusTimeline.push({ status: orderStatus, date: new Date(), note });
  if (orderStatus === 'Delivered') order.deliveredAt = order.deliveredAt || new Date();
  await order.save();

  if (toShipmentStatus(orderStatus)) {
    await upsertShipmentForOrder(order, { status: toShipmentStatus(orderStatus), note: note || `Order marked ${orderStatus}` }).catch(() => null);
  }

  if (orderStatus === 'Delivered') {
    notifyLater({
      userId: order.user,
      event: 'ORDER_DELIVERED',
      title: 'Order delivered',
      message: 'Your order has been delivered. You can now rate products or request a return.',
      metadata: { orderId: String(order._id) },
    });
  }

  res.json(order);
});

exports.updatePaymentStatus = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const paymentStatus = requireEnum(req.body?.paymentStatus, PAYMENT_STATUSES, 'paymentStatus');
  const paymentState = { Pending: 'PENDING', Paid: 'PAID', Failed: 'FAILED', Refunded: 'REFUNDED' }[paymentStatus];

  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { paymentStatus, paymentState },
    { new: true },
  );
  if (!order) throw notFound('Order not found');
  res.json(order);
});

/**
 * Orders are financial history, so they are cancelled rather than deleted.
 */
exports.deleteOrder = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findById(req.params.id);
  if (!order) throw notFound('Order not found');

  if (order.orderStatus === 'Cancelled') {
    return res.json({ success: true, message: 'Order is already cancelled', order });
  }

  const cancelled = await cancelOrderInternal(order, { actor: req.user, note: 'Cancelled by admin', force: true });
  res.json({ success: true, message: 'Order cancelled', order: cancelled });
});

exports.cancelOrder = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findById(req.params.id);
  if (!order) throw notFound('Order not found');
  if (!isOwnerOrAdmin(order, req.user, req)) throw forbidden('Not allowed');

  const note = req.user.role === 'admin' ? 'Cancelled by admin' : 'Cancelled by customer';
  res.json(await cancelOrderInternal(order, { actor: req.user, note }));
});

/**
 * Cancellation is idempotent.
 *
 * Stock restore and coupon release are each claimed with a conditional update,
 * so calling this twice cannot restock twice or hand back two redemptions.
 *
 * `force` widens the allowed source states for admins (for example cancelling
 * an order that already shipped). A delivered order is never cancellable in
 * either mode: the goods are with the customer, which is a return, not a
 * cancellation, and restocking there would invent inventory.
 */
async function cancelOrderInternal(order, { actor, note, force = false }) {
  if (order.orderStatus === 'Cancelled') return order;

  const allowed = force
    ? ORDER_STATUSES.filter((status) => !['Delivered', 'Cancelled', 'Returned', 'Refunded'].includes(status))
    : CANCELLABLE_STATUSES;

  if (!allowed.includes(order.orderStatus)) {
    throw new ApiError('ORDER_NOT_CANCELLABLE', `An order that is already ${order.orderStatus.toLowerCase()} cannot be cancelled`);
  }

  return runInTransaction(async (session) => {
    const claimed = await inventoryService.claimInventoryRestore(Order, order._id, session);
    if (claimed) {
      await inventoryService.restoreStockForOrder(claimed.orderItems, {
        orderId: claimed._id,
        userId: actor?._id,
        type: 'CANCELLATION',
        reason: note,
        session,
      });
    }

    const releaseTarget = await Order.findOneAndUpdate(
      { _id: order._id, couponConsumed: true, couponReleased: { $ne: true } },
      { $set: { couponReleased: true } },
      { new: true, session },
    );
    if (releaseTarget?.coupon?.code) {
      await couponService.releaseCoupon(releaseTarget.coupon.code, { session });
    }

    const updated = await Order.findOneAndUpdate(
      { _id: order._id, orderStatus: { $ne: 'Cancelled' } },
      {
        $set: { orderStatus: 'Cancelled' },
        $push: { statusTimeline: { status: 'Cancelled', date: new Date(), note } },
      },
      { new: true, session },
    );

    return updated || Order.findById(order._id).session(session || null);
  }).then((cancelled) => {
    logAudit({ req: { user: actor }, action: 'ORDER_CANCEL', entityType: 'Order', entityId: order._id, after: { orderStatus: 'Cancelled' }, storeId: order.storeId });
    return cancelled;
  });
}

exports.receipt = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findById(req.params.id).populate('user', 'name email phone').populate('shipment');
  if (!order) throw notFound('Order not found');
  if (!isOwnerOrAdmin(order, req.user, req)) throw forbidden('Not allowed to view this receipt');
  await syncPaidOnlineOrderStatus(order);
  res.json(await buildReceipt(order.toObject ? order.toObject() : order));
});

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
    paymentState: order.paymentState,
    orderStatus: order.orderStatus,
    statusTimeline: order.statusTimeline,
    totalMRP: order.totalMRP,
    productDiscount: order.productDiscount || 0,
    couponDiscount: order.couponDiscount || order.coupon?.discountAmount || 0,
    deliveryCharge: order.deliveryCharge || 0,
    codCharge: order.codCharge || 0,
    finalAmount: order.finalAmount,
    coupon: order.coupon,
    razorpayOrderId: order.razorpayOrderId,
    razorpayPaymentId: order.razorpayPaymentId,
    paymentFailureReason: order.paymentFailureReason,
    invoiceNumber: order.invoiceNumber,
    invoiceDate: order.invoiceDate,
    billingAddress: order.billingAddress,
    shipment: order.shipment,
    storeDetails: {
      storeName: settings?.storeName || 'Samira Collection',
      legalBusinessName: settings?.legalBusinessName,
      gstin: settings?.gstin,
      contactEmail: settings?.contactEmail,
      contactPhone: settings?.contactPhone,
      whatsappNumber: settings?.whatsappNumber,
      address: settings?.address,
      billingAddress: settings?.billingAddress,
    },
    policies: {
      returnPolicy: settings?.returnPolicy || 'Return/exchange as per store policy.',
    },
  };
}

exports.updateShipment = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findById(req.params.id);
  if (!order) throw notFound('Order not found');
  const shipment = await upsertShipmentForOrder(order, {
    courierName: optionalString(req.body?.courierName, 'courierName', { max: 80 }) || undefined,
    trackingNumber: optionalString(req.body?.trackingNumber, 'trackingNumber', { max: 80 }) || undefined,
    trackingUrl: optionalString(req.body?.trackingUrl, 'trackingUrl', { max: 500 }) || undefined,
    awb: optionalString(req.body?.awb, 'awb', { max: 80 }) || undefined,
    status: req.body?.status,
    note: optionalString(req.body?.note, 'note', { max: 300 }) || 'Shipment updated by admin',
  });
  res.json(shipment);
});

exports.assertCheckoutReady = assertCheckoutReady;
exports.assertShippingAddress = assertShippingAddress;
exports.cancelOrderInternal = cancelOrderInternal;
