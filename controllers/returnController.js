const ReturnExchange = require('../models/ReturnExchange');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, notFound } = require('../utils/apiError');
const { optionalString, readPagination, requireEnum, requireObjectId, requireQuantity, requireString } = require('../utils/validators');
const { getStoreSettings } = require('../services/paymentSettingsService');
const inventoryService = require('../services/inventoryService');
const { availableStock, hasManagedVariants, requireVariant, variantId } = require('../services/variantService');
const { notifyLater } = require('../services/notificationService');
const { recordEventLater } = require('../services/analyticsService');
const { returnEligibility, returnOrderStatus } = require('../services/returnEligibilityService');

const RETURN_STATUSES = require('../models/ReturnExchange').RETURN_STATUSES;
const STOCK_RESTORE_STATUSES = ['Received', 'Exchanged', 'Refunded'];

function findOrderItem(order, { productId, variantId, size, color, orderItemId }) {
  const items = order.orderItems || [];
  if (orderItemId) {
    const byId = items.id?.(orderItemId) || items.find((item) => String(item._id) === String(orderItemId));
    return byId && String(byId.product) === String(productId) ? byId : null;
  }
  return items.find((item) => {
    if (String(item.product) !== String(productId)) return false;
    if (variantId && item.variantId && String(item.variantId) !== String(variantId)) return false;
    if (size && item.size && String(item.size) !== String(size)) return false;
    if (color && item.color && String(item.color) !== String(color)) return false;
    return true;
  });
}

