const Order = require('../models/Order');
const Settings = require('../models/Settings');
const InventoryTransaction = require('../models/InventoryTransaction');
const couponService = require('../services/couponService');
const inventoryService = require('../services/inventoryService');
const { buildOrderDraft } = require('../services/orderPricingService');
const { applyCustomerRtoToPaymentOptions, buildPaymentOptions, getStoreSettings } = require('../services/paymentSettingsService');
const { isRazorpayConfigured } = require('../services/razorpayService');
const { runInTransaction } = require('../utils/transaction');
const { ApiError, forbidden, notFound } = require('../utils/apiError');
const { asyncHandler } = require('../middleware/validate');
const { readPagination, requireEnum, requireObjectId, requireString, optionalString, wantsPagination, buildPaginatedResponse } = require('../utils/validators');
const { syncPaidOnlineOrderStatus } = require('../utils/orderStatusUtils');
const { buildPersistedOrderFields } = require('../services/orderSnapshotService');
const { notifyLater } = require('../services/notificationService');
const { toShipmentStatus, upsertShipmentForOrder } = require('../services/shippingService');
const { andFilter } = require('../services/storeService');
const { readAttribution } = require('../utils/attribution');
const { logAudit } = require('../services/auditService');
const { recordEventLater } = require('../services/analyticsService');
const { normalizeIndianMobile } = require('../utils/phoneUtils');
const { adminOrderFilter } = require('../services/dashboardAnalytics');
const { assertMonthlyOrderCapacity, assertStoreCanAcceptOrders } = require('../middleware/storeMiddleware');
const { assertOrderTransition, canCancelOrder, publicWorkflow } = require('../services/orderWorkflowService');
const { applyCustomerRestrictionsToPaymentOptions, assertCustomerCanCheckout, getCustomerRestrictions } = require('../services/customerAccessService');

const ORDER_STATUSES = ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'];
const PAYMENT_STATUSES = ['Pending', 'Paid', 'Failed', 'Refunded'];
const CANCELLABLE_STATUSES = ['Pending', 'Confirmed', 'Packed'];
const MANUAL_PAYMENT_TRANSITIONS = { Pending: ['Paid'], Paid: ['Refunded'] };

function revisionFilter(value) {
  const revision = Number(value || 0);
  return revision === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision };
}

function assertCurrentRevision(order, supplied) {
  if (supplied === undefined || supplied === null || supplied === '') return Number(order.revision || 0);
  const value = Number(supplied);
  if (!Number.isInteger(value) || value < 0) throw new ApiError('VALIDATION_ERROR', 'A valid order revision is required.');
  if (value !== Number(order.revision || 0)) throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
  return value;
}

function managerRequest(req) {
  return req.user?.role === 'admin' || Boolean(req.storeMember);
}

function actorSnapshot(req) {
  return { id: String(req.user?._id || ''), name: String(req.user?.name || req.user?.phone || 'Staff').slice(0, 100) };
}

function decorateOrder(order, options = {}) {
  if (!order) return order;
  const value = order.toObject ? order.toObject() : { ...order };
  return { ...value, ...publicWorkflow(value, value.shipment, options) };
}

function assertCheckoutReady(req) {
  if (!req.user?.isPhoneVerified) {
    throw new ApiError('FORBIDDEN', 'Please verify your mobile number to continue checkout.');
  }
}

