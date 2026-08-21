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
  if (!isRazorpayConfigured()) throw new Error('Razorpay is not configured');

  if (process.env.RAZORPAY_MOCK === '1') {
    return {
      id: `order_mock_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      amount: amountInPaise,
      currency: 'INR',
      receipt,
      notes,
    };
  }

  const razorpay = getRazorpayClient();
  if (!razorpay) throw new Error('Razorpay is not configured');

  try {
    return await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt,
      notes,
    });
  } catch (error) {
    const message = error?.error?.description || error?.message || 'Razorpay order creation failed';
    const wrapped = new Error(message);
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

module.exports = {
  createRazorpayOrder,
  isRazorpayConfigured,
};
