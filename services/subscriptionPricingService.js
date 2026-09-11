const SubscriptionPricing = require('../models/SubscriptionPricing');
const { PLAN_IDS, STORE_PLANS } = require('../config/storePlans');
const { assertMasterOwner } = require('../config/masterOwner');
const { ApiError } = require('../utils/apiError');

const CYCLES = ['monthly', 'yearly', 'lifetime'];
const clone = (value) => JSON.parse(JSON.stringify(value));

function defaultPrices() {
  return Object.fromEntries(PLAN_IDS.map((id) => [id, { ...STORE_PLANS[id].prices }]));
}

function priceValue(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000000) {
    throw new ApiError('VALIDATION_ERROR', `${label} must be a whole rupee amount between 1 and 1,00,00,000`);
  }
  return amount;
}

function normalizePrices(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return Object.fromEntries(PLAN_IDS.map((id) => {
    const plan = source[id] || source[id.toLowerCase()] || {};
    return [id, Object.fromEntries(CYCLES.map((cycle) => [cycle, priceValue(plan[cycle], `${STORE_PLANS[id].name} ${cycle} price`)]))];
  }));
}

function documentView(document) {
  const data = document?.toObject ? document.toObject() : document;
  const prices = data?.prices || defaultPrices();
  return {
    revision: Number(data?.revision || 0),
    currency: data?.currency || 'INR',
    taxMode: data?.taxMode || 'INCLUSIVE',
    gstPercent: Number(data?.gstPercent ?? 18),
    updatedAt: data?.updatedAt || null,
    plans: PLAN_IDS.map((id) => ({
      id,
      name: STORE_PLANS[id].name,
      description: STORE_PLANS[id].description,
      features: [...STORE_PLANS[id].features],
      limits: { ...STORE_PLANS[id].limits },
      prices: { ...STORE_PLANS[id].prices, ...(prices[id]?.toObject?.() || prices[id] || {}) },
    })),
  };
}

async function readPlanPricing() {
  return documentView(await SubscriptionPricing.findById('platform').lean());
}

async function updatePlanPricing(user, input = {}) {
  assertMasterOwner(user);
  const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision < 0) throw new ApiError('VALIDATION_ERROR', 'The current pricing revision is required');
  const reason = String(input.reason || '').trim();
  if (reason.length < 3 || reason.length > 500) throw new ApiError('VALIDATION_ERROR', 'Add a pricing change reason between 3 and 500 characters');
  const taxMode = String(input.taxMode || '').toUpperCase();
  if (!['INCLUSIVE', 'EXCLUSIVE'].includes(taxMode)) throw new ApiError('VALIDATION_ERROR', 'Choose whether GST is included or added at checkout');
  const gstPercent = Number(input.gstPercent);
  if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 28) throw new ApiError('VALIDATION_ERROR', 'GST must be between 0% and 28%');
  const prices = normalizePrices(input.prices);
  const before = await SubscriptionPricing.findById('platform').lean();
  const currentRevision = Number(before?.revision || 0);
  if (revision !== currentRevision) throw new ApiError('DUPLICATE_REQUEST', 'Plan pricing changed in another session. Reload before saving.');
  const history = {
    revision: currentRevision,
    prices: clone(before?.prices || defaultPrices()),
    taxMode: before?.taxMode || 'INCLUSIVE',
    gstPercent: Number(before?.gstPercent ?? 18),
    reason,
    actor: String(user._id),
    at: new Date(),
  };
  let saved;
  try {
    saved = await SubscriptionPricing.findOneAndUpdate(
      { _id: 'platform', revision: currentRevision },
      {
        $set: { currency: 'INR', taxMode, gstPercent, prices, updatedBy: user._id },
        $inc: { revision: 1 },
        $push: { history: { $each: [history], $slice: -30 } },
      },
      { new: true, upsert: currentRevision === 0 && !before, runValidators: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error?.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'Plan pricing changed while saving. Reload and try again.');
    throw error;
  }
  if (!saved) throw new ApiError('DUPLICATE_REQUEST', 'Plan pricing changed while saving. Reload and try again.');
  return documentView(saved);
}

async function priceFor(planId, billingCycle) {
  const plan = String(planId || '').toUpperCase();
  const cycle = String(billingCycle || '').toLowerCase();
  if (!PLAN_IDS.includes(plan) || !CYCLES.includes(cycle)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid plan and billing period');
  const pricing = await readPlanPricing();
  const selected = pricing.plans.find((item) => item.id === plan);
  const baseAmount = Number(selected?.prices?.[cycle]);
  if (!Number.isSafeInteger(baseAmount) || baseAmount < 1) throw new ApiError('SERVICE_UNAVAILABLE', 'This subscription option is not available');
  const taxAmount = pricing.taxMode === 'EXCLUSIVE' ? Math.round(baseAmount * pricing.gstPercent / 100) : 0;
  return { amount: baseAmount + taxAmount, baseAmount, taxAmount, currency: pricing.currency, taxMode: pricing.taxMode, gstPercent: pricing.gstPercent, pricingRevision: pricing.revision };
}

module.exports = { CYCLES, defaultPrices, priceFor, readPlanPricing, updatePlanPricing };
