const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ReturnExchange = require('../models/ReturnExchange');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings({ returnWindowDays: 7 });
});

async function deliveredOrder(customerToken, product, quantity = 1) {
  const { data } = await request('/api/orders/cod', {
    method: 'POST',
    token: customerToken,
    body: {
      orderItems: [{ product: String(product._id), quantity, size: 'M', color: 'Red' }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });
  const { token: adminToken } = await createAdmin();
  await request(`/api/admin/orders/${data._id}/status`, {
    method: 'PUT',
    token: adminToken,
    body: { orderStatus: 'Delivered', note: 'Delivered for test' },
  });
  return { orderId: data._id, adminToken };
}

test('a delivered order can request a return inside the window', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const { orderId } = await deliveredOrder(token, product);

  const { status, data } = await request('/api/returns', {
    method: 'POST',
    token,
    body: { order: orderId, product: String(product._id), type: 'return', reason: 'Size issue', quantity: 1 },
  });

  assert.equal(status, 201);
  assert.equal(data.status, 'Requested');
});

test('returns are refused after the return window', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const { orderId } = await deliveredOrder(token, product);
  await Order.updateOne({ _id: orderId }, { deliveredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) });

  const { status, data } = await request('/api/returns', {
    method: 'POST',
    token,
    body: { order: orderId, product: String(product._id), type: 'return', reason: 'Changed mind' },
  });

  assert.equal(status, 400);
  assert.equal(data.code, 'RETURN_WINDOW_EXPIRED');
});

test('completing a return restores stock once', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 3 });
  const { orderId, adminToken } = await deliveredOrder(token, product);
  assert.equal((await Product.findById(product._id)).stock, 2);

  const created = await request('/api/returns', {
    method: 'POST',
    token,
    body: { order: orderId, product: String(product._id), type: 'return', reason: 'Damaged' },
  });
  assert.equal(created.status, 201);

  const first = await request(`/api/admin/returns/${created.data._id}/status`, {
    method: 'PUT',
    token: adminToken,
    body: { status: 'Refunded' },
  });
  assert.equal(first.status, 200);
  assert.equal((await Product.findById(product._id)).stock, 3);

  await request(`/api/admin/returns/${created.data._id}/status`, {
    method: 'PUT',
    token: adminToken,
    body: { status: 'Closed' },
  });
  assert.equal((await Product.findById(product._id)).stock, 3);
  assert.equal((await ReturnExchange.findById(created.data._id)).inventoryRestored, true);
});

test('simultaneous return completion restores the returned unit exactly once', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 3 });
  const { orderId, adminToken } = await deliveredOrder(token, product);
  const created = await request('/api/returns', { method: 'POST', token, body: { order: orderId, product: String(product._id), type: 'return', reason: 'Damaged' } });
  const results = await Promise.all([1,2].map(() => request(`/api/admin/returns/${created.data._id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Received' } })));
  assert.ok(results.every(result => result.status === 200));
  assert.equal((await Product.findById(product._id)).stock, 3);
});
