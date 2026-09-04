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

test('the public coupon list hides future, exhausted and private coupons', async () => {
  await createCoupon({ code: 'PUBLIC10', usedCount: 3 });
  await createCoupon({ code: 'FUTURE10', validFrom: new Date(Date.now() + 86400000) });
  await createCoupon({ code: 'USEDUP10', usageLimit: 2, usedCount: 2 });
  await createCoupon({ code: 'PRIVATE10', isPublic: false });

  const { status, data } = await request('/api/coupons');
  assert.equal(status, 200);
  assert.deepEqual(data.map((coupon) => coupon.code), ['PUBLIC10']);
  assert.equal(Object.hasOwn(data[0], 'usedCount'), false, 'internal usage details are not exposed publicly');
  assert.equal(Object.hasOwn(data[0], 'isActive'), false, 'internal status is not exposed publicly');
});

test('available coupons are evaluated against the bag and sorted by real savings', async () => {
  const product = await createProduct({ price: 2000, stock: 5 });
  await createCoupon({ code: 'TENPERCENT', type: 'Percentage', discountValue: 10 });
  await createCoupon({ code: 'SAVE350', type: 'Flat', discountValue: 350 });
  await createCoupon({ code: 'SPEND3000', type: 'Flat', discountValue: 500, minOrderAmount: 3000 });

  const { status, data } = await request('/api/coupons/available', {
    method: 'POST',
    body: { items: [{ product: String(product._id), quantity: 1 }], paymentMethod: 'COD' },
  });

  assert.equal(status, 200);
  assert.equal(data.cartTotal, 2000);
  assert.equal(data.bestCouponCode, 'SAVE350', JSON.stringify(data));
  assert.equal(data.items[0].code, 'SAVE350');
  assert.equal(data.items[0].estimatedDiscount, 350);
  const unavailable = data.items.find((coupon) => coupon.code === 'SPEND3000');
  assert.equal(unavailable.eligible, false);
  assert.equal(unavailable.amountNeeded, 1000);
});

test('coupon preview ignores prices and totals supplied by the browser', async () => {
  const product = await createProduct({ price: 2000, stock: 5 });
  const coupon = await createCoupon({ code: 'SAFE10', type: 'Percentage', discountValue: 10 });

  const { status, data } = await request('/api/coupons/apply', {
    method: 'POST',
    body: {
      code: coupon.code,
      cartTotal: 1,
      items: [{ product: String(product._id), quantity: 1, price: 1, lineTotal: 1 }],
    },
  });

  assert.equal(status, 200);
  assert.equal(data.discountAmount, 200);
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

test('the admin coupon endpoint returns management data without a query flag', async () => {
  const { token } = await createAdmin();
  await createCoupon({ code: 'HIDDEN3', isActive: false, usedCount: 4 });
  const { status, data } = await request('/api/admin/coupons', { token });
  assert.equal(status, 200);
  assert.equal(data.find((coupon) => coupon.code === 'HIDDEN3').usedCount, 4);
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

test('coupon administration rejects invalid limits, date ranges and duplicate codes', async () => {
  const { token } = await createAdmin();
  await createCoupon({ code: 'UNIQUE10' });
  const base = { code: 'NEWCODE', type: 'Flat', discountValue: 100, expiryDate: new Date(Date.now() + 86400000) };

  const negative = await request('/api/admin/coupons', { method: 'POST', token, body: { ...base, usageLimit: -1 } });
  assert.equal(negative.status, 400);
  assert.equal(negative.data.code, 'VALIDATION_ERROR');

  const invalidDates = await request('/api/admin/coupons', {
    method: 'POST', token, body: { ...base, validFrom: new Date(Date.now() + 172800000), expiryDate: new Date(Date.now() + 86400000) },
  });
  assert.equal(invalidDates.status, 400);

  const duplicate = await request('/api/admin/coupons', { method: 'POST', token, body: { ...base, code: 'UNIQUE10' } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'DUPLICATE_REQUEST');
});

test('coupon updates validate the complete resulting offer', async () => {
  const { token } = await createAdmin();
  const coupon = await createCoupon({ type: 'Flat', discountValue: 500 });

  const { status, data } = await request(`/api/admin/coupons/${coupon._id}`, {
    method: 'PUT', token, body: { type: 'Percentage' },
  });

  assert.equal(status, 400);
  assert.equal(data.code, 'VALIDATION_ERROR');
  assert.equal((await Coupon.findById(coupon._id)).type, 'Flat');
});

test('unused coupons are deleted while redeemed coupons are archived', async () => {
  const { token } = await createAdmin();
  const unused = await createCoupon({ code: 'UNUSED10' });
  const used = await createCoupon({ code: 'USEDONCE', usedCount: 1 });

  const deleted = await request(`/api/admin/coupons/${unused._id}`, { method: 'DELETE', token });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.archived, false);
  assert.equal(await Coupon.findById(unused._id), null);

  const archived = await request(`/api/admin/coupons/${used._id}`, { method: 'DELETE', token });
  assert.equal(archived.status, 200);
  assert.equal(archived.data.archived, true);
  const stored = await Coupon.findById(used._id);
  assert.equal(stored.isActive, false);
  assert.equal(stored.isPublic, false);
  assert.equal(stored.usedCount, 1);
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
