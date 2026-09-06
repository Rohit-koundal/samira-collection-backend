const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCoupon, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
const InventoryTransaction = require('../models/InventoryTransaction');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings();
});

function codOrderBody(product, overrides = {}) {
  return {
    orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }],
    shippingAddress: validAddress(),
    paymentMethod: 'COD',
    ...overrides,
  };
}

test('a COD order is priced from the database, not from the request', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1200, originalPrice: 2000, stock: 5 });

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 2, price: 1, originalPrice: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      finalAmount: 1,
      totalMRP: 1,
    },
  });

  assert.equal(status, 201);
  assert.equal(data.orderItems[0].price, 1200);
  assert.equal(data.totalMRP, 4000);
  // 2 x 1200 = 2400, above the 999 free-shipping threshold.
  assert.equal(data.deliveryCharge, 0);
  assert.equal(data.finalAmount, 2400);
});

test('placing a COD order deducts stock exactly once and writes a ledger entry', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const { status, data } = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });
  assert.equal(status, 201);

  const refreshed = await Product.findById(product._id);
  assert.equal(refreshed.stock, 4);

  const ledger = await InventoryTransaction.find({ order: data._id });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].type, 'SALE');
  assert.equal(ledger[0].quantity, -1);
  assert.equal(ledger[0].stockAfter, 4);
});

test('an order for more than the available stock is rejected', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 2 });

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: codOrderBody(product, { orderItems: [{ product: String(product._id), quantity: 5 }] }),
  });

  assert.equal(status, 409);
  assert.equal(data.code, 'OUT_OF_STOCK');
  assert.equal(await Order.countDocuments(), 0);
  assert.equal((await Product.findById(product._id)).stock, 2);
});

test('two simultaneous checkouts for the last unit: only one succeeds', async () => {
  const productA = await createProduct({ stock: 1 });
  const first = await createCustomer();
  const second = await createCustomer();

  const [resultA, resultB] = await Promise.all([
    request('/api/orders/cod', { method: 'POST', token: first.token, body: codOrderBody(productA) }),
    request('/api/orders/cod', { method: 'POST', token: second.token, body: codOrderBody(productA) }),
  ]);

  const statuses = [resultA.status, resultB.status].sort();
  assert.deepEqual(statuses, [201, 409], 'exactly one checkout must win the last unit');

  const refreshed = await Product.findById(productA._id);
  assert.equal(refreshed.stock, 0, 'stock must never go negative');
  assert.equal(await Order.countDocuments(), 1);
});

test('a multi-item order that runs out on the second item leaves stock untouched', async () => {
  const { token } = await createCustomer();
  const inStock = await createProduct({ stock: 10 });
  const shortStock = await createProduct({ stock: 1 });

  const { status } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: codOrderBody(inStock, {
      orderItems: [
        { product: String(inStock._id), quantity: 2 },
        { product: String(shortStock._id), quantity: 4 },
      ],
    }),
  });

  assert.equal(status, 409);
  assert.equal((await Product.findById(inStock._id)).stock, 10, 'the first item must be rolled back');
  assert.equal((await Product.findById(shortStock._id)).stock, 1);
  assert.equal(await Order.countDocuments(), 0);
});

test('cancelling an order restores stock exactly once', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const created = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });
  assert.equal((await Product.findById(product._id)).stock, 4);

  const cancelled = await request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.orderStatus, 'Cancelled');
  assert.equal((await Product.findById(product._id)).stock, 5);

  const again = await request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} });
  assert.equal(again.status, 200);
  assert.equal((await Product.findById(product._id)).stock, 5, 'a repeat cancellation must not restock twice');

  const restores = await InventoryTransaction.find({ order: created.data._id, type: 'CANCELLATION' });
  assert.equal(restores.length, 1);
});

test('concurrent cancellations restore stock only once', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const created = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });

  await Promise.all([
    request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} }),
    request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} }),
  ]);

  assert.equal((await Product.findById(product._id)).stock, 5);
  assert.equal((await InventoryTransaction.find({ order: created.data._id, type: 'CANCELLATION' })).length, 1);
});

test('a delivered order cannot be cancelled', async () => {
  const { token } = await createCustomer();
  const admin = await createAdmin();
  const product = await createProduct({ stock: 5 });
  const created = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });

  await request(`/api/admin/orders/${created.data._id}/status`, { method: 'PUT', token: admin.token, body: { orderStatus: 'Delivered' } });

  const { status, data } = await request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} });
  assert.equal(status, 409);
  assert.equal(data.code, 'ORDER_NOT_CANCELLABLE');
  assert.equal((await Product.findById(product._id)).stock, 4, 'stock must stay deducted for a delivered order');
});

test('a customer cannot cancel or read another customer order', async () => {
  const owner = await createCustomer();
  const stranger = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const created = await request('/api/orders/cod', { method: 'POST', token: owner.token, body: codOrderBody(product) });

  const read = await request(`/api/orders/${created.data._id}`, { token: stranger.token });
  assert.equal(read.status, 403);

  const cancel = await request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token: stranger.token, body: {} });
  assert.equal(cancel.status, 403);
});

test('checkout is blocked until the mobile number is verified', async () => {
  const { token } = await createCustomer({ isPhoneVerified: false });
  const product = await createProduct({ stock: 5 });

  const { status } = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });
  assert.equal(status, 403);
});

