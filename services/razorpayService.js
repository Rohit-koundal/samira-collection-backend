const Razorpay = require('razorpay');

let client;

function isRazorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function getRazorpayClient() {
  if (!isRazorpayConfigured()) return null;
  if (!client) {
    client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return client;
}

async function createRazorpayOrder({ amountInPaise, receipt, notes = {} }) {
  const razorpay = getRazorpayClient();
  if (!razorpay) throw new Error('Razorpay is not configured');
  if (!Number.isSafeInteger(amountInPaise) || amountInPaise < 100) {
    const error = new Error('Payment amount is invalid');
    error.statusCode = 400;
    error.code = 'INVALID_PAYMENT_AMOUNT';
    throw error;
  }

  try {
    return await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt,
      notes,
    });
  } catch (error) {
    const wrapped = new Error('Payment provider could not create the checkout');
    if (Number(error?.statusCode) === 401) {
      wrapped.statusCode = 401;
      wrapped.razorpayAuthError = true;
    } else {
      wrapped.statusCode = 500;
      wrapped.razorpayError = true;
    }
    throw wrapped;
  }
}

async function fetchRazorpayPayment(paymentId) {
  const razorpay = getRazorpayClient();
  if (!razorpay) throw configurationError();
  if (!paymentId) throw requestError('Payment ID is required');
  try {
    return await razorpay.payments.fetch(paymentId);
  } catch (error) {
    const wrapped = new Error('Payment could not be verified with the provider');
    wrapped.statusCode = Number(error?.statusCode) === 404 ? 404 : 502;
    wrapped.code = 'RAZORPAY_PAYMENT_FETCH_FAILED';
    throw wrapped;
  }
}

async function createRazorpayRefund({ paymentId, amountInPaise, notes = {}, receipt }) {
  const razorpay = getRazorpayClient();
  if (!razorpay) throw configurationError();
  if (!paymentId || !Number.isSafeInteger(amountInPaise) || amountInPaise < 1) {
    throw requestError('Refund request is invalid');
  }
  try {
    return await razorpay.payments.refund(paymentId, {
      amount: amountInPaise,
      speed: 'normal',
      notes,
      receipt,
    });
  } catch (error) {
    const wrapped = new Error('Payment provider could not initiate the refund');
    wrapped.statusCode = 502;
    wrapped.code = 'RAZORPAY_REFUND_FAILED';
    throw wrapped;
  }
}

async function fetchRazorpayRefunds(paymentId) {
  const razorpay = getRazorpayClient();
  if (!razorpay) throw configurationError();
  try {
    return await razorpay.payments.fetchMultipleRefund(paymentId, { count: 100 });
  } catch (error) {
    if (Number(error?.statusCode) === 404) return { items: [] };
    const wrapped = new Error('Payment provider refunds could not be reconciled');
    wrapped.statusCode = 502;
    wrapped.code = 'RAZORPAY_REFUND_RECONCILIATION_FAILED';
    throw wrapped;
  }
}

function configurationError() {
  const error = new Error('Razorpay is not configured');
  error.statusCode = 503;
  error.code = 'RAZORPAY_NOT_CONFIGURED';
  return error;
}

function requestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'INVALID_RAZORPAY_REQUEST';
  return error;
}

module.exports = {
  createRazorpayRefund,
  createRazorpayOrder,
  fetchRazorpayPayment,
  fetchRazorpayRefunds,
  getRazorpayClient,
  isRazorpayConfigured,
};
