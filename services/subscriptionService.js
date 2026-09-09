const Store = require('../models/Store');
const Product = require('../models/Product');
const Order = require('../models/Order');
const SubscriptionPayment = require('../models/SubscriptionPayment');
const { createRazorpayOrder, isRazorpayConfigured } = require('./razorpayService');
const { verifyRazorpaySignature } = require('../utils/paymentUtils');
const { ApiError } = require('../utils/apiError');
const {
  PLAN_IDS, STORE_PLANS, nextPeriodEnd, normalizeBillingCycle, normalizePlan, planSummary,
} = require('../config/storePlans');

const PAID_CYCLES = ['MONTHLY', 'YEARLY', 'LIFETIME'];

function planCatalog() {
  return Object.values(STORE_PLANS).map((plan) => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    features: [...plan.features],
    limits: { ...plan.limits },
    prices: { ...plan.prices },
  }));
}

function readPurchase(input = {}, store) {
  const plan = normalizePlan(input.plan, '');
  const billingCycle = normalizeBillingCycle(input.billingCycle, '');
  if (!PLAN_IDS.includes(plan)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid subscription plan');
  if (!PAID_CYCLES.includes(billingCycle)) throw new ApiError('VALIDATION_ERROR', 'Choose monthly, yearly or lifetime billing');
  const current = planSummary(store);
  const currentRank = PLAN_IDS.indexOf(current.id);
  const nextRank = PLAN_IDS.indexOf(plan);
  if (current.status === 'ACTIVE' && nextRank < currentRank) throw new ApiError('VALIDATION_ERROR', 'A lower plan can be selected after the current access period ends. Contact the platform owner if you need an immediate change.');
  if (current.status === 'ACTIVE' && current.billingCycle === 'LIFETIME' && billingCycle !== 'LIFETIME') throw new ApiError('VALIDATION_ERROR', 'Lifetime access cannot be replaced with a time-limited plan.');
  if (current.status === 'ACTIVE' && current.billingCycle === 'LIFETIME' && current.id === plan) throw new ApiError('DUPLICATE_REQUEST', 'Lifetime access is already active for this plan.');
  const amount = STORE_PLANS[plan].prices[billingCycle.toLowerCase()];
  if (!Number.isFinite(amount) || amount < 1) throw new ApiError('SERVICE_UNAVAILABLE', 'This subscription option is not available');
  return { plan, billingCycle, amount };
}

async function usageFor(storeId) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [products, ordersPerMonth] = await Promise.all([
    Product.countDocuments({ storeId, isArchived: { $ne: true } }),
    Order.countDocuments({ storeId, createdAt: { $gte: monthStart }, orderStatus: { $ne: 'Cancelled' } }),
  ]);
  return { products, ordersPerMonth };
}

async function subscriptionStatus(store) {
  const [usage, payments] = await Promise.all([
    usageFor(store._id),
    SubscriptionPayment.find({ store: store._id }).sort('-createdAt').limit(20).lean(),
  ]);
  return {
    subscription: planSummary(store),
    plans: planCatalog(),
    usage,
    checkout: { configured: isRazorpayConfigured(), keyId: isRazorpayConfigured() ? process.env.RAZORPAY_KEY_ID : null },
    payments: payments.map((item) => ({
      id: String(item._id), plan: item.plan, billingCycle: item.billingCycle,
      amount: item.amount, currency: item.currency, status: item.status,
      paymentId: item.razorpayPaymentId || null, paidAt: item.paidAt || null, createdAt: item.createdAt,
    })),
  };
}

async function createCheckout({ store, user, input }) {
  if (!isRazorpayConfigured()) throw new ApiError('SERVICE_UNAVAILABLE', 'Online subscription payment is not configured. Contact the platform owner.');
  const purchase = readPurchase(input, store);
  const recent = new Date(Date.now() - 15 * 60 * 1000);
  let payment = await SubscriptionPayment.findOne({
    store: store._id, user: user._id, plan: purchase.plan, billingCycle: purchase.billingCycle,
    amount: purchase.amount, status: 'CREATED', razorpayOrderId: { $exists: true }, createdAt: { $gte: recent },
  }).sort('-createdAt');

  if (!payment) {
    const receipt = `sub_${String(store._id).slice(-8)}_${Date.now().toString(36)}`.slice(0, 40);
    payment = await SubscriptionPayment.create({ store: store._id, user: user._id, ...purchase, receipt });
    try {
      const order = await createRazorpayOrder({
        amountInPaise: purchase.amount * 100,
        receipt,
        notes: { purpose: 'STORE_SUBSCRIPTION', storeId: String(store._id), subscriptionPaymentId: String(payment._id), plan: purchase.plan, billingCycle: purchase.billingCycle },
      });
      payment.razorpayOrderId = order.id;
      await payment.save();
    } catch (error) {
      payment.status = 'FAILED';
      payment.failureReason = String(error.message || 'Unable to start payment').slice(0, 300);
      await payment.save().catch(() => null);
      throw new ApiError('SERVICE_UNAVAILABLE', error.razorpayAuthError ? 'Subscription payment credentials were rejected by Razorpay.' : 'Unable to start subscription payment. Please try again.');
    }
  }

  return {
    subscriptionPaymentId: String(payment._id), orderId: payment.razorpayOrderId,
    amount: payment.amount * 100, currency: payment.currency, keyId: process.env.RAZORPAY_KEY_ID,
    plan: payment.plan, billingCycle: payment.billingCycle, storeName: store.name,
  };
}

