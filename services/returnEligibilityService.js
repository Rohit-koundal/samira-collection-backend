const POST_DELIVERY = ['Delivered', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'];
function deliveryDate(order) {
  const value = order.deliveredAt || [...(order.statusTimeline || [])].reverse().find((entry) => entry.status === 'Delivered')?.date;
  return value && Number.isFinite(new Date(value).getTime()) ? new Date(value) : null;
}
function matchesItem(request, item) {
  if (request.orderItemId) return String(request.orderItemId) === String(item._id);
  return String(request.product?._id || request.product) === String(item.product?._id || item.product)
    && String(request.variantId || '') === String(item.variantId || '')
    && (!request.size || request.size === item.size)
    && (!request.color || request.color === item.color);
}
function returnEligibility(order, requests, windowDays, now = Date.now()) {
  const delivered = deliveryDate(order);
  const days = Math.max(0, Number(windowDays ?? 7));
  const deadline = delivered && days > 0 ? new Date(delivered.getTime() + days * 86400000) : null;
  const eligibleStatus = POST_DELIVERY.includes(order.orderStatus) && (order.orderStatus === 'Delivered' || !!delivered || requests.length > 0);
  const expired = deadline && now > deadline.getTime();
  const items = (order.orderItems || []).map((item) => {
    const used = requests.filter((request) => request.status !== 'Rejected' && matchesItem(request, item))
      .reduce((sum, request) => sum + Math.max(1, Number(request.quantity || 1)), 0);
    const remainingQuantity = Math.max(0, Number(item.quantity || 0) - used);
    const reason = !eligibleStatus ? 'Available after delivery.' : expired ? 'The return window has closed.'
      : !remainingQuantity ? 'A request already covers this item.' : '';
    return { orderItemId: String(item._id), remainingQuantity, canRequest: !reason, reason };
  });
  return { windowDays: days, deliveredAt: delivered, deadline, items };
}
function returnOrderStatus(order, requests) {
  const active = requests.filter((request) => ['Requested', 'Approved', 'Pickup Scheduled', 'Received'].includes(request.status));
  if (active.length) return active.some((request) => request.type === 'return') ? 'Return Requested' : 'Exchange Requested';
  const allCovered = (predicate) => (order.orderItems || []).length > 0 && order.orderItems.every((item) => (
    requests.filter((request) => matchesItem(request, item) && predicate(request)).reduce((sum, request) => sum + Number(request.quantity || 1), 0) >= Number(item.quantity || 1)
  ));
  if (allCovered((request) => request.status === 'Refunded' || request.resolutionStatus === 'Refunded')) return 'Refunded';
  if (allCovered((request) => request.type === 'return' && request.inventoryRestored)) return 'Returned';
  return 'Delivered';
}
module.exports = { returnEligibility, matchesItem, returnOrderStatus };