function assertShippingAddress(address) {
  if (!address || typeof address !== 'object') {
    throw new ApiError('VALIDATION_ERROR', 'Please select a delivery address');
  }
  const clean = require('../services/orderSnapshotService').snapshotAddress(address);
  const pincode = clean.pincode;
  if (!/^\d{6}$/.test(pincode)) throw new ApiError('VALIDATION_ERROR', 'Please select an address with a valid 6-digit pincode');
  if (!clean.fullName) throw new ApiError('VALIDATION_ERROR', 'Delivery address needs a contact name');
  if (!/^[6-9]\d{9}$/.test(clean.mobile)) {
    throw new ApiError('VALIDATION_ERROR', 'Delivery address needs a valid 10-digit mobile number');
  }
  for (const [field, label] of [['houseNo', 'house or flat number'], ['area', 'street or area'], ['city', 'city'], ['state', 'state']]) {
    if (!clean[field]) throw new ApiError('VALIDATION_ERROR', `Delivery address needs a ${label}`);
  }
  const lengths = { fullName: 100, alternateMobile: 20, state: 100, city: 100, houseNo: 160, area: 300, landmark: 200, addressType: 30 };
  for (const [field, max] of Object.entries(lengths)) if (clean[field]?.length > max) throw new ApiError('VALIDATION_ERROR', `Delivery address ${field} is too long`);
  if (clean.alternateMobile && !/^[6-9]\d{9}$/.test(normalizeIndianMobile(clean.alternateMobile))) throw new ApiError('VALIDATION_ERROR', 'Alternate mobile number must be a valid 10-digit number');
  return clean;
}

function isOwnerOrAdmin(order, user, req) {
  const ownerId = String(order.user?._id || order.user || '');
  if (user.role === 'admin' || ownerId === String(user._id)) return true;
  if (req?.storeMember && req?.store?._id && order.storeId && String(order.storeId) === String(req.store._id)) return true;
  return false;
}

/**
 * Returns the authoritative price breakdown plus the payment methods the
 * store currently allows. The checkout screen renders this instead of
 * calculating totals in the browser.
 */
exports.quoteOrder = asyncHandler(async (req, res) => {
  assertStoreCanAcceptOrders(req.store);
  const customerRestrictions = await getCustomerRestrictions({ storeId: req.store?._id, userId: req.user?._id });
  await assertCustomerCanCheckout({ storeId: req.store?._id, userId: req.user?._id, paymentMethod: req.body?.paymentMethod });
  const settings = await getStoreSettings(req.tenantFilter || {});
  const initialPaymentOptions = await applyCustomerRtoToPaymentOptions(buildPaymentOptions(settings, {
    razorpayConfigured: isRazorpayConfigured(), pincode: req.body?.shippingAddress?.pincode,
  }), { userId: req.user?._id, settings, tenantFilter: req.tenantFilter });
  const paymentOptions = applyCustomerRestrictionsToPaymentOptions(initialPaymentOptions, customerRestrictions);

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
    tenantFilter: req.tenantFilter,
  });

  return res.json({
    paymentMethod: draft.paymentMethod,
    shipping: draft.shippingQuote,
    totals: draft.totals,
    items: draft.items,
    paymentOptions: applyCustomerRestrictionsToPaymentOptions(await applyCustomerRtoToPaymentOptions(buildPaymentOptions(settings, {
      razorpayConfigured: isRazorpayConfigured(),
      orderAmount: draft.totals.finalAmount - draft.totals.codCharge,
      pincode: req.body?.shippingAddress?.pincode,
    }), { userId: req.user?._id, settings, tenantFilter: req.tenantFilter }), customerRestrictions),
  });
});

/**
 * COD checkout. Order creation, stock deduction and coupon consumption are
 * applied together so we never end up with an order whose stock was never
 * taken, or stock taken for an order that failed to save.
 */
