const { asyncHandler } = require('../middleware/validate');
const subscriptionService = require('../services/subscriptionService');
const { logAudit } = require('../services/auditService');

exports.status = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const result = await subscriptionService.subscriptionStatus(req.store);
  const period = result.subscription.endsAt ? new Date(result.subscription.endsAt).toISOString().slice(0, 10) : result.subscription.billingCycle;
  if (result.subscription.status === 'EXPIRED' || (result.subscription.daysRemaining !== null && result.subscription.daysRemaining <= 7)) {
    require('../services/notificationService').notifyLater({
      userId: req.user._id, storeId: req.store._id,
      event: result.subscription.status === 'EXPIRED' ? 'SUBSCRIPTION_EXPIRED' : 'SUBSCRIPTION_EXPIRING',
      title: result.subscription.status === 'EXPIRED' ? 'Subscription expired' : 'Subscription renewal due',
      message: result.subscription.status === 'EXPIRED' ? 'Renew your plan to create products, accept orders and make store changes.' : `Your plan has ${result.subscription.daysRemaining} day(s) remaining.`,
      metadata: { subscriptionId: `${req.store._id}:${period}` },
    });
  }
  res.json(result);
});

exports.checkout = asyncHandler(async (req, res) => {
  const result = await subscriptionService.createCheckout({ store: req.store, user: req.user, input: req.body || {} });
  await logAudit({ req, action: 'SUBSCRIPTION_PAYMENT_STARTED', entityType: 'Store', entityId: req.store._id, storeId: req.store._id, after: { plan: result.plan, billingCycle: result.billingCycle, amount: result.amount / 100 } });
  res.status(201).json(result);
});

exports.verify = asyncHandler(async (req, res) => {
  const result = await subscriptionService.verifyCheckout({ store: req.store, input: req.body || {} });
  await logAudit({ req, action: 'SUBSCRIPTION_ACTIVATED', entityType: 'Store', entityId: req.store._id, storeId: req.store._id, after: result.store.license });
  require('../services/notificationService').notifyLater({ userId: req.user._id, storeId: req.store._id, event: 'SUBSCRIPTION_ACTIVATED', title: 'Subscription active', message: `${result.store.plan} ${result.store.license.billingCycle.toLowerCase()} access is active.`, metadata: { subscriptionId: String(result.payment._id) } });
  res.json({ success: true, alreadyPaid: result.alreadyPaid, subscription: require('../config/storePlans').planSummary(result.store) });
});