function readPhotos(value) {
  const list = Array.isArray(value) ? value : [];
  return list.map((url) => String(url || '').trim()).filter((url) => /^https?:\/\//i.test(url) || url.startsWith('/uploads/')).slice(0, 5);
}

exports.createReturn = asyncHandler(async (req, res) => {
  const orderId = requireObjectId(req.body?.order, 'order id');
  const productId = requireObjectId(req.body?.product, 'product id');
  const type = requireEnum(req.body?.type, ['return', 'exchange'], 'type');
  const reason = requireString(req.body?.reason, 'reason', { max: 300 });
  const comment = optionalString(req.body?.comment, 'comment', { max: 2000 });
  const quantity = requireQuantity(req.body?.quantity ?? 1, 'quantity', { min: 1, max: 20 });
  const photos = readPhotos(req.body?.photos);

  const order = await Order.findOne({ _id: orderId, user: req.user._id });
  if (!order) throw notFound('Order not found');
  if (!['Delivered', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'].includes(order.orderStatus)) {
    throw new ApiError('VALIDATION_ERROR', 'Returns can only be requested once the order is delivered');
  }

  const orderedItem = findOrderItem(order, {
    productId,
    variantId: req.body?.variantId,
    size: req.body?.size,
    color: req.body?.color,
    orderItemId: req.body?.orderItemId,
  });
  if (!orderedItem) throw new ApiError('VALIDATION_ERROR', 'That product is not part of this order');

  const settings = await getStoreSettings();
  const prior = await ReturnExchange.find({ order: orderId });
  const eligibility = returnEligibility(order, prior, settings.returnWindowDays);
  const itemEligibility = eligibility.items.find((item) => item.orderItemId === String(orderedItem._id));
  if (eligibility.deadline && Date.now() > new Date(eligibility.deadline).getTime()) {
    throw new ApiError('RETURN_WINDOW_EXPIRED', `The ${eligibility.windowDays}-day return window for this order has closed`);
  }
  const remaining = itemEligibility?.remainingQuantity || 0;
  if (quantity > remaining) {
    throw new ApiError(
      remaining ? 'VALIDATION_ERROR' : 'DUPLICATE_REQUEST',
      remaining
        ? `Only ${remaining} unit(s) can still be returned for this item`
        : 'A request for this item is already in progress',
    );
  }
  if (!itemEligibility.canRequest) throw new ApiError('VALIDATION_ERROR', itemEligibility.reason);

  let exchangeVariantId = '';
  let exchangeSize = optionalString(req.body?.exchangeSize, 'exchangeSize', { max: 40 });
  let exchangeColor = optionalString(req.body?.exchangeColor, 'exchangeColor', { max: 40 });
  if (type === 'exchange') {
    const product = await Product.findById(productId);
    if (!product) throw notFound('Product not found');
    if (product.isActive === false || product.isArchived) throw new ApiError('OUT_OF_STOCK', 'This product is unavailable for exchange');
    if (hasManagedVariants(product)) {
      const variant = requireVariant(product, {
        variantId: req.body?.exchangeVariantId,
        size: exchangeSize || orderedItem.size,
        color: exchangeColor || orderedItem.color,
      });
      if (availableStock(product, { variantId: variantId(variant) }) < quantity) {
        throw new ApiError('OUT_OF_STOCK', 'The requested exchange size or colour is not in stock');
      }
      exchangeVariantId = variantId(variant);
      exchangeSize = variant.size;
      exchangeColor = variant.color;
    } else {
      if (availableStock(product) < quantity) throw new ApiError('OUT_OF_STOCK', 'This product is not in stock for exchange');
      exchangeSize = exchangeSize || orderedItem.size;
      exchangeColor = exchangeColor || orderedItem.color;
      if (product.sizes?.length && !product.sizes.includes(exchangeSize)) throw new ApiError('VARIANT_UNAVAILABLE', 'Choose an available exchange size');
      if (product.colors?.length && !product.colors.includes(exchangeColor)) throw new ApiError('VARIANT_UNAVAILABLE', 'Choose an available exchange colour');
    }
  }

  const created = await ReturnExchange.create({
    order: orderId,
    product: productId,
    user: req.user._id,
    orderItemId: String(orderedItem._id || ''),
    variantId: orderedItem.variantId || '',
    size: orderedItem.size || '',
    color: orderedItem.color || '',
    sku: orderedItem.sku || '',
    quantity,
    type,
    reason,
    comment,
    photos,
    exchangeVariantId,
    exchangeSize,
    exchangeColor,
    status: 'Requested',
    storeId: order.storeId,
  });

  order.orderStatus = type === 'exchange' ? 'Exchange Requested' : 'Return Requested';
  order.statusTimeline.push({
    status: order.orderStatus,
    date: new Date(),
    note: `${type} requested for ${orderedItem.name || 'item'}`,
  });
  await order.save();

  recordEventLater({
    name: 'RETURN_REQUESTED',
    storeId: order.storeId,
    userId: req.user._id,
    orderId: order._id,
    productId,
  });

  notifyLater({
    userId: req.user._id,
    storeId: order.storeId,
    event: 'RETURN_REQUESTED',
    title: type === 'exchange' ? 'Exchange requested' : 'Return requested',
    message: 'We have received your request and will update you after review.',
    metadata: { orderId: String(order._id), returnId: String(created._id) },
  });

  res.status(201).json(created);
});

exports.myReturns = asyncHandler(async (req, res) => {
  res.json(await ReturnExchange.find({ user: req.user._id }).populate('product', 'name images sku').sort('-createdAt').limit(200));
});

exports.orderReturns = asyncHandler(async (req, res) => {
  const orderId = requireObjectId(req.params.orderId, 'order id');
  const order = await Order.findOne({ _id: orderId, user: req.user._id });
  if (!order) throw notFound('Order not found');
  const [requests, settings] = await Promise.all([
    ReturnExchange.find({ order: orderId, user: req.user._id }).sort('-createdAt'), getStoreSettings(),
  ]);
  res.json({ requests, ...returnEligibility(order, requests, settings.returnWindowDays) });
});

exports.adminReturns = asyncHandler(async (req, res) => {
  const { andFilter } = require('../services/storeService');
  const { wantsPagination, buildPaginatedResponse } = require('../utils/validators');
  const extra = {};
  if (req.query.id) extra._id = requireObjectId(req.query.id, 'return id');
  const filter = andFilter(extra, req.tenantFilter);
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([
      ReturnExchange.find(filter).populate('user order product').sort('-createdAt').skip(skip).limit(limit),
      ReturnExchange.countDocuments(filter),
    ]);
    return res.json(buildPaginatedResponse(items, { page, limit, total }));
  }
  const { limit, skip } = readPagination(req.query, { defaultLimit: 200, maxLimit: 500 });
  res.json(await ReturnExchange.find(filter).populate('user order product').sort('-createdAt').skip(skip).limit(limit));
});

exports.updateReturnStatus = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'return id');
  const status = requireEnum(req.body?.status, RETURN_STATUSES, 'status');
  const adminComment = optionalString(req.body?.adminComment, 'adminComment', { max: 1000 });

  const request = await ReturnExchange.findById(req.params.id);
  if (!request) throw notFound('Return request not found');

  if (status === 'Pickup Scheduled') request.pickupScheduledAt = request.pickupScheduledAt || new Date();

  if (STOCK_RESTORE_STATUSES.includes(status) && !request.inventoryRestored) {
    await inventoryService.restoreStockForOrder([{
      product: request.product,
      quantity: request.quantity,
      variantId: request.variantId,
    }], {
      orderId: request.order,
      userId: req.user._id,
      type: 'RETURN',
      reason: `Return ${status.toLowerCase()}`,
    });
    request.inventoryRestored = true;
    request.inventoryRestoredAt = new Date();
  }

  if (status === 'Exchanged' && request.type === 'exchange' && !request.exchangeDeducted) {
    const product = await Product.findById(request.product);
    const selection = {
      product: request.product,
      quantity: request.quantity,
      variantId: request.exchangeVariantId,
      size: request.exchangeSize,
      color: request.exchangeColor,
    };
    if (product && hasManagedVariants(product) && !selection.variantId) {
      const variant = requireVariant(product, { size: request.exchangeSize, color: request.exchangeColor });
      selection.variantId = variantId(variant);
    }
    await inventoryService.deductStockForOrder([selection], {
      orderId: request.order,
      userId: req.user._id,
      reason: 'Exchange fulfilment',
    });
    request.exchangeDeducted = true;
  }

  if (['Refunded', 'Exchanged'].includes(request.status)) request.resolutionStatus = request.status;
  request.status = status;
  if (['Refunded', 'Exchanged'].includes(status)) request.resolutionStatus = status;
  if (adminComment) request.adminComment = adminComment;
  await request.save();

  const order = await Order.findById(request.order);
  if (order && order.orderStatus !== 'Cancelled') {
    const requests = await ReturnExchange.find({ order: request.order });
    order.orderStatus = returnOrderStatus(order, requests);
    order.statusTimeline.push({ status: order.orderStatus, date: new Date(), note: `${request.type === 'exchange' ? 'Exchange' : 'Return'} request marked ${status}` });
    await order.save();
  }

  notifyLater({
    userId: request.user,
    storeId: request.storeId,
    event: 'RETURN_UPDATED',
    title: `Return ${status.toLowerCase()}`,
    message: adminComment || `Your ${request.type} request is now ${status}.`,
    metadata: { returnId: String(request._id), orderId: String(request.order) },
  });

  res.json(request);
});

exports.RETURN_STATUSES = RETURN_STATUSES;
