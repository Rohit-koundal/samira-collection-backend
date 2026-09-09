const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const ReturnExchange = require('../models/ReturnExchange');
const { asyncHandler } = require('../middleware/validate');
const { requireObjectId } = require('../utils/validators');
const { ApiError, notFound, forbidden } = require('../utils/apiError');
const { andFilter } = require('../services/storeService');
const { getStoreSettings } = require('../services/paymentSettingsService');
const { getShippingProvider, getShippingProviders, providerLabel } = require('../services/shippingProvider');
const delivery = require('../services/deliveryService');
const { packageForItems } = require('../services/shippingRules');
const { logAudit } = require('../services/auditService');

async function context(req) {
  requireObjectId(req.params.id, req.deliveryReturn ? 'return id' : 'order id');
  const returnRequest = req.deliveryReturn ? await ReturnExchange.findOne(andFilter({ _id: req.params.id }, req.tenantFilter)) : null;
  if (req.deliveryReturn && !returnRequest) throw notFound('Return request not found');
  const order = await Order.findOne(andFilter({ _id: returnRequest ? returnRequest.order : req.params.id }, req.tenantFilter)).populate('shipment');
  if (!order) throw notFound('Order not found');
  const admin = req.user.role === 'admin' || (req.storeMember && String(req.store?._id) === String(order.storeId));
  if (!admin && String(order.user) !== String(req.user._id)) throw forbidden('Not allowed to view this shipment');
  return { order, returnRequest, admin };
}
exports.readiness = asyncHandler(async (req, res) => {
  const settings = await getStoreSettings(req.tenantFilter || {});
  const selected = getShippingProvider(settings.shippingProvider || 'manual');
  // The top-level selected fields preserve the existing seller endpoint shape;
  // Settings also receives the full provider list for its connection cards.
  res.set('Cache-Control', 'private, no-store').json({ ...selected, selected, providers: getShippingProviders(selected.name) });
});
exports.details = asyncHandler(async (req, res) => {
  const { order, returnRequest, admin } = await context(req);
  let booking = await delivery.findBooking(order, returnRequest);
  let warning = '';
  if (req.query.refresh === '1' && booking) {
    try { booking = await delivery.syncBooking(booking, returnRequest ? Shipment.ReverseShipment : Shipment); }
    catch { warning = 'Latest courier updates are unavailable. Showing the last confirmed status.'; }
  }
  const settings = admin ? await getStoreSettings(req.tenantFilter || {}) : {};
  let parcel;
  if (admin) { try { parcel = order.shippingQuote?.parcel || packageForItems(order.orderItems, settings); } catch { parcel = null; } }
  const data = { shipment: delivery.publicShipment(booking), warning };
  if (!returnRequest && req.query.refresh === '1') data.order = await Order.findById(order._id).select('orderStatus statusTimeline deliveredAt').lean();
  if (admin) Object.assign(data, { readiness: getShippingProvider(booking?.provider || settings.shippingProvider || 'manual'), selectedProvider: getShippingProvider(settings.shippingProvider || 'manual'), providers: getShippingProviders(settings.shippingProvider || 'manual'), parcel, pickupAddress: settings.shippingPickup, reverse: !!returnRequest });
  else if (data.shipment) {
    for (const key of ['operation', 'operationStartedAt', 'lastError', 'providerCharge', 'providerRef', 'service', 'pickup']) delete data.shipment[key];
  }
  res.set('Cache-Control', 'private, no-store').json(data);
});
exports.action = asyncHandler(async (req, res) => {
  const { order, returnRequest, admin } = await context(req);
  if (!admin) throw forbidden();
  const action = req.params.action;
  if (!['book', 'pickup', 'cancel', 'reconcile'].includes(action)) throw new ApiError('VALIDATION_ERROR', 'Unsupported delivery action');
  const shipment = action === 'book' ? await delivery.createBooking(order, req.body || {}, returnRequest)
    : action === 'pickup' ? await delivery.schedulePickup(order, req.body || {}, returnRequest)
      : action === 'cancel' ? await delivery.withOrderLock(order._id, () => delivery.cancelBooking(order, returnRequest))
        : await delivery.reconcile(order, req.body || {}, returnRequest);
  logAudit({ req, action: `SHIPPING_${action.toUpperCase()}`, entityType: returnRequest ? 'ReturnExchange' : 'Order', entityId: returnRequest?._id || order._id, storeId: order.storeId, after: { shipmentId: shipment?._id, awb: shipment?.awb, status: shipment?.status, provider: shipment?.provider } });
  res.json({ shipment });
});
exports.label = asyncHandler(async (req, res) => {
  const { order, returnRequest, admin } = await context(req);
  if (!admin) throw forbidden();
  const Model = returnRequest ? Shipment.ReverseShipment : Shipment;
  const booking = await Model.findOne(returnRequest ? { returnRequest: returnRequest._id } : { order: order._id }).select('+labelPdf');
  if (!booking?.labelPdf || booking.labelPdf.subarray(0, 5).toString() !== '%PDF-') throw notFound(`The carrier label is not available. Use the original label from your ${booking?.courierName || providerLabel(booking?.provider)} account; do not rebook the shipment to get another label.`);
  if (booking.status === 'CANCELLED') throw new ApiError('SHIPPING_VALIDATION', 'A cancelled shipping label must not be used.');
  // JSON uses the existing authenticated API client, including token renewal;
  // the PDF is never exposed through a public URL or a token in a query string.
  const carrier = String(booking.courierName || providerLabel(booking.provider)).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'Courier';
  res.set('Cache-Control', 'private, no-store').json({ filename: `${carrier}-${booking.awb}.pdf`, mimeType: 'application/pdf', base64: booking.labelPdf.toString('base64') });
});
