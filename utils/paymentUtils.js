const crypto = require('crypto');

function verifyRazorpaySignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature, secret }) {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  return expected === razorpaySignature;
}

function pickOrderFields(body = {}) {
  return {
    shippingAddress: body.shippingAddress,
    paymentMethod: body.paymentMethod,
    paymentProvider: body.paymentProvider,
    coupon: body.coupon,
  };
}

module.exports = {
  pickOrderFields,
  verifyRazorpaySignature,
};
