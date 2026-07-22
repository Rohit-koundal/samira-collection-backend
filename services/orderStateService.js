const ORDER_TRANSITIONS = Object.freeze({
  Pending: ['Confirmed', 'Cancelled'],
  Confirmed: ['Packed', 'Cancelled'],
  Packed: ['Shipped', 'Cancelled'],
  Shipped: ['Out for Delivery', 'Delivery Failed', 'Returned'],
  'Out for Delivery': ['Delivered', 'Delivery Failed'],
  'Delivery Failed': ['Shipped', 'Returned', 'Cancelled'],
  Delivered: ['Return Requested', 'Exchange Requested'],
  'Return Requested': ['Return Approved', 'Return Rejected'],
  'Exchange Requested': ['Return Approved', 'Return Rejected'],
  'Return Approved': ['Returned'],
  'Return Rejected': [],
  Returned: ['Refunded'],
  Cancelled: [],
  Refunded: [],
});

function canTransitionOrder(currentStatus, nextStatus) {
  if (currentStatus === nextStatus) return true;
  return (ORDER_TRANSITIONS[currentStatus] || []).includes(nextStatus);
}

function assertOrderTransition(currentStatus, nextStatus) {
  if (!ORDER_TRANSITIONS[currentStatus]) {
    const error = new Error('Current order status is invalid');
    error.statusCode = 409;
    error.code = 'INVALID_CURRENT_ORDER_STATUS';
    throw error;
  }
  if (!ORDER_TRANSITIONS[nextStatus]) {
    const error = new Error('Requested order status is invalid');
    error.statusCode = 400;
    error.code = 'INVALID_ORDER_STATUS';
    throw error;
  }
  if (!canTransitionOrder(currentStatus, nextStatus)) {
    const error = new Error(`Order cannot transition from ${currentStatus} to ${nextStatus}`);
    error.statusCode = 409;
    error.code = 'INVALID_ORDER_TRANSITION';
    throw error;
  }
}

module.exports = {
  ORDER_TRANSITIONS,
  canTransitionOrder,
  assertOrderTransition,
};