exports.createOrder = asyncHandler(async (req, res) => {
  assertCheckoutReady(req);
  await assertCustomerCanCheckout({ storeId: req.store?._id, userId: req.user?._id, paymentMethod: req.body?.paymentMethod || 'COD' });
  await assertMonthlyOrderCapacity(req.store);

  const shippingAddress = assertShippingAddress(req.body?.shippingAddress);
  const draft = await buildOrderDraft({
    orderItems: req.body?.orderItems,
    couponCode: req.body?.coupon?.code,
    paymentMethod: req.body?.paymentMethod || 'COD',
    userId: req.user?._id,
    shippingAddress,
    tenantFilter: req.tenantFilter,
  });

  require('../services/shippingRules').assertQuotedTotal(draft, req.body?.expectedTotal);
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
          paymentEvents: [{ state: 'PENDING', status: 'Pending', amount: draft.totals.finalAmount, source: 'CHECKOUT', note: draft.paymentMethod === 'COD' ? 'Payment due on delivery' : 'Awaiting online payment', date: new Date() }],
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

  logAudit({ req, action: 'ORDER_CREATE', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { orderStatus: order.orderStatus, paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod, finalAmount: order.finalAmount } });

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
    storeId: order.storeId,
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
  const filter = { user: req.user._id };
  if (req.query.status) filter.orderStatus = requireEnum(req.query.status, ORDER_STATUSES, 'status');
  const search = optionalString(req.query.search, 'search', { max: 100 });
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ 'orderItems.name': { $regex: escaped, $options: 'i' } }, { invoiceNumber: { $regex: escaped, $options: 'i' } }];
    if (/^[a-f\d]{24}$/i.test(search)) filter.$or.push({ _id: search });
    else if (/^[a-f\d]{6,23}$/i.test(search)) filter.$or.push({ $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: `${escaped}$`, options: 'i' } } });
  }
  if (req.query.days) {
    const days = Number(req.query.days);
    if (![30, 180, 365].includes(days)) throw new ApiError('VALIDATION_ERROR', 'Invalid order date filter');
    filter.createdAt = { $gte: new Date(Date.now() - days * 86400000) };
  }
  const paginated = wantsPagination(req.query);
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: paginated ? 12 : 200, maxLimit: 200 });
  const orders = await Order.find(filter).populate('shipment').sort('-createdAt').skip(skip).limit(limit);
  await Promise.all(orders.map((order) => syncPaidOnlineOrderStatus(order)));
  if (paginated) return res.json(buildPaginatedResponse(orders, { page, limit, total: await Order.countDocuments(filter) }));
  res.json(orders);
});

exports.getOrder = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  let query = Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter)).populate('user', 'name email phone').populate('shipment');
  if (managerRequest(req)) query = query.select('+staffNotes +paymentEvents');
  const order = await query;
  if (!order) throw notFound('Order not found');
  if (!isOwnerOrAdmin(order, req.user, req)) throw forbidden('Not allowed to view this order');
  await syncPaidOnlineOrderStatus(order);
  if (!managerRequest(req)) return res.json(order);
  const ReturnExchange = require('../models/ReturnExchange');
  const returnRequests = await ReturnExchange.find(andFilter({ order: order._id }, req.tenantFilter)).populate('product', 'name images sku').sort('-createdAt').lean();
  const hasOpenReturn = returnRequests.some(item => !['Rejected', 'Refunded', 'Exchanged', 'Closed'].includes(item.status));
  const canRecordRefund = returnRequests.some(item => item.status === 'Refunded' || item.resolutionStatus === 'Refunded');
  res.json({ ...decorateOrder(order, { hasOpenReturn, canRecordRefund }), returnRequests });
});

exports.adminOrders = asyncHandler(async (req, res) => {
  let filter = await adminOrderFilter(req.query, req.tenantFilter);
  if (req.query.deliveryStatus || req.query.deliveryIssue) {
    const Shipment = require('../models/Shipment');
    if (req.query.deliveryIssue && req.query.deliveryIssue !== '1') throw new ApiError('VALIDATION_ERROR', 'Choose a valid delivery issue filter.');
    const status = req.query.deliveryIssue ? null : requireEnum(req.query.deliveryStatus, Shipment.SHIPMENT_STATUSES, 'delivery status');
    const shipments = await Shipment.find(andFilter({ status: status || { $in: ['EXCEPTION', 'FAILED'] } }, req.tenantFilter)).select('_id').lean();
    const booked = { shipment: { $in: shipments.map(s => s._id) } };
    filter = andFilter(filter, status === 'WAITING' ? { $or: [booked, { shipment: null, orderStatus: { $in: ['Pending', 'Confirmed', 'Packed'] } }] } : booked);
  }
  const sort = { newest: { createdAt: -1, _id: -1 }, oldest: { createdAt: 1, _id: 1 }, dispatch_sla: { createdAt: 1, _id: 1 }, amount_high: { finalAmount: -1, createdAt: -1 }, amount_low: { finalAmount: 1, createdAt: -1 } }[req.query.sort || 'newest'];
  if (!sort) throw new ApiError('VALIDATION_ERROR', 'Choose a valid order sort.');
  const finder = () => Order.find(filter).populate('user', 'name email phone').populate('shipment', 'provider courierName status awb trackingNumber bookingState expectedDeliveryAt labelAvailable pickup operation').sort(sort);
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([
      finder().skip(skip).limit(limit),
      Order.countDocuments(filter),
    ]);
    return res.json({ ...buildPaginatedResponse(items.map(item => decorateOrder(item)), { page, limit, total }) });
  }
  const { limit, skip } = readPagination(req.query, { defaultLimit: 200, maxLimit: 500 });
  res.json((await finder().skip(skip).limit(limit)).map(item => decorateOrder(item)));
});

