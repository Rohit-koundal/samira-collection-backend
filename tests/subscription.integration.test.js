const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createMasterOwner, createProvisionedSeller } = require('./accessFixtures');
const Store = require('../models/Store');
const SubscriptionPayment = require('../models/SubscriptionPayment');
const Notification = require('../models/Notification');
const { reconcileSubscriptionLifecycles } = require('../services/subscriptionLifecycleService');

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

test('master pricing is revisioned and seller checkout uses its GST-aware backend quote', async () => {
  const master = await createMasterOwner();
  const current = await request('/api/master/plan-pricing', { token: master.token });
  assert.equal(current.status, 200);
  assert.equal(current.data.revision, 0);
  const prices = Object.fromEntries(current.data.plans.map((plan) => [plan.id, { ...plan.prices }]));
  prices.PROFESSIONAL.monthly = 2000;
  const changed = await request('/api/master/plan-pricing', {
    method: 'PUT', token: master.token,
    body: { revision: 0, prices, taxMode: 'EXCLUSIVE', gstPercent: 18, reason: 'Validate checkout pricing source' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.revision, 1);
  assert.equal(changed.data.plans.find((plan) => plan.id === 'PROFESSIONAL').prices.monthly, 2000);

  const seller = await createProvisionedSeller('Dynamic Price Boutique');
  const headers = { 'x-store-id': seller.store.id };
  const catalog = await request('/api/seller/subscription', { token: seller.token, headers });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.pricing.taxMode, 'EXCLUSIVE');
  assert.equal(catalog.data.plans.find((plan) => plan.id === 'PROFESSIONAL').prices.monthly, 2000);
  const checkout = await request('/api/seller/subscription/checkout', {
    method: 'POST', token: seller.token, headers,
    body: { plan: 'PROFESSIONAL', billingCycle: 'MONTHLY', amount: 1 },
  });
  assert.equal(checkout.status, 201);
  assert.equal(checkout.data.amount, 2360 * 100);
  const payment = await SubscriptionPayment.findById(checkout.data.subscriptionPaymentId).lean();
  assert.equal(payment.baseAmount, 2000);
  assert.equal(payment.taxAmount, 360);
  assert.equal(payment.pricingRevision, 1);

  const stale = await request('/api/master/plan-pricing', {
    method: 'PUT', token: master.token,
    body: { revision: 0, prices, taxMode: 'INCLUSIVE', gstPercent: 18, reason: 'Stale browser update' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'DUPLICATE_REQUEST');
});

test('master limits and expiry are enforced by backend while seller reads remain available', async () => {
  const seller = await createProvisionedSeller('Limited Boutique');
  const master = await createMasterOwner();
  const headers = { 'x-store-id': seller.store.id };
  const limited = await request(`/api/master/stores/${seller.store.id}/subscription`, {
    method: 'PATCH', token: master.token,
    body: { baseRevision: 0, reason: 'Apply test catalogue limits', plan: 'BASIC', licenseStatus: 'TRIAL', billingCycle: 'TRIAL', limitOverrides: { products: 0, ordersPerMonth: 10 } },
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

test('subscription lifecycle expires due access and deduplicates owner reminders', async () => {
  const seller = await createProvisionedSeller('Lifecycle Boutique');
  const now = new Date('2026-09-11T12:00:00.000Z');
  const end = new Date(now.getTime() + 3 * 86400000);
  await Store.updateOne({ _id: seller.store.id }, { $set: {
    owner: seller.user._id,
    'license.status': 'ACTIVE',
    'license.billingCycle': 'MONTHLY',
    'license.endsAt': end,
  } });

  const first = await reconcileSubscriptionLifecycles({ now });
  const second = await reconcileSubscriptionLifecycles({ now });
  assert.equal(first.reminders, 1);
  assert.equal(second.reminders, 1);
  assert.equal(await Notification.countDocuments({ user: seller.user._id, event: 'SUBSCRIPTION_EXPIRING' }), 1);

  const afterEnd = new Date(end.getTime() + 1000);
  const expired = await reconcileSubscriptionLifecycles({ now: afterEnd });
  assert.equal(expired.expired, 1);
  assert.equal((await Store.findById(seller.store.id)).license.status, 'EXPIRED');
  assert.equal(await Notification.countDocuments({ user: seller.user._id, event: 'SUBSCRIPTION_EXPIRED' }), 1);
  const replay = await reconcileSubscriptionLifecycles({ now: afterEnd });
  assert.equal(replay.expired, 0);
  assert.equal(await Notification.countDocuments({ user: seller.user._id, event: 'SUBSCRIPTION_EXPIRED' }), 1);
});
