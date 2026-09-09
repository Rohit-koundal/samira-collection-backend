const User = require('../models/User');
const CustomerCrm = require('../models/CustomerCrm');
const Cart = require('../models/Cart');
const Order = require('../models/Order');
const { asyncHandler } = require('../middleware/validate');
const { notFound } = require('../utils/apiError');
const { optionalString, requireBoolean, requireEnum, requireObjectId } = require('../utils/validators');
const { CRM_TAGS, buildCustomerRows } = require('../services/crmService');
const { logAudit } = require('../services/auditService');
const { andFilter } = require('../services/storeService');

exports.list = asyncHandler(async (req, res) => {
  const rows = await buildCustomerRows(req.store._id);
  const users = await User.find({ _id: { $in: rows.map((row) => row.userId) } }).select('name email phone').lean();
  const byId = new Map(users.map((user) => [String(user._id), user]));
  const items = rows.map((row) => ({
    ...row,
    name: byId.get(row.userId)?.name,
    email: byId.get(row.userId)?.email,
    phone: byId.get(row.userId)?.phone,
  }));

  if (String(req.query.page || '').trim()) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 24));
    const start = (page - 1) * limit;
    return res.json({
      items: items.slice(start, start + limit),
      page,
      limit,
      total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / limit)),
    });
  }

  res.json(items);
});

exports.update = asyncHandler(async (req, res) => {
  const userId = requireObjectId(req.params.userId, 'user id');
  const user = await User.findById(userId).select('name email phone');
  if (!user) throw notFound('Customer not found');
  const belongsToStore = (await Promise.all([
    Order.exists(andFilter({ user: userId }, req.tenantFilter)),
    Cart.exists(andFilter({ user: userId }, req.tenantFilter)),
  ])).some(Boolean);
  if (!belongsToStore) throw notFound('Customer not found in this store');

  const tags = Array.isArray(req.body?.tags)
    ? req.body.tags.map((tag) => requireEnum(tag, CRM_TAGS, 'tag'))
    : undefined;
  const notes = req.body?.notes !== undefined ? optionalString(req.body.notes, 'notes', { max: 2000 }) : undefined;
  const acquisition = req.body?.acquisition !== undefined ? optionalString(req.body.acquisition, 'acquisition', { max: 80 }) : undefined;
  const marketingConsent = req.body?.marketingConsent !== undefined
    ? requireBoolean(req.body.marketingConsent, 'marketing consent')
    : undefined;
  const marketingConsentSource = marketingConsent === true ? 'MANUAL' : '';

  const profile = await CustomerCrm.findOneAndUpdate(
    { storeId: req.store._id, user: userId },
    {
      $set: {
        ...(tags ? { tags } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(acquisition !== undefined ? { acquisition } : {}),
        ...(marketingConsent !== undefined ? {
          marketingConsent,
          marketingConsentSource,
          marketingConsentAt: marketingConsent ? new Date() : null,
        } : {}),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  logAudit({
    req,
    action: 'CRM_UPDATE',
    entityType: 'CustomerCrm',
    entityId: profile._id,
    after: { tags: profile.tags, notes: profile.notes, marketingConsent: profile.marketingConsent },
  });

  res.json({
    userId,
    name: user.name,
    email: user.email,
    phone: user.phone,
    tags: profile.tags,
    notes: profile.notes,
    acquisition: profile.acquisition,
    marketingConsent: profile.marketingConsent,
    marketingConsentSource: profile.marketingConsentSource,
    marketingConsentAt: profile.marketingConsentAt,
  });
});