exports.orderWorkspaceSummary = asyncHandler(async (req, res) => {
  const Shipment = require('../models/Shipment');
  const ReturnExchange = require('../models/ReturnExchange');
  const { dashboardRange, periodFilter } = require('../services/dashboardAnalytics');
  const scope = filter => andFilter(filter, req.tenantFilter);
  const booked = { orderStatus: { $nin: ['Cancelled', 'Returned', 'Refunded'] }, $or: [{ paymentMethod: 'COD' }, { paymentStatus: 'Paid' }] };
  const today = periodFilter(dashboardRange({ range: 'today' }));
  const [pending, packing, todayPacking, dispatch, transit, exceptions, returns, codRows] = await Promise.all([
    Order.countDocuments(scope({ ...booked, orderStatus: 'Pending' })),
    Order.countDocuments(scope({ ...booked, orderStatus: 'Confirmed' })),
    Order.countDocuments(scope(andFilter({ ...booked, orderStatus: 'Confirmed' }, today))),
    Order.countDocuments(scope({ ...booked, orderStatus: 'Packed' })),
    Order.countDocuments(scope({ orderStatus: { $in: ['Shipped', 'Out for Delivery'] } })),
    Shipment.countDocuments(scope({ status: { $in: ['EXCEPTION', 'FAILED'] } })),
    ReturnExchange.countDocuments(scope({ status: { $in: ['Requested', 'Approved', 'Pickup Scheduled', 'Received'] } })),
    Order.aggregate([
      { $match: scope({ orderStatus: 'Delivered', paymentMethod: 'COD', paymentStatus: 'Pending' }) },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$finalAmount' } } },
    ]),
  ]);
  res.json({ pending, packing, todayPacking, dispatch, transit, exceptions, returns, codCollection: codRows[0]?.count || 0, codCollectionAmount: codRows[0]?.amount || 0 });
});

exports.addStaffNote = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const text = requireString(req.body?.text, 'note', { max: 1000 });
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter)).select('+staffNotes +paymentEvents');
  if (!order) throw notFound('Order not found');
  const expectedRevision = assertCurrentRevision(order, req.body?.revision);
  const entry = { text, author: actorSnapshot(req), date: new Date() };
  const updated = await Order.findOneAndUpdate(andFilter({ _id: order._id, ...revisionFilter(expectedRevision) }, req.tenantFilter), {
    $inc: { revision: 1 },
    $push: { staffNotes: { $each: [entry], $slice: -100 } },
  }, { new: true }).select('+staffNotes +paymentEvents').populate('user', 'name email phone').populate('shipment');
  if (!updated) throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
  logAudit({ req, action: 'ORDER_STAFF_NOTE_ADD', entityType: 'Order', entityId: updated._id, storeId: updated.storeId, after: { note: text }, summary: 'Private order note added' });
  res.json(decorateOrder(updated));
});