test('an order without a valid address is rejected', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: codOrderBody(product, { shippingAddress: { fullName: 'No Pincode', mobile: '9000000001' } }),
  });

  assert.equal(status, 400);
  assert.equal(data.code, 'VALIDATION_ERROR');
  assert.equal(await Order.countDocuments(), 0);
});

test('an inactive product cannot be ordered', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5, isActive: false });

  const { status } = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });
  assert.equal(status, 409);
});

test('coupon usage is consumed on order and released on cancellation, once', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ type: 'Flat', discountValue: 200 });

  const created = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: codOrderBody(product, { coupon: { code: coupon.code } }),
  });

  assert.equal(created.status, 201);
  assert.equal(created.data.couponDiscount, 200);
  assert.equal(created.data.finalAmount, 800);
  assert.equal((await Coupon.findById(coupon._id)).usedCount, 1);

  await request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} });
  assert.equal((await Coupon.findById(coupon._id)).usedCount, 0);

  await request(`/api/orders/${created.data._id}/cancel`, { method: 'POST', token, body: {} });
  assert.equal((await Coupon.findById(coupon._id)).usedCount, 0, 'a repeat cancellation must not release twice');
});

test('a client-supplied coupon discount is ignored', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ type: 'Flat', discountValue: 100 });

  const { data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: codOrderBody(product, { coupon: { code: coupon.code, discount: 999, discountAmount: 999 }, couponDiscount: 999 }),
  });

  assert.equal(data.couponDiscount, 100);
  assert.equal(data.finalAmount, 900);
});

test('an expired coupon is rejected at checkout', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ expiryDate: new Date(Date.now() - 1000) });

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: codOrderBody(product, { coupon: { code: coupon.code } }),
  });

  assert.equal(status, 400);
  assert.equal(data.code, 'COUPON_EXPIRED');
  assert.equal(await Order.countDocuments(), 0);
});

test('deleting an order cancels it instead of destroying the record', async () => {
  const { token } = await createCustomer();
  const admin = await createAdmin();
  const product = await createProduct({ stock: 5 });
  const created = await request('/api/orders/cod', { method: 'POST', token, body: codOrderBody(product) });

  const { status } = await request(`/api/admin/orders/${created.data._id}`, { method: 'DELETE', token: admin.token });
  assert.equal(status, 200);

  const stored = await Order.findById(created.data._id);
  assert.ok(stored, 'order history must be preserved');
  assert.equal(stored.orderStatus, 'Cancelled');
  assert.equal((await Product.findById(product._id)).stock, 5);
});

test('the quote endpoint includes platform fee and inclusive GST when configured', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1050, originalPrice: 1200, stock: 5 });
  await setSettings({ deliveryCharge: 0, freeShippingMinAmount: 0, platformFee: 23, gstRate: 5, codCharge: 0 });

  const { status, data } = await request('/api/orders/quote', {
    method: 'POST',
    token,
    body: { orderItems: [{ product: String(product._id), quantity: 1 }], paymentMethod: 'COD' },
  });

  assert.equal(status, 200);
  assert.equal(data.totals.platformFee, 23);
  assert.equal(data.totals.taxRate, 5);
  assert.equal(data.totals.taxAmount, 50);
  assert.equal(data.totals.finalAmount, 1073);
});

test('the quote endpoint returns backend totals and allowed payment methods', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 500, originalPrice: 800, stock: 5 });
  await setSettings({ codEnabled: true, codCharge: 49, razorpayEnabled: false });

  const { status, data } = await request('/api/orders/quote', {
    method: 'POST',
    token,
    body: { orderItems: [{ product: String(product._id), quantity: 1 }], paymentMethod: 'COD' },
  });

  assert.equal(status, 200);
  assert.equal(data.totals.codCharge, 49);
  assert.equal(data.totals.deliveryCharge, 99);
  assert.equal(data.totals.finalAmount, 500 + 99 + 49);
  assert.ok(data.paymentOptions.some((option) => option.key === 'COD'));
});

test('coupon-discounted invoice line taxes add up exactly to the charged inclusive GST', async () => {
  const { token } = await createCustomer();
  const first = await createProduct({ price: 1050, originalPrice: 1200 });
  const second = await createProduct({ price: 525, originalPrice: 700 });
  const coupon = await createCoupon({ discountValue: 175 });
  await setSettings({ gstRate: 5, deliveryCharge: 0 });
  const { status, data } = await request('/api/orders/cod', {
    method: 'POST', token,
    body: codOrderBody(first, {
      orderItems: [{ product: String(first._id), quantity: 1 }, { product: String(second._id), quantity: 1 }],
      coupon: { code: coupon.code },
    }),
  });
  assert.equal(status, 201);
  assert.equal(data.taxAmount, 66.67);
  assert.equal(Math.round(data.orderItems.reduce((sum, item) => sum + item.tax, 0) * 100), 6667);
  assert.ok(data.orderItems.every((item) => item.tax >= 0));
});

test('checkout honors its resolved store when loading authoritative product rows', async () => {
  const product = await createProduct();
  const { buildOrderDraft } = require('../services/orderPricingService');
  await assert.rejects(buildOrderDraft({
    orderItems: [{ product: String(product._id), quantity: 1 }],
    tenantFilter: { storeId: '0123456789abcdef11111111' },
  }), (error) => error.errorCode === 'NOT_FOUND');
});
