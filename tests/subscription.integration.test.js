const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createMasterOwner, createProvisionedSeller } = require('./accessFixtures');
const Store = require('../models/Store');
const SubscriptionPayment = require('../models/SubscriptionPayment');

process.env.RAZORPAY_KEY_ID = 'rzp_test_subscription_public_key';
process.env.RAZORPAY_KEY_SECRET = 'subscription_test_secret';
process.env.RAZORPAY_MOCK = '1';

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('seller buys a monthly plan and repeated signed callbacks cannot extend it twice', async () => {
  const seller = await createProvisionedSeller('Subscription Boutique');
  const headers = { 'x-store-id': seller.store.id };
  const initial = await request('/api/seller/subscription', { token: seller.token, headers });
  assert.equal(initial.status, 200);
  assert.equal(initial.data.subscription.status, 'TRIAL');
  assert.equal(initial.data.subscription.daysRemaining, 30);
  assert.equal(initial.data.checkout.keyId, process.env.RAZORPAY_KEY_ID);
  assert.doesNotMatch(JSON.stringify(initial.data), /subscription_test_secret/);

  const checkout = await request('/api/seller/subscription/checkout', {
    method: 'POST', token: seller.token, headers,
    body: { plan: 'PROFESSIONAL', billingCycle: 'MONTHLY', amount: 1 },
  });
  assert.equal(checkout.status, 201);
  assert.equal(checkout.data.amount, 1999 * 100); // Browser amount is ignored.
  const paymentId = 'pay_subscription_test';
  const signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${checkout.data.orderId}|${paymentId}`).digest('hex');
  const callback = { razorpay_order_id: checkout.data.orderId, razorpay_payment_id: paymentId, razorpay_signature: signature };

  const verified = await request('/api/seller/subscription/verify', { method: 'POST', token: seller.token, headers, body: callback });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.subscription.status, 'ACTIVE');
  assert.equal(verified.data.subscription.billingCycle, 'MONTHLY');
  const firstEnd = new Date(verified.data.subscription.endsAt).toISOString();

  const repeated = await request('/api/seller/subscription/verify', { method: 'POST', token: seller.token, headers, body: callback });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.alreadyPaid, true);
  assert.equal(new Date(repeated.data.subscription.endsAt).toISOString(), firstEnd);
  assert.equal(await SubscriptionPayment.countDocuments({ store: seller.store.id }), 1);

  const downgrade = await request('/api/seller/subscription/checkout', {
    method: 'POST', token: seller.token, headers,
    body: { plan: 'BASIC', billingCycle: 'MONTHLY' },
  });
  assert.equal(downgrade.status, 400);
  assert.match(downgrade.data.message, /lower plan/i);
});

test('master limits and expiry are enforced by backend while seller reads remain available', async () => {
  const seller = await createProvisionedSeller('Limited Boutique');
  const master = await createMasterOwner();
  const headers = { 'x-store-id': seller.store.id };
  const limited = await request(`/api/master/stores/${seller.store.id}/platform`, {
    method: 'PATCH', token: master.token,
    body: { plan: 'BASIC', limitOverrides: { products: 0, ordersPerMonth: 10 } },
  });
  assert.equal(limited.status, 200);
  assert.equal(limited.data.store.platform.limits.products, 0);

  const product = await request('/api/seller/products', { method: 'POST', token: seller.token, headers, body: {} });
  assert.equal(product.status, 409);
  assert.equal(product.data.code, 'PLAN_LIMIT_REACHED');

  await Store.updateOne({ _id: seller.store.id }, { $set: { 'license.status': 'EXPIRED', 'license.endsAt': new Date('2026-01-01'), 'license.billingCycle': 'MONTHLY' } });
  const read = await request('/api/seller/products', { token: seller.token, headers });
  assert.equal(read.status, 200);
  const write = await request('/api/seller/categories', { method: 'POST', token: seller.token, headers, body: { name: 'Blocked category' } });
  assert.equal(write.status, 402);
  assert.equal(write.data.code, 'SUBSCRIPTION_REQUIRED');
});