exports.updateShippingAddress = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const reason = requireString(req.body?.reason, 'reason', { max: 300 });
  const address = assertShippingAddress(req.body?.shippingAddress);
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter)).populate('shipment');
  if (!order) throw notFound('Order not found');
  const expectedRevision = assertCurrentRevision(order, req.body?.revision);
  if (!['Pending', 'Confirmed', 'Packed'].includes(order.orderStatus)) throw new ApiError('ORDER_TRANSITION_INVALID', 'The delivery address is locked after the parcel leaves the store.', { statusCode: 409 });
  if (order.shipment?.awb || ['BOOKING', 'BOOKED', 'UNKNOWN'].includes(order.shipment?.bookingState)) throw new ApiError('SHIPPING_VALIDATION', 'Cancel the uncollected courier booking before changing this address.');

  const settings = await getStoreSettings(req.tenantFilter || {});
  const merchandiseAmount = Math.max(0, Number(order.finalAmount || 0) - Number(order.deliveryCharge || 0) - Number(order.codCharge || 0) - Number(order.platformFee || 0) + Number(order.prepaidDiscount || 0));
  const quote = await require('../services/deliveryService').checkoutShipping({ items: order.orderItems, settings, address, paymentMethod: order.paymentMethod, amount: merchandiseAmount });
  if (Math.abs(Number(quote.deliveryCharge || 0) - Number(order.deliveryCharge || 0)) > 0.01) throw new ApiError('SHIPPING_QUOTE_CHANGED', 'This PIN code changes the agreed delivery charge. Cancel and place a corrected order instead of changing the customer total.', { statusCode: 409 });
  const before = order.shippingAddress;
  const updated = await Order.findOneAndUpdate(andFilter({ _id: order._id, ...revisionFilter(expectedRevision) }, req.tenantFilter), {
    $set: { shippingAddress: address, shippingQuote: quote },
    $inc: { revision: 1 },
    $push: { statusTimeline: { status: order.orderStatus, date: new Date(), note: `Delivery address corrected: ${reason}` } },
  }, { new: true }).select('+staffNotes +paymentEvents').populate('user', 'name email phone').populate('shipment');
  if (!updated) throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
  logAudit({ req, action: 'ORDER_ADDRESS_UPDATE', entityType: 'Order', entityId: updated._id, storeId: updated.storeId, before: { shippingAddress: before }, after: { shippingAddress: address }, summary: reason });
  res.json(decorateOrder(updated));
});

exports.updateOrderStatus = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const orderStatus = requireEnum(req.body?.orderStatus, ORDER_STATUSES, 'orderStatus');
  const note = optionalString(req.body?.note, 'note', { max: 300 });

  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  const expectedRevision = assertCurrentRevision(order, req.body?.revision);
  const shipment = await require('../models/Shipment').findOne({ order: order._id });

  if (orderStatus === 'Cancelled') {
    if (!canCancelOrder(order, shipment)) throw new ApiError('ORDER_NOT_CANCELLABLE', 'This order is already with the courier or completed. Use the return/RTO workflow instead of restoring stock through cancellation.');
    return res.json(decorateOrder(await cancelOrderInternal(order, { req, actor: req.user, note: note || 'Cancelled by staff', expectedRevision })));
  }
  const transition = assertOrderTransition(order, orderStatus, shipment);
  if (!transition.changed) return res.json(decorateOrder(order));
  const before = { orderStatus: order.orderStatus, codConfirmationStatus: order.codConfirmationStatus };
  const now = new Date();
  const set = { orderStatus };
  if (order.paymentMethod === 'COD' && order.codConfirmationStatus === 'PENDING' && orderStatus === 'Confirmed') set.codConfirmationStatus = 'CONFIRMED';
  if (orderStatus === 'Delivered') set.deliveredAt = order.deliveredAt || now;
  const updated = await Order.findOneAndUpdate(andFilter({
    _id: order._id,
    orderStatus: order.orderStatus,
    ...revisionFilter(expectedRevision),
  }, req.tenantFilter), {
    $set: set,
    $inc: { revision: 1 },
    $push: { statusTimeline: { status: orderStatus, date: now, note: note || `Marked ${orderStatus} by staff` } },
  }, { new: true });
  if (!updated) throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });

  logAudit({ req, action: 'ORDER_STATUS_UPDATE', entityType: 'Order', entityId: updated._id, storeId: updated.storeId, before, after: { orderStatus: updated.orderStatus, codConfirmationStatus: updated.codConfirmationStatus }, summary: note || `Order moved to ${orderStatus}` });

  if (toShipmentStatus(orderStatus)) {
    await upsertShipmentForOrder(updated, { status: toShipmentStatus(orderStatus), note: note || `Order marked ${orderStatus}` }).catch(() => null);
  }

  if (orderStatus === 'Delivered') {
    notifyLater({
      userId: updated.user,
      storeId: updated.storeId,
      event: 'ORDER_DELIVERED',
      title: 'Order delivered',
      message: 'Your order has been delivered. You can now rate products or request a return.',
      metadata: { orderId: String(updated._id) },
    });
  }

  const populated = await Order.findById(updated._id).populate('shipment', 'provider courierName status awb trackingNumber bookingState expectedDeliveryAt');
  res.json(decorateOrder(populated));
});

