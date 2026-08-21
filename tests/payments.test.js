const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment, getBaseUrl } = require('./helpers');
const { createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Order = require('../models/Order');
const Product = require('../models/Product');
const InventoryTransaction = require('../models/InventoryTransaction');
const { verifyRazorpaySignature } = require('../utils/paymentUtils');

const KEY_SECRET = 'test_razorpay_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings({ razorpayEnabled: true, codEnabled: true });
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

function sign(orderId, paymentId) {
  return crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

/**
 * Creates the pending order the real flow would have written before sending
 * the customer to Razorpay, without needing live gateway credentials.
 */
async function seedPendingOrder(user, product, overrides = {}) {
  return Order.create({
    user: user._id,
    orderItems: [{
      product: product._id,
      name: product.name,
      quantity: 1,
      price: product.price,
      originalPrice: product.originalPrice,
    }],
    shippingAddress: validAddress(),
    paymentMethod: 'UPI',
    paymentProvider: 'Razorpay',
    paymentStatus: 'Pending',
    paymentState: 'PENDING',
    orderStatus: 'Pending',
    razorpayOrderId: `order_test_${crypto.randomUUID()}`,
    totalMRP: product.originalPrice,
    productDiscount: product.originalPrice - product.price,
    couponDiscount: 0,
    discount: product.originalPrice - product.price,
    deliveryCharge: 0,
    codCharge: 0,
    finalAmount: product.price,
    statusTimeline: [{ status: 'Pending', date: new Date(), note: 'Awaiting Razorpay payment' }],
    ...overrides,
  });
}

test('signature verification accepts a valid signature and rejects a forged one', () => {
  const valid = sign('order_1', 'pay_1');
  assert.equal(verifyRazorpaySignature({ razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', razorpaySignature: valid, secret: KEY_SECRET }), true);
  assert.equal(verifyRazorpaySignature({ razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'forged', secret: KEY_SECRET }), false);
});

test('an invalid signature does not mark the order paid or move stock', async () => {
  const { user, token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const pending = await seedPendingOrder(user, product);

  const { status } = await request('/api/payments/verify', {
    method: 'POST',
    token,
    body: {
      razorpay_order_id: pending.razorpayOrderId,
      razorpay_payment_id: 'pay_forged',
      razorpay_signature: 'not-a-real-signature',
    },
  });

  assert.equal(status, 400);
  assert.equal((await Order.findById(pending._id)).paymentStatus, 'Pending');
  assert.equal((await Product.findById(product._id)).stock, 5);
});

test('a valid signature finalises the stored order and deducts stock once', async () => {
  const { user, token } = await createCustomer();
  const product = await createProduct({ stock: 5, price: 1000 });
  const pending = await seedPendingOrder(user, product);
  const paymentId = 'pay_ok_1';

  const { status, data } = await request('/api/payments/verify', {
    method: 'POST',
    token,
    body: {
      razorpay_order_id: pending.razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: sign(pending.razorpayOrderId, paymentId),
    },
  });

  assert.equal(status, 200);
  assert.equal(data.order.paymentStatus, 'Paid');
  assert.equal(data.order.paymentState, 'PAID');
  assert.equal(data.order.orderStatus, 'Confirmed');
  assert.equal((await Product.findById(product._id)).stock, 4);
  assert.equal(await Order.countDocuments(), 1, 'verification must not create a second order');
});

test('verification cannot be used to restate items or amounts', async () => {
  const { user, token } = await createCustomer();
  const product = await createProduct({ stock: 5, price: 1000 });
  const cheatProduct = await createProduct({ stock: 5, price: 50 });
  const pending = await seedPendingOrder(user, product);
  const paymentId = 'pay_ok_2';

  const { data } = await request('/api/payments/verify', {
    method: 'POST',
    token,
    body: {
      razorpay_order_id: pending.razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: sign(pending.razorpayOrderId, paymentId),
      orderPayload: {
        orderItems: [{ product: String(cheatProduct._id), quantity: 10 }],
        coupon: { code: 'FAKE100' },
      },
      finalAmount: 1,
    },
  });

  assert.equal(data.order.finalAmount, 1000);
  assert.equal(data.order.orderItems.length, 1);
  assert.equal(String(data.order.orderItems[0].product), String(product._id));
  assert.equal((await Product.findById(cheatProduct._id)).stock, 5, 'the injected product must be untouched');
});

test('a duplicate verification callback does not deduct stock twice', async () => {
  const { user, token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const pending = await seedPendingOrder(user, product);
  const paymentId = 'pay_dup';
  const body = {
    razorpay_order_id: pending.razorpayOrderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: sign(pending.razorpayOrderId, paymentId),
  };

  await request('/api/payments/verify', { method: 'POST', token, body });
  const second = await request('/api/payments/verify', { method: 'POST', token, body });

  assert.equal(second.status, 200);
  assert.equal(second.data.alreadyPaid, true);
  assert.equal((await Product.findById(product._id)).stock, 4);
  assert.equal((await InventoryTransaction.find({ order: pending._id, type: 'SALE' })).length, 1);
});

test('simultaneous verification callbacks deduct stock only once', async () => {
  const { user, token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const pending = await seedPendingOrder(user, product);
  const paymentId = 'pay_race';
  const body = {
    razorpay_order_id: pending.razorpayOrderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: sign(pending.razorpayOrderId, paymentId),
  };

  await Promise.all([
    request('/api/payments/verify', { method: 'POST', token, body }),
    request('/api/payments/verify', { method: 'POST', token, body }),
  ]);

  assert.equal((await Product.findById(product._id)).stock, 4);
  assert.equal((await InventoryTransaction.find({ order: pending._id, type: 'SALE' })).length, 1);
});

test('a customer cannot verify a payment against another customer order', async () => {
  const owner = await createCustomer();
  const stranger = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const pending = await seedPendingOrder(owner.user, product);
  const paymentId = 'pay_stranger';

  const { status } = await request('/api/payments/verify', {
    method: 'POST',
    token: stranger.token,
    body: {
      razorpay_order_id: pending.razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: sign(pending.razorpayOrderId, paymentId),
    },
  });

  assert.equal(status, 404);
  assert.equal((await Order.findById(pending._id)).paymentStatus, 'Pending');
});

async function postWebhook(payload, { secret = WEBHOOK_SECRET } = {}) {
  const raw = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const response = await fetch(`${getBaseUrl()}/api/payments/webhook/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
    body: raw,
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

test('the webhook rejects an invalid signature', async () => {
  const response = await fetch(`${getBaseUrl()}/api/payments/webhook/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'wrong' },
    body: JSON.stringify({ event: 'payment.captured' }),
  });
  assert.equal(response.status, 400);
});

test('the webhook completes an order when the customer never returned', async () => {
  const { user } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const pending = await seedPendingOrder(user, product);

  const { status } = await postWebhook({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_webhook', order_id: pending.razorpayOrderId } } },
  });

  assert.equal(status, 200);
  const stored = await Order.findById(pending._id);
  assert.equal(stored.paymentStatus, 'Paid');
  assert.equal(stored.orderStatus, 'Confirmed');
  assert.equal(stored.razorpayPaymentId, 'pay_webhook');
  assert.equal((await Product.findById(product._id)).stock, 4);
});

test('a redelivered webhook is idempotent', async () => {
  const { user } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const pending = await seedPendingOrder(user, product);
  const payload = {
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_retry', order_id: pending.razorpayOrderId } } },
  };

  await postWebhook(payload);
  await postWebhook(payload);
  await postWebhook(payload);

  assert.equal((await Product.findById(product._id)).stock, 4);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal((await InventoryTransaction.find({ order: pending._id, type: 'SALE' })).length, 1);
});

test('a webhook for an unknown order is acknowledged without creating anything', async () => {
  const { status } = await postWebhook({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_unknown', order_id: 'order_does_not_exist' } } },
  });

  assert.equal(status, 200);
  assert.equal(await Order.countDocuments(), 0);
});

test('a payment.failed webhook marks the order failed without touching stock', async () => {
  const { user } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const pending = await seedPendingOrder(user, product);

  await postWebhook({
    event: 'payment.failed',
    payload: { payment: { entity: { id: 'pay_bad', order_id: pending.razorpayOrderId, error_description: 'Card declined' } } },
  });

  const stored = await Order.findById(pending._id);
  assert.equal(stored.paymentStatus, 'Failed');
  assert.equal(stored.paymentState, 'FAILED');
  assert.equal(stored.paymentFailureReason, 'Card declined');
  assert.equal((await Product.findById(product._id)).stock, 5);
});

test('a late failure webhook cannot undo an already paid order', async () => {
  const { user } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const pending = await seedPendingOrder(user, product);

  await postWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_late', order_id: pending.razorpayOrderId } } } });
  await postWebhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_late', order_id: pending.razorpayOrderId } } } });

  assert.equal((await Order.findById(pending._id)).paymentStatus, 'Paid');
});

test('recording a payment failure never restores stock that was never taken', async () => {
  const { user, token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const pending = await seedPendingOrder(user, product);

  const { status } = await request('/api/payments/failure', {
    method: 'POST',
    token,
    body: { reason: 'Payment cancelled by customer', razorpayOrderId: pending.razorpayOrderId },
  });

  assert.equal(status, 202);
  const stored = await Order.findById(pending._id);
  assert.equal(stored.paymentStatus, 'Failed');
  assert.equal(stored.orderStatus, 'Cancelled');
  assert.equal((await Product.findById(product._id)).stock, 5);
});

test('a failure report is refused once the order is paid', async () => {
  const { user, token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const pending = await seedPendingOrder(user, product);
  await postWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_done', order_id: pending.razorpayOrderId } } } });

  const { status, data } = await request('/api/payments/failure', {
    method: 'POST',
    token,
    body: { reason: 'Cancelled', razorpayOrderId: pending.razorpayOrderId },
  });

  assert.equal(status, 409);
  assert.equal(data.code, 'DUPLICATE_REQUEST');
});

function withMockRazorpay(work) {
  const previous = {
    keyId: process.env.RAZORPAY_KEY_ID,
    mock: process.env.RAZORPAY_MOCK,
  };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
  process.env.RAZORPAY_MOCK = '1';
  return Promise.resolve()
    .then(work)
    .finally(() => {
      if (previous.keyId === undefined) delete process.env.RAZORPAY_KEY_ID;
      else process.env.RAZORPAY_KEY_ID = previous.keyId;
      if (previous.mock === undefined) delete process.env.RAZORPAY_MOCK;
      else process.env.RAZORPAY_MOCK = previous.mock;
    });
}

function onlineOrderBody(product, overrides = {}) {
  return {
    orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }],
    shippingAddress: validAddress(),
    paymentMethod: 'UPI',
    ...overrides,
  };
}

test('creating a Razorpay order reserves stock immediately', async () => {
  await withMockRazorpay(async () => {
    const { token } = await createCustomer();
    const product = await createProduct({ stock: 5, price: 1000 });

    const { status, data } = await request('/api/payments/create-order', {
      method: 'POST',
      token,
      body: onlineOrderBody(product),
    });

    assert.equal(status, 200);
    assert.ok(data.razorpayOrderId);
    assert.equal(data.totals.finalAmount, 1000);
    assert.equal((await Product.findById(product._id)).stock, 4);
    assert.equal((await Order.findById(data.orderId)).paymentStatus, 'Pending');
  });
});

test('two simultaneous Razorpay checkouts for the last unit: only one reserves it', async () => {
  await withMockRazorpay(async () => {
    const product = await createProduct({ stock: 1, price: 1000 });
    const first = await createCustomer();
    const second = await createCustomer();

    const [resultA, resultB] = await Promise.all([
      request('/api/payments/create-order', { method: 'POST', token: first.token, body: onlineOrderBody(product) }),
      request('/api/payments/create-order', { method: 'POST', token: second.token, body: onlineOrderBody(product) }),
    ]);

    const statuses = [resultA.status, resultB.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal((await Product.findById(product._id)).stock, 0);
    assert.equal(await Order.countDocuments(), 1);
  });
});

test('payment verification after a reserved pending order does not deduct stock twice', async () => {
  await withMockRazorpay(async () => {
    const { token } = await createCustomer();
    const product = await createProduct({ stock: 5, price: 1000 });
    const created = await request('/api/payments/create-order', {
      method: 'POST',
      token,
      body: onlineOrderBody(product),
    });
    assert.equal((await Product.findById(product._id)).stock, 4);

    const paymentId = 'pay_reserved';
    const verified = await request('/api/payments/verify', {
      method: 'POST',
      token,
      body: {
        razorpay_order_id: created.data.razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: sign(created.data.razorpayOrderId, paymentId),
      },
    });

    assert.equal(verified.status, 200);
    assert.equal(verified.data.order.paymentStatus, 'Paid');
    assert.equal((await Product.findById(product._id)).stock, 4);
    assert.equal((await InventoryTransaction.find({ order: created.data.orderId, type: 'SALE' })).length, 1);
  });
});

test('abandoning a Razorpay checkout restores reserved stock once', async () => {
  await withMockRazorpay(async () => {
    const { token } = await createCustomer();
    const product = await createProduct({ stock: 5, price: 1000 });
    const created = await request('/api/payments/create-order', {
      method: 'POST',
      token,
      body: onlineOrderBody(product),
    });
    assert.equal((await Product.findById(product._id)).stock, 4);

    const failed = await request('/api/payments/failure', {
      method: 'POST',
      token,
      body: { reason: 'Payment cancelled by customer', razorpayOrderId: created.data.razorpayOrderId },
    });
    assert.equal(failed.status, 202);
    assert.equal((await Product.findById(product._id)).stock, 5);

    await request('/api/payments/failure', {
      method: 'POST',
      token,
      body: { reason: 'Payment cancelled by customer', razorpayOrderId: created.data.razorpayOrderId },
    });
    assert.equal((await Product.findById(product._id)).stock, 5);
    assert.equal((await InventoryTransaction.find({ order: created.data.orderId, type: 'CANCELLATION' })).length, 1);
  });
});
