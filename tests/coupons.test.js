const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCoupon, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Coupon = require('../models/Coupon');
const couponService = require('../services/couponService');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings();
});

test('a valid coupon previews the discount the backend computes', async () => {
  const coupon = await createCoupon({ type: 'Percentage', discountValue: 10, maxDiscountAmount: 0 });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000 } });

  assert.equal(status, 200);
  assert.equal(data.discountAmount, 200);
});

test('the maximum discount cap is respected', async () => {
  const coupon = await createCoupon({ type: 'Percentage', discountValue: 50, maxDiscountAmount: 300 });
  const { data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 5000 } });
  assert.equal(data.discountAmount, 300);
});

test('a discount can never exceed the cart total', async () => {
  const coupon = await createCoupon({ type: 'Flat', discountValue: 5000 });
  const { data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 800 } });
  assert.equal(data.discountAmount, 800);
});

test('an expired coupon is refused', async () => {
  const coupon = await createCoupon({ expiryDate: new Date(Date.now() - 1000) });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'COUPON_EXPIRED');
});

test('an inactive coupon is refused', async () => {
  const coupon = await createCoupon({ isActive: false });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'INVALID_COUPON');
});

test('a coupon that has not started yet is refused', async () => {
  const coupon = await createCoupon({ validFrom: new Date(Date.now() + 86400000) });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'INVALID_COUPON');
});

test('the minimum order amount is enforced', async () => {
  const coupon = await createCoupon({ minOrderAmount: 1500 });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 800 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'INVALID_COUPON');
});

test('an exhausted usage limit is refused', async () => {
  const coupon = await createCoupon({ usageLimit: 2, usedCount: 2 });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'INVALID_COUPON');
});

test('a payment-method restricted coupon is refused for other methods', async () => {
  const coupon = await createCoupon({ applicablePaymentMethods: ['UPI'] });

  const cod = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000, paymentMethod: 'COD' } });
  assert.equal(cod.status, 400);

  const upi = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000, paymentMethod: 'UPI' } });
  assert.equal(upi.status, 200);
});

test('an unknown coupon code is refused', async () => {
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: 'NOPE123', cartTotal: 2000 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'INVALID_COUPON');
});

test('a malformed coupon code fails validation', async () => {
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: '!!', cartTotal: 2000 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'VALIDATION_ERROR');
});

test('the usage limit holds under concurrent consumption', async () => {
  const coupon = await createCoupon({ usageLimit: 1 });

  const results = await Promise.allSettled([
    couponService.consumeCoupon(coupon.code),
    couponService.consumeCoupon(coupon.code),
    couponService.consumeCoupon(coupon.code),
  ]);

  const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'only one redemption may succeed');
  assert.equal((await Coupon.findById(coupon._id)).usedCount, 1);
});

test('releasing a coupon never drives usage below zero', async () => {
  const coupon = await createCoupon();
  await couponService.releaseCoupon(coupon.code);
  await couponService.releaseCoupon(coupon.code);
  assert.equal((await Coupon.findById(coupon._id)).usedCount, 0);
});

test('the public coupon list hides expired coupons', async () => {
  await createCoupon({ code: 'LIVEONE' });
  await createCoupon({ code: 'DEADONE', expiryDate: new Date(Date.now() - 1000) });

  const { data } = await request('/api/coupons');
  const codes = data.map((coupon) => coupon.code);
  assert.ok(codes.includes('LIVEONE'));
  assert.equal(codes.includes('DEADONE'), false);
});

test('an anonymous caller cannot list all coupons via the admin flag', async () => {
  await createCoupon({ code: 'HIDDEN1', isActive: false });
  const { data } = await request('/api/coupons?admin=true');
  assert.equal(data.some((coupon) => coupon.code === 'HIDDEN1'), false);
});

test('an admin can list inactive coupons', async () => {
  const { token } = await createAdmin();
  await createCoupon({ code: 'HIDDEN2', isActive: false });
  const { data } = await request('/api/admin/coupons?admin=true', { token });
  assert.equal(data.some((coupon) => coupon.code === 'HIDDEN2'), true);
});

test('a customer cannot create a coupon', async () => {
  const { token } = await createCustomer();
  const { status } = await request('/api/admin/coupons', {
    method: 'POST',
    token,
    body: { code: 'HACK10', type: 'Flat', discountValue: 10, expiryDate: new Date(Date.now() + 86400000) },
  });
  assert.equal(status, 403);
});

test('editing a coupon does not reset its usage count', async () => {
  const { token } = await createAdmin();
  const coupon = await createCoupon({ usedCount: 7 });

  await request(`/api/admin/coupons/${coupon._id}`, { method: 'PUT', token, body: { discountValue: 250, usedCount: 0 } });

  const stored = await Coupon.findById(coupon._id);
  assert.equal(stored.usedCount, 7);
  assert.equal(stored.discountValue, 250);
});

test('a coupon at its usage limit cannot be used for a new order', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ usageLimit: 1, usedCount: 1 });

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      coupon: { code: coupon.code },
    },
  });

  assert.equal(status, 400);
  assert.equal(data.code, 'INVALID_COUPON');
});

test('creating a coupon ignores usedCount from the client', async () => {
  const { token } = await createAdmin();
  const { status, data } = await request('/api/admin/coupons', {
    method: 'POST',
    token,
    body: {
      code: 'INJECT50',
      type: 'Flat',
      discountValue: 50,
      expiryDate: new Date(Date.now() + 86400000),
      usedCount: 50,
      role: 'admin',
    },
  });

  assert.equal(status, 201);
  assert.equal(data.usedCount, 0);
  assert.equal((await Coupon.findById(data._id)).usedCount, 0);
});

test('a product-restricted coupon is refused for other products', async () => {
  const { token } = await createCustomer();
  const allowed = await createProduct({ price: 1000, stock: 5 });
  const other = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ applicableProducts: [allowed._id] });

  const refused = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(other._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      coupon: { code: coupon.code },
    },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.code, 'INVALID_COUPON');

  const accepted = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(allowed._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      coupon: { code: coupon.code },
    },
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.couponDiscount, 100);
});

test('a first-order coupon is refused after the customer has ordered', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ firstOrderOnly: true });

  const first = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });
  assert.equal(first.status, 201);

  const second = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      coupon: { code: coupon.code },
    },
  });
  assert.equal(second.status, 400);
  assert.equal(second.data.code, 'INVALID_COUPON');
});

test('a per-customer coupon limit is enforced', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ customerLimit: 1 });

  const first = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      coupon: { code: coupon.code },
    },
  });
  assert.equal(first.status, 201);

  const second = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      coupon: { code: coupon.code },
    },
  });
  assert.equal(second.status, 400);
  assert.equal(second.data.code, 'INVALID_COUPON');
});
