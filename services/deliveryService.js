const { randomUUID } = require('crypto');
const Order = require('../models/Order');
const Shipment = require('../models/Shipment');
const { ReverseShipment } = Shipment;
const ReturnExchange = require('../models/ReturnExchange');
const { getStoreSettings } = require('./paymentSettingsService');
const { providerFor } = require('./shippingProvider');
const { packageForItems, deliveryPrice, pickupAddress, pickupSlot } = require('./shippingRules');
const { ApiError } = require('../utils/apiError');
const { notifyLater } = require('./notificationService');

const privateFields = '+pickupAddress +destination';
const conflict = message => new ApiError('DUPLICATE_REQUEST', message);
const terminal = ['DELIVERED', 'CANCELLED', 'RETURNED'];
async function assertCarrierStore(storeId, settings) {
  if (!storeId) return;
  const accountStore = settings.storeId || (await require('../models/Store').findOne({ isDefault: true }).select('_id').lean())?._id;
  if (!accountStore || String(accountStore) !== String(storeId)) throw new ApiError('SHIPPING_UNAVAILABLE', 'This store does not have a connected delivery account.', { statusCode: 503 });
}
function publicShipment(row) {
  if (!row) return null;
  const data = row.toObject ? row.toObject() : { ...row };
  for (const key of ['labelPdf', 'pickupAddress', 'destination', 'syncLeaseUntil']) delete data[key];
  return data;
}
async function checkoutShipping({ items, settings, address, paymentMethod, amount }) {
  const integrated = settings.shippingProvider === 'bluedart';
  const parcel = integrated || settings.shippingPricingMode === 'weight' ? packageForItems(items, settings) : null;
  const pricing = deliveryPrice(amount, address, parcel, settings);
  if (!integrated) return { provider: 'manual', deliveryCharge: pricing.charge, pricingSource: pricing.pricingSource, parcel };
  const adapter = providerFor(settings.shippingProvider), ready = adapter.readiness();
  await assertCarrierStore(items[0]?.storeId, settings);
  if (!ready.configured || !ready.liveBooking || ready.mode !== 'production') throw new ApiError('SHIPPING_UNAVAILABLE', 'Delivery setup is being completed. Please contact the store before placing your order.', { statusCode: 503 });
  const result = await adapter.serviceability({ origin: pickupAddress(settings.shippingPickup), destination: address || {}, cod: paymentMethod === 'COD' });
  return { ...result, destinationPincode: address.pincode, parcel, deliveryCharge: pricing.charge, pricingSource: pricing.pricingSource };
}
async function withOrderLock(orderId, action) {
  const key = randomUUID();
  const row = await Order.findOneAndUpdate({ _id: orderId, $or: [{ shippingOperation: '' }, { shippingOperation: { $exists: false } }, { shippingOperationUntil: { $lt: new Date() } }] }, { $set: { shippingOperation: key, shippingOperationUntil: new Date(Date.now() + 300000) } }, { new: true });
  if (!row) throw conflict('Another delivery action is in progress. Refresh before trying again.');
  try { return await action(row); }
  finally { await Order.updateOne({ _id: orderId, shippingOperation: key }, { $set: { shippingOperation: '' } }); }
}
function bookingModel(returnRequest) { return returnRequest ? ReverseShipment : Shipment; }
function bookingFilter(order, returnRequest) { return returnRequest ? { returnRequest: returnRequest._id } : { order: order._id }; }
async function findBooking(order, returnRequest) { return bookingModel(returnRequest).findOne(bookingFilter(order, returnRequest)).select(privateFields); }
function assertBookable(order, returnRequest) {
  if (returnRequest) {
    if (!['Approved', 'Pickup Scheduled'].includes(returnRequest.status)) throw new ApiError('SHIPPING_VALIDATION', 'Approve this return before arranging reverse pickup.');
  } else {
    if (!['Pending', 'Confirmed', 'Packed'].includes(order.orderStatus)) throw new ApiError('SHIPPING_VALIDATION', 'Only an unshipped, active order can be booked.');
    if (order.paymentMethod === 'COD' && order.codConfirmationStatus === 'PENDING') throw new ApiError('SHIPPING_VALIDATION', 'Confirm this COD order with the customer before booking delivery.');
    if (order.paymentMethod !== 'COD' && order.paymentStatus !== 'Paid') throw new ApiError('SHIPPING_VALIDATION', 'Online payment must be confirmed before booking delivery.');
    if (['Failed', 'Refunded'].includes(order.paymentStatus)) throw new ApiError('SHIPPING_VALIDATION', 'This order cannot be shipped with its current payment status.');
  }
}
async function createBooking(order, body, returnRequest) {
  return withOrderLock(order._id, async freshOrder => {
    assertBookable(freshOrder, returnRequest);
    const settings = await getStoreSettings();
    if (settings.shippingProvider !== 'bluedart') throw new ApiError('SHIPPING_VALIDATION', 'Select Blue Dart in delivery settings before booking.');
    const adapter = providerFor(settings.shippingProvider);
    await assertCarrierStore(order.storeId, settings);
    const ready = adapter.readiness();
    if (!ready.liveBooking) throw new ApiError('SHIPPING_UNAVAILABLE', ready.note, { statusCode: 503 });
    const Model = bookingModel(returnRequest), filter = bookingFilter(order, returnRequest);
    let existing = await findBooking(order, returnRequest);
    if (existing?.awb || existing?.bookingState === 'BOOKED') return publicShipment(existing);
    if (existing?.operation || ['BOOKING', 'UNKNOWN', 'CANCELLED'].includes(existing?.bookingState)) throw conflict('This shipment needs reconciliation before another booking. Use Check booking outcome.');
    const slot = pickupSlot(body.date, body.time, body.closeTime);
    const origin = returnRequest ? order.shippingAddress : pickupAddress(settings.shippingPickup);
    const destination = returnRequest ? pickupAddress(settings.shippingPickup) : order.shippingAddress;
    const items = returnRequest ? order.orderItems.filter(item => String(item._id) === returnRequest.orderItemId).map(item => ({ ...(item.toObject ? item.toObject() : item), quantity: returnRequest.quantity })) : order.orderItems;
    if (!items.length) throw new ApiError('SHIPPING_VALIDATION', 'The return item could not be matched to this order.');
    const parcel = packageForItems(items, settings, body.parcel);
    const checked = await adapter.serviceability({ origin, destination, cod: !returnRequest && order.paymentMethod === 'COD' && order.paymentStatus !== 'Paid', reverse: !!returnRequest });
    const providerRef = `${returnRequest ? 'R' : 'S'}${String(returnRequest?._id || order._id).slice(-19)}`;
    const base = { provider: 'bluedart', environment: ready.mode, courierName: 'Blue Dart', providerRef, parcel, pickupAddress: origin, destination, service: checked.service, pickup: { areaCode: checked.pickupArea }, status: 'WAITING', bookingState: 'IDLE' };
    if (!existing) existing = await Model.findOneAndUpdate(filter, { $setOnInsert: { ...filter, order: order._id, storeId: order.storeId, ...base } }, { upsert: true, new: true, setDefaultsOnInsert: true }).select(privateFields);
    if (returnRequest) await ReturnExchange.updateOne({ _id: returnRequest._id }, { $set: { shipment: existing._id } });
    else await Order.updateOne({ _id: order._id }, { $set: { shipment: existing._id } });
    const booking = await Model.findOneAndUpdate({ _id: existing._id, $and: [{ $or: [{ bookingState: { $in: ['IDLE', 'FAILED'] } }, { bookingState: { $exists: false } }] }, { $or: [{ operation: '' }, { operation: { $exists: false } }] }] }, { $set: { ...base, bookingState: 'BOOKING', operation: 'book', operationStartedAt: new Date(), lastError: '' } }, { new: true }).select(privateFields);
    if (!booking) throw conflict('This booking is already being processed. Refresh its status.');
    try {
      const carrierOrder = returnRequest ? { ...(order.toObject ? order.toObject() : order), finalAmount: Math.round(items.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0) * 100) / 100 } : order;
      const details = await adapter.book({ booking, order: carrierOrder, slot, reverse: !!returnRequest });
      // Persist the AWB independently of pickup so a failed pickup is never rebooked.
      Object.assign(booking, details, { trackingNumber: details.awb, bookingState: 'BOOKED', status: 'READY_TO_SHIP', labelAvailable: !!details.labelPdf, operation: '', nextSyncAt: new Date() });
      booking.events.push({ status: 'READY_TO_SHIP', note: 'Blue Dart AWB created. Pack and label the parcel, then request pickup.', date: new Date() });
      await booking.save();
      return publicShipment(booking);
    } catch (e) {
      const ambiguous = e.ambiguous || !(e instanceof ApiError);
      await Model.updateOne({ _id: booking._id }, { $set: { bookingState: ambiguous ? 'UNKNOWN' : 'FAILED', operation: '', lastError: ambiguous ? 'Booking outcome is uncertain. Check by reference before retrying; do not create a second shipment.' : e.message } });
      throw e instanceof ApiError ? e : conflict('The booking outcome needs reconciliation. Refresh the shipment and check its reference.');
    }
  });
}
async function schedulePickup(order, body, returnRequest) {
  return withOrderLock(order._id, async freshOrder => {
    assertBookable(freshOrder, returnRequest);
    const Model = bookingModel(returnRequest), current = await findBooking(order, returnRequest);
    if (!current || current.bookingState !== 'BOOKED') throw new ApiError('SHIPPING_VALIDATION', 'Create the shipment and download its label before requesting pickup.');
    if (current.pickup?.token && !current.pickup.cancelled) return publicShipment(current);
    if (current.operation) throw conflict('A pickup request is awaiting confirmation. Reconcile it before retrying.');
    if (!['READY_TO_SHIP', 'WAITING'].includes(current.status)) throw new ApiError('SHIPPING_VALIDATION', 'Pickup cannot be requested in this delivery state.');
    const slot = pickupSlot(body.date, body.time, body.closeTime);
    const booking = await Model.findOneAndUpdate({ _id: current._id, operation: '' }, { $set: { operation: 'pickup', operationStartedAt: new Date(), 'pickup.date': slot.date, 'pickup.time': slot.time, 'pickup.closeTime': slot.closeTime } }, { new: true }).select(privateFields);
    if (!booking) throw conflict('Pickup is already being requested.');
    try {
      const result = await providerFor(booking.provider).pickup({ booking, slot, reverse: !!returnRequest });
      booking.pickup = { ...booking.pickup.toObject(), ...result, cancelled: false };
      booking.operation = ''; booking.lastError = ''; booking.status = 'PICKUP_SCHEDULED';
      booking.events.push({ status: booking.status, note: 'Blue Dart confirmed the pickup request.', date: new Date() });
      await booking.save();
      if (returnRequest) await ReturnExchange.updateOne({ _id: returnRequest._id, status: 'Approved' }, { $set: { status: 'Pickup Scheduled', pickupScheduledAt: slot.at } });
      return publicShipment(booking);
    } catch (e) {
      const uncertain = e.ambiguous || !(e instanceof ApiError);
      await Model.updateOne({ _id: booking._id }, { $set: { operation: uncertain ? 'pickup-unknown' : '', lastError: uncertain ? 'Pickup outcome is uncertain. Confirm the existing request with Blue Dart before retrying.' : e.message } });
      throw e instanceof ApiError ? e : conflict('Pickup needs reconciliation. Do not request another pickup yet.');
    }
  });
}
async function cancelBooking(order, returnRequest) {
  const booking = await findBooking(order, returnRequest);
  if (!booking || booking.provider === 'manual') return null;
  if (booking.bookingState === 'CANCELLED') return publicShipment(booking);
  if (booking.operation || ['UNKNOWN', 'BOOKING'].includes(booking.bookingState)) throw conflict('Check the outstanding courier request before cancelling this order.');
  if (!['WAITING', 'READY_TO_SHIP', 'PICKUP_SCHEDULED', 'FAILED'].includes(booking.status)) throw new ApiError('ORDER_NOT_CANCELLABLE', 'This parcel may already be with Blue Dart. Arrange a return instead of restoring stock through cancellation.');
  if (booking.awb) {
    booking.operation = 'cancel'; await booking.save();
    try {
      const adapter = providerFor(booking.provider);
      if (booking.pickup?.token && !booking.pickup.cancelled) {
        await adapter.cancelPickup({ booking });
        booking.pickup.cancelled = true; await booking.save();
      }
      await adapter.cancel({ booking });
    } catch (e) {
      booking.operation = e.ambiguous || !(e instanceof ApiError) ? 'cancel-unknown' : '';
      booking.lastError = 'Courier cancellation was not confirmed. The order and inventory have not been cancelled.';
      await booking.save();
      throw e;
    }
  }
  booking.bookingState = 'CANCELLED'; booking.status = 'CANCELLED'; booking.operation = ''; booking.lastError = '';
  booking.events.push({ status: 'CANCELLED', note: 'Courier booking cancelled.', date: new Date() });
  await booking.save();
  return publicShipment(booking);
}
async function reconcile(order, body, returnRequest) {
  return withOrderLock(order._id, async () => {
    const booking = await findBooking(order, returnRequest);
    if (!booking || booking.provider === 'manual') throw new ApiError('SHIPPING_VALIDATION', 'There is no Blue Dart booking to reconcile.');
    const adapter = providerFor(booking.provider);
    if (['BOOKING', 'UNKNOWN'].includes(booking.bookingState)) {
      if (booking.operationStartedAt && Date.now() - booking.operationStartedAt < 60000) throw conflict('The carrier request may still be running. Check again in a minute.');
      if (body.confirmedWithCarrier === true && body.confirmedNoRequest === true) {
        booking.bookingState = 'FAILED'; booking.operation = ''; booking.lastError = '';
        booking.events.push({ status: 'WAITING', note: 'Administrator confirmed with Blue Dart that no AWB exists for this reference. Booking retry unlocked.', date: new Date() });
        await booking.save();
        return publicShipment(booking);
      }
      const tracked = await adapter.track({ booking, byReference: true });
      booking.awb = tracked.awb; booking.trackingNumber = tracked.awb; booking.bookingState = 'BOOKED'; booking.operation = ''; booking.lastError = ''; booking.status = tracked.status || 'READY_TO_SHIP';
      booking.events.push({ status: booking.status, note: 'Existing AWB recovered using the booking reference.', date: new Date() });
      await booking.save();
    } else if (booking.operation) {
      // A tracking lookup cannot prove that no pickup/cancellation exists.
      // Require the administrator to record the result confirmed with Blue Dart.
      if (body.confirmedWithCarrier !== true) throw new ApiError('SHIPPING_VALIDATION', 'Confirm the existing pickup/cancellation outcome with Blue Dart before recording the result.');
      if (booking.operation === 'pickup-unknown' || booking.operation === 'pickup') {
        if (body.confirmedNoRequest === true) booking.status = 'READY_TO_SHIP';
        else {
          if (!/^\d{1,8}$/.test(String(body.pickupToken || ''))) throw new ApiError('SHIPPING_VALIDATION', 'Enter the pickup token confirmed by Blue Dart.');
          booking.pickup.token = String(body.pickupToken); booking.status = 'PICKUP_SCHEDULED';
        }
      } else if (booking.operation.startsWith('cancel')) {
        const checked = await adapter.track({ booking });
        if (checked.status !== 'CANCELLED') throw conflict('Blue Dart has not confirmed shipment cancellation yet.');
        booking.status = 'CANCELLED'; booking.bookingState = 'CANCELLED';
      }
      booking.operation = ''; booking.lastError = ''; await booking.save();
    }
    return publicShipment(booking);
  });
}
async function syncBooking(booking, Model = Shipment) {
  if (!booking?.awb || booking.provider === 'manual' || booking.bookingState !== 'BOOKED') return publicShipment(booking);
  const now = new Date();
  const leased = await Model.findOneAndUpdate({ _id: booking._id, $and: [ { $or: [{ lastSyncedAt: { $lt: new Date(Date.now() - 60000) } }, { lastSyncedAt: { $exists: false } }] }, { $or: [{ syncLeaseUntil: { $lt: now } }, { syncLeaseUntil: { $exists: false } }] } ] }, { $set: { syncLeaseUntil: new Date(Date.now() + 90000) } }, { new: true });
  if (!leased) return publicShipment(booking);
  try {
    const tracked = await providerFor(booking.provider).track({ booking: leased });
    const newer = tracked.providerStatusAt && (!leased.providerStatusAt || tracked.providerStatusAt >= leased.providerStatusAt);
    if (newer && !terminal.includes(leased.status)) {
      if (tracked.status) leased.status = tracked.status;
      leased.providerStatus = tracked.providerStatus; leased.providerStatusAt = tracked.providerStatusAt;
    }
    if (tracked.expectedDeliveryAt) leased.expectedDeliveryAt = tracked.expectedDeliveryAt;
    const keys = new Set(leased.events.map(e => `${e.date?.toISOString()}:${e.status}:${e.note}`));
    for (const event of tracked.events) if (!keys.has(`${event.date.toISOString()}:${event.status}:${event.note}`)) leased.events.push(event);
    leased.events = leased.events.sort((a, b) => a.date - b.date).slice(-250);
    leased.lastSyncedAt = now; leased.nextSyncAt = new Date(Date.now() + 15 * 60000); leased.syncLeaseUntil = new Date(0);
    if (!leased.operation) leased.lastError = '';
    await leased.save();
    if (!leased.returnRequest && leased.environment === 'production') {
      const mapped = { PICKED_UP: 'Shipped', SHIPPED: 'Shipped', IN_TRANSIT: 'Shipped', OUT_FOR_DELIVERY: 'Out for Delivery', DELIVERED: 'Delivered' }[leased.status];
      const prior = mapped && await Order.findOneAndUpdate({ _id: leased.order, orderStatus: { $in: mapped === 'Shipped' ? ['Pending', 'Confirmed', 'Packed'] : mapped === 'Out for Delivery' ? ['Pending', 'Confirmed', 'Packed', 'Shipped'] : ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery'] } }, { $set: { orderStatus: mapped, ...(mapped === 'Delivered' ? { deliveredAt: tracked.providerStatusAt || now } : {}) }, $push: { statusTimeline: { status: mapped, note: 'Confirmed by Blue Dart tracking', date: tracked.providerStatusAt || now } } }, { new: false });
      if (prior) notifyLater({ userId: prior.user, storeId: prior.storeId, event: mapped === 'Delivered' ? 'ORDER_DELIVERED' : mapped === 'Out for Delivery' ? 'ORDER_OUT_FOR_DELIVERY' : 'ORDER_SHIPPED', title: `Order ${mapped.toLowerCase()}`, message: `Blue Dart: ${tracked.providerStatus}`, metadata: { orderId: String(prior._id), shipmentId: String(leased._id) } });
    }
    // COD payment, refunds, reverse inspection and inventory are deliberately
    // handled by their existing financial/returns workflows, never scan text.
    return publicShipment(leased);
  } catch (e) {
    await Model.updateOne({ _id: leased._id }, { $set: { nextSyncAt: new Date(Date.now() + 15 * 60000), syncLeaseUntil: new Date(0), lastSyncedAt: now, lastError: 'Latest courier updates are temporarily unavailable. The last confirmed status is shown.' } });
    throw e;
  }
}
let worker;
function startDeliveryWorker() {
  if (worker) return;
  let active = false;
  const tick = async () => {
    if (active) return; active = true;
    try {
      for (const Model of [Shipment, ReverseShipment]) {
        const due = await Model.find({ provider: 'bluedart', bookingState: 'BOOKED', status: { $nin: terminal }, $or: [{ nextSyncAt: { $lte: new Date() } }, { nextSyncAt: { $exists: false } }] }).sort({ nextSyncAt: 1 }).limit(20);
        for (const booking of due) await syncBooking(booking, Model).catch(() => null);
      }
    } catch { /* Disconnected databases are retried on the next tick. */ }
    finally { active = false; }
  };
  worker = setInterval(tick, 60000); worker.unref();
}
module.exports = { checkoutShipping, createBooking, schedulePickup, cancelBooking, reconcile, syncBooking, findBooking, publicShipment, withOrderLock, startDeliveryWorker, assertBookable };