exports.updatePaymentStatus = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const paymentStatus = requireEnum(req.body?.paymentStatus, PAYMENT_STATUSES, 'paymentStatus');
  const note = optionalString(req.body?.note, 'note', { max: 500 });
  const reference = optionalString(req.body?.reference, 'reference', { max: 120 });
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter)).select('+paymentEvents');
  if (!order) throw notFound('Order not found');
  const expectedRevision = assertCurrentRevision(order, req.body?.revision);
  if (order.paymentStatus === paymentStatus) return res.json(decorateOrder(order));
  if (order.paymentMethod !== 'COD') throw new ApiError('PAYMENT_MANAGED_BY_PROVIDER', 'Online payment status is controlled by the payment provider. Reconcile it from Razorpay instead of changing it manually.', { statusCode: 409 });
  if (!MANUAL_PAYMENT_TRANSITIONS[order.paymentStatus]?.includes(paymentStatus)) throw new ApiError('PAYMENT_TRANSITION_INVALID', `A COD payment cannot move from ${order.paymentStatus} to ${paymentStatus}.`, { statusCode: 409 });
  if (!note) throw new ApiError('VALIDATION_ERROR', 'Add a payment note so this financial change has a clear audit record.');
  if (paymentStatus === 'Paid' && order.orderStatus !== 'Delivered') throw new ApiError('PAYMENT_TRANSITION_INVALID', 'Record COD collection after the order is delivered.', { statusCode: 409 });

  let refundAmount = 0;
  let paymentState = paymentStatus === 'Paid' ? 'PAID' : 'REFUNDED';
  let resultingPaymentStatus = paymentStatus;
  if (paymentStatus === 'Refunded') {
    const ReturnExchange = require('../models/ReturnExchange');
    const completedReturn = await ReturnExchange.exists(andFilter({ order: order._id, $or: [{ status: 'Refunded' }, { resolutionStatus: 'Refunded' }] }, req.tenantFilter));
    if (!completedReturn) throw new ApiError('PAYMENT_TRANSITION_INVALID', 'Complete the approved return refund step before recording money returned to the customer.', { statusCode: 409 });
    const remaining = Math.round(Math.max(0, Number(order.finalAmount || 0) - Number(order.refundedAmount || 0)) * 100) / 100;
    refundAmount = Math.round(Number(req.body?.amount) * 100) / 100;
    if (!Number.isFinite(refundAmount) || refundAmount < 0.01 || refundAmount > remaining) throw new ApiError('VALIDATION_ERROR', `Enter a refund amount between Rs. 0.01 and Rs. ${remaining.toFixed(2)}.`);
    const completesRefund = refundAmount >= remaining;
    paymentState = completesRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    resultingPaymentStatus = completesRefund ? 'Refunded' : 'Paid';
  }
  const now = new Date();
  const mutation = {
    $set: { paymentStatus: resultingPaymentStatus, paymentState, ...(paymentStatus === 'Refunded' ? { refundedAmount: Number(order.refundedAmount || 0) + refundAmount } : {}) },
    $inc: { revision: 1 },
    $push: {
      paymentEvents: {
        state: paymentState, status: paymentStatus, amount: paymentStatus === 'Refunded' ? refundAmount : Number(order.finalAmount || 0), reference,
        note, source: 'MANUAL', actor: actorSnapshot(req), date: now,
      },
    },
  };
  if (paymentStatus === 'Refunded') mutation.$push.refunds = { providerRefundId: reference || `manual-${order._id}-${expectedRevision + 1}`, provider: 'manual', amount: refundAmount, currency: 'INR', status: 'PROCESSED', note, processedAt: now };
  const paymentFilter = paymentStatus === 'Refunded'
    ? { $and: [
      { _id: order._id, paymentStatus: order.paymentStatus },
      revisionFilter(expectedRevision),
      Number(order.refundedAmount || 0) === 0 ? { $or: [{ refundedAmount: 0 }, { refundedAmount: { $exists: false } }] } : { refundedAmount: Number(order.refundedAmount) },
    ] }
    : { _id: order._id, paymentStatus: order.paymentStatus, ...revisionFilter(expectedRevision) };
  const updated = await Order.findOneAndUpdate(andFilter(paymentFilter, req.tenantFilter), mutation, { new: true }).select('+paymentEvents');
  if (!updated) throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
  logAudit({ req, action: paymentStatus === 'Paid' ? 'COD_PAYMENT_COLLECTED' : 'COD_REFUND_RECORDED', entityType: 'Order', entityId: updated._id, storeId: updated.storeId, before: { paymentStatus: order.paymentStatus, paymentState: order.paymentState, refundedAmount: order.refundedAmount || 0 }, after: { paymentStatus: resultingPaymentStatus, paymentState, refundedAmount: updated.refundedAmount || 0, refundAmount, reference }, summary: note });
  res.json(decorateOrder(updated, { canRecordRefund: paymentStatus === 'Refunded' && resultingPaymentStatus === 'Paid' }));
});