async function activatePaidSubscription(payment) {
  const store = await Store.findById(payment.store);
  if (!store) throw new ApiError('NOT_FOUND', 'Store not found for this subscription');
  const now = payment.paidAt || new Date();
  let periodStart = payment.periodStart ? new Date(payment.periodStart) : new Date(now);
  if (!payment.periodStart) {
    const current = planSummary(store, periodStart);
    if (payment.billingCycle !== 'LIFETIME' && current.status === 'ACTIVE' && current.id === payment.plan && current.endsAt && new Date(current.endsAt) > periodStart) periodStart = new Date(current.endsAt);
  }
  const periodEnd = payment.periodStart ? (payment.periodEnd ? new Date(payment.periodEnd) : null) : nextPeriodEnd(payment.billingCycle, periodStart);
  store.plan = payment.plan;
  store.license.status = 'ACTIVE';
  store.license.billingCycle = payment.billingCycle;
  store.license.startsAt = payment.paidAt || now;
  store.license.endsAt = periodEnd || undefined;
  store.license.lastPayment = {
    orderId: payment.razorpayOrderId, paymentId: payment.razorpayPaymentId,
    amount: payment.amount, currency: payment.currency, paidAt: payment.paidAt || now,
  };
  await store.save();
  if (!payment.periodStart || String(payment.periodEnd || '') !== String(periodEnd || '')) {
    payment.periodStart = periodStart;
    payment.periodEnd = periodEnd || undefined;
    await payment.save();
  }
  return store;
}

async function markPaid(payment, { razorpayPaymentId, signatureVerified = false } = {}) {
  if (payment.status === 'PAID' && payment.periodStart) {
    return { payment, store: await activatePaidSubscription(payment), alreadyPaid: true };
  }
  const paidAt = new Date();
  const currentStore = await Store.findById(payment.store);
  if (!currentStore) throw new ApiError('NOT_FOUND', 'Store not found for this subscription');
  let periodStart = paidAt;
  const current = planSummary(currentStore, paidAt);
  if (payment.billingCycle !== 'LIFETIME' && current.status === 'ACTIVE' && current.id === payment.plan && current.endsAt && new Date(current.endsAt) > paidAt) periodStart = new Date(current.endsAt);
  const periodEnd = nextPeriodEnd(payment.billingCycle, periodStart);
  const claimed = await SubscriptionPayment.findOneAndUpdate(
    { _id: payment._id, status: { $ne: 'PAID' } },
    { $set: { status: 'PAID', razorpayPaymentId, signatureVerified, paidAt, periodStart, ...(periodEnd ? { periodEnd } : {}), failureReason: undefined } },
    { new: true },
  );
  const paid = claimed || await SubscriptionPayment.findById(payment._id);
  return { payment: paid, store: await activatePaidSubscription(paid), alreadyPaid: !claimed };
}

async function verifyCheckout({ store, input }) {
  const orderId = String(input.razorpay_order_id || input.orderId || '').trim();
  const paymentId = String(input.razorpay_payment_id || input.paymentId || '').trim();
  const signature = String(input.razorpay_signature || input.signature || '').trim();
  const payment = await SubscriptionPayment.findOne({ razorpayOrderId: orderId, store: store._id });
  if (!payment) throw new ApiError('NOT_FOUND', 'Subscription payment was not found');
  if (payment.status === 'PAID') return markPaid(payment, { razorpayPaymentId: payment.razorpayPaymentId, signatureVerified: payment.signatureVerified });
  if (!verifyRazorpaySignature({ razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature, secret: process.env.RAZORPAY_KEY_SECRET })) {
    throw new ApiError('PAYMENT_FAILED', 'Subscription payment verification failed');
  }
  return markPaid(payment, { razorpayPaymentId: paymentId, signatureVerified: true });
}

async function handleWebhook({ razorpayOrderId, razorpayPaymentId, event }) {
  if (!['payment.captured', 'order.paid'].includes(event) || !razorpayOrderId) return null;
  const payment = await SubscriptionPayment.findOne({ razorpayOrderId });
  if (!payment) return null;
  return markPaid(payment, { razorpayPaymentId: razorpayPaymentId || payment.razorpayPaymentId, signatureVerified: true });
}

module.exports = { createCheckout, handleWebhook, planCatalog, subscriptionStatus, usageFor, verifyCheckout };
