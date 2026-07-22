const crypto = require('crypto');

function verifyRazorpaySignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature, secret }) {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  return timingSafeEqual(expected, razorpaySignature);
}

function verifyWebhookSignature({ rawBody, signature, secret }) {
  if (!Buffer.isBuffer(rawBody) || !signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(expected, supplied) {
  const expectedBuffer = Buffer.from(String(expected), 'utf8');
  const suppliedBuffer = Buffer.from(String(supplied), 'utf8');
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

const SHIPPING_FIELDS = [
  'fullName', 'name', 'mobile', 'phone', 'email', 'pincode', 'postalCode',
  'state', 'city', 'houseNo', 'addressLine1', 'addressLine2', 'area', 'landmark', 'country',
];

function sanitizeShippingAddress(address = {}) {
  if (!address || typeof address !== 'object' || Array.isArray(address)) {
    throw requestError('A shipping address is required', 'INVALID_SHIPPING_ADDRESS');
  }
  const sanitized = {};
  for (const field of SHIPPING_FIELDS) {
    if (address[field] === undefined || address[field] === null) continue;
    const value = String(address[field]).trim();
    if (value) sanitized[field] = value.slice(0, field === 'email' ? 254 : 200);
  }
  const recipient = sanitized.fullName || sanitized.name;
  const phone = sanitized.mobile || sanitized.phone;
  const pincode = sanitized.pincode || sanitized.postalCode;
  if (!recipient || !phone || !pincode || !sanitized.city || !sanitized.state) {
    throw requestError('Shipping address is incomplete', 'INVALID_SHIPPING_ADDRESS');
  }
  return sanitized;
}

function normalizePaymentMethod(value, { allowCod = false } = {}) {
  const normalized = String(value || (allowCod ? 'COD' : 'UPI')).trim().toUpperCase();
  const allowed = allowCod
    ? ['COD', 'UPI', 'CARD', 'NETBANKING', 'WALLET']
    : ['UPI', 'CARD', 'NETBANKING', 'WALLET'];
  if (!allowed.includes(normalized)) {
    throw requestError('Unsupported payment method', 'INVALID_PAYMENT_METHOD');
  }
  return normalized;
}

function assertNoClientPricing(body = {}) {
  const protectedTopLevel = [
    'totalMRP', 'productDiscount', 'couponDiscount', 'discount', 'deliveryCharge',
    'codCharge', 'taxAmount', 'finalAmount', 'amount', 'currency', 'paymentStatus',
    'orderStatus', 'paymentProvider', 'user', 'customerId',
  ];
  if (protectedTopLevel.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
    throw requestError('Client-supplied prices, totals, or payment state are not accepted', 'CLIENT_PRICING_NOT_ALLOWED');
  }
  if (Array.isArray(body.orderItems) && body.orderItems.some((item) => (
    item && ['price', 'originalPrice', 'subtotal', 'discount', 'name', 'image', 'sku']
      .some((field) => Object.prototype.hasOwnProperty.call(item, field))
  ))) {
    throw requestError('Order items may only identify a product, variant, and quantity', 'CLIENT_PRICING_NOT_ALLOWED');
  }
  if (body.coupon && Object.keys(body.coupon).some((key) => key !== 'code')) {
    throw requestError('Only the coupon code may be submitted', 'CLIENT_COUPON_VALUE_NOT_ALLOWED');
  }
}

function pickOrderFields(body = {}, options = {}) {
  assertNoClientPricing(body);
  return {
    shippingAddress: sanitizeShippingAddress(body.shippingAddress),
    paymentMethod: normalizePaymentMethod(body.paymentMethod, options),
    coupon: body.coupon?.code ? { code: String(body.coupon.code).trim().toUpperCase() } : undefined,
  };
}

function buildCheckoutSnapshotHash({ userId, orderItems, shippingAddress, paymentMethod, couponCode }) {
  const snapshot = {
    userId: String(userId),
    orderItems: (orderItems || []).map((item) => ({
      product: String(item.product),
      variantId: String(item.variantId || ''),
      size: String(item.size || ''),
      color: String(item.color || ''),
      quantity: Number(item.quantity),
      price: Number(item.price),
    })),
    shippingAddress,
    paymentMethod,
    couponCode: String(couponCode || ''),
  };
  return crypto.createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateRazorpayPayment(payment, order) {
  if (!payment || !payment.id) throw providerError('Payment could not be found', 'PAYMENT_NOT_FOUND');
  if (String(payment.order_id) !== String(order.razorpayOrderId)) {
    throw providerError('Payment does not belong to this checkout', 'PAYMENT_ORDER_MISMATCH');
  }
  if (!Number.isSafeInteger(Number(payment.amount)) || Number(payment.amount) !== Number(order.expectedAmount)) {
    throw providerError('Payment amount does not match the checkout amount', 'PAYMENT_AMOUNT_MISMATCH');
  }
  if (String(payment.currency || '').toUpperCase() !== String(order.currency || 'INR').toUpperCase()) {
    throw providerError('Payment currency does not match the checkout currency', 'PAYMENT_CURRENCY_MISMATCH');
  }
  if (String(payment.status).toLowerCase() !== 'captured') {
    throw providerError('Payment has not been captured', 'PAYMENT_NOT_CAPTURED');
  }
  return true;
}

function requestError(message, code) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

function providerError(message, code) {
  const error = new Error(message);
  error.statusCode = code === 'PAYMENT_NOT_FOUND' ? 404 : 409;
  error.code = code;
  return error;
}

module.exports = {
  assertNoClientPricing,
  buildCheckoutSnapshotHash,
  normalizePaymentMethod,
  pickOrderFields,
  sanitizeShippingAddress,
  validateRazorpayPayment,
  verifyRazorpaySignature,
  verifyWebhookSignature,
};