/**
 * Orders are financial history, so they are cancelled rather than deleted.
 */
exports.deleteOrder = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');

  if (order.orderStatus === 'Cancelled') {
    return res.json({ success: true, message: 'Order is already cancelled', order });
  }
  const shipment = await require('../models/Shipment').findOne({ order: order._id });
  if (!canCancelOrder(order, shipment)) throw new ApiError('ORDER_NOT_CANCELLABLE', 'This order is already with the courier or completed. Use the return/RTO workflow instead.');
  const cancelled = await cancelOrderInternal(order, { req, actor: req.user, note: 'Cancelled by staff' });
  res.json({ success: true, message: 'Order cancelled', order: cancelled });
});

exports.cancelOrder = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'order id');
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  if (!isOwnerOrAdmin(order, req.user, req)) throw forbidden('Not allowed');

  const reason = optionalString(req.body?.reason, 'reason', { max: 300 });
  const note = `${req.user.role === 'admin' ? 'Cancelled by admin' : 'Cancelled by customer'}${reason ? `: ${reason}` : ''}`;
  res.json(await cancelOrderInternal(order, { req, actor: req.user, note }));
});

/**
 * Cancellation is idempotent.
 *
 * Stock restore and coupon release are each claimed with a conditional update,
 * so calling this twice cannot restock twice or hand back two redemptions.
 *
 * A parcel that has left the store is handled through RTO/return workflows;
 * cancellation never restores stock after carrier handoff.
 */
async function cancelOrderInternal(order, { req, actor, note, source, expectedRevision }) {
  const delivery = require('../services/deliveryService');
  return delivery.withOrderLock(order._id, async freshOrder => {
    if (expectedRevision !== undefined && Number(freshOrder.revision || 0) !== Number(expectedRevision)) {
      throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
    }
    await delivery.cancelBooking(freshOrder);
    return cancelAfterCourier(freshOrder, { req, actor, note, source, expectedRevision });
  });
}

async function cancelAfterCourier(order, { req, actor, note, source, expectedRevision }) {
  if (order.orderStatus === 'Cancelled') return order;

  const allowed = CANCELLABLE_STATUSES;

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
      { _id: order._id, orderStatus: { $ne: 'Cancelled' }, ...(expectedRevision === undefined ? {} : revisionFilter(expectedRevision)) },
      {
        $set: { orderStatus: 'Cancelled', ...(order.paymentMethod === 'COD' && order.codConfirmationStatus === 'PENDING' ? { codConfirmationStatus: 'CANCELLED' } : {}) },
        $inc: { revision: 1 },
        $push: { statusTimeline: { status: 'Cancelled', date: new Date(), note } },
      },
      { new: true, session },
    );

    if (!updated && expectedRevision !== undefined) {
      const current = await Order.findById(order._id).session(session || null);
      if (current?.orderStatus !== 'Cancelled') throw new ApiError('ORDER_CHANGED', 'This order changed in another session. Reload it before continuing.', { statusCode: 409 });
      return { changed: false, order: current };
    }
    return { changed: Boolean(updated), order: updated || await Order.findById(order._id).session(session || null) };
  }).then((result) => {
    if (result.changed) logAudit({ req: req || { user: actor }, source, action: 'ORDER_CANCEL', entityType: 'Order', entityId: order._id, before: { orderStatus: order.orderStatus }, after: { orderStatus: 'Cancelled' }, storeId: order.storeId });
    if (result.changed) notifyLater({
      userId: result.order.user, storeId: result.order.storeId, event: 'ORDER_CANCELLED',
      title: 'Order cancelled', message: 'Your order has been cancelled. Check order details for payment and refund updates.',
      metadata: { orderId: String(result.order._id) },
    });
    return result.order;
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
  let settings = order.invoiceSeller?.storeName || order.invoiceSeller?.legalBusinessName
    ? order.invoiceSeller
    : await Settings.findOne(order.storeId ? { storeId: order.storeId } : { storeId: null }).lean();
  if (!settings && order.storeId) {
    const store = await require('../models/Store').findById(order.storeId).select('name legalName supportEmail supportPhone whatsappNumber isDefault').lean();
    if (store?.isDefault) settings = await Settings.findOne({ storeId: null }).lean();
    if (!settings && store) settings = { storeName: store.name, legalBusinessName: store.legalName, contactEmail: store.supportEmail, contactPhone: store.supportPhone, whatsappNumber: store.whatsappNumber };
  }
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
    platformFee: order.platformFee || 0,
    prepaidDiscount: order.prepaidDiscount || 0,
    taxAmount: order.taxAmount || 0,
    taxRate: order.taxRate || 0,
    finalAmount: order.finalAmount,
    coupon: order.coupon,
    razorpayOrderId: order.razorpayOrderId,
    razorpayPaymentId: order.razorpayPaymentId,
    paymentFailureReason: order.paymentFailureReason,
    refundedAmount: order.refundedAmount || 0,
    refunds: order.refunds || [],
    invoiceNumber: order.invoiceNumber,
    invoiceDate: order.invoiceDate,
    billingAddress: order.billingAddress,
    shipment: order.shipment,
    storeDetails: {
      logoUrl: settings?.logoUrl,
      invoiceNote: settings?.invoiceNote,
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
  const order = await Order.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!order) throw notFound('Order not found');
  const shipment = await upsertShipmentForOrder(order, {
    courierName: optionalString(req.body?.courierName, 'courierName', { max: 80 }) || undefined,
    trackingNumber: optionalString(req.body?.trackingNumber, 'trackingNumber', { max: 80 }) || undefined,
    trackingUrl: optionalString(req.body?.trackingUrl, 'trackingUrl', { max: 500 }) || undefined,
    awb: optionalString(req.body?.awb, 'awb', { max: 80 }) || undefined,
    status: req.body?.status,
    note: optionalString(req.body?.note, 'note', { max: 300 }) || 'Shipment updated by admin',
  });
  logAudit({ req, action: 'SHIPMENT_UPDATE', entityType: 'Order', entityId: order._id, storeId: order.storeId, after: { status: shipment.status, courierName: shipment.courierName, trackingNumber: shipment.trackingNumber } });
  res.json(shipment);
});

exports.assertCheckoutReady = assertCheckoutReady;
exports.assertShippingAddress = assertShippingAddress;
exports.cancelOrderInternal = cancelOrderInternal;
