const Settings = require('../models/Settings');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { buildPaymentOptions, getStoreSettings } = require('../services/paymentSettingsService');
const { isRazorpayConfigured } = require('../services/razorpayService');
const { logAudit } = require('../services/auditService');

exports.getSettings = asyncHandler(async (req, res) => {
  res.json((await Settings.findOne()) || await Settings.create({}));
});

/**
 * Payment methods the storefront may offer, derived from the same admin
 * settings the checkout API enforces.
 */
exports.getPaymentMethods = asyncHandler(async (req, res) => {
  const settings = await getStoreSettings();
  res.json({
    methods: buildPaymentOptions(settings, { razorpayConfigured: isRazorpayConfigured() }),
    codCharge: Math.max(0, Number(settings.codCharge || 0)),
    codMaxAmount: Number(settings.codMaxAmount || 0) || null,
    codMinAmount: Number(settings.codMinAmount || 0) || null,
    deliveryCharge: Number(settings.deliveryCharge ?? 99),
    freeShippingMinAmount: Number(settings.freeShippingMinAmount ?? 999),
    platformFee: Number(settings.platformFee ?? 23),
    gstRate: Number(settings.gstRate ?? 5),
  });
});

exports.updateSettings = asyncHandler(async (req, res) => {
  // The admin form round-trips the whole document, so drop the fields Mongo
  // owns before using it as an update.
  const { _id, __v, createdAt, updatedAt, ...updates } = req.body || {};

  if (!String(updates.storeName || '').trim()) {
    throw new ApiError('VALIDATION_ERROR', 'Store name is required');
  }
  if (updates.contactEmail && !/^\S+@\S+\.\S+$/.test(updates.contactEmail)) {
    throw new ApiError('VALIDATION_ERROR', 'Valid email is required');
  }

  for (const field of ['deliveryCharge', 'freeShippingMinAmount', 'codCharge', 'codMaxAmount', 'codMinAmount', 'returnWindowDays', 'prepaidDiscountValue', 'rtoBlockMinOrders', 'rtoBlockThreshold', 'platformFee', 'gstRate']) {
    if (updates[field] === undefined || updates[field] === '') continue;
    const value = Number(updates[field]);
    if (!Number.isFinite(value) || value < 0) {
      throw new ApiError('VALIDATION_ERROR', `${field} must be zero or a positive number`);
    }
    updates[field] = value;
  }

  if (updates.codPincodes !== undefined) {
    updates.codPincodes = Array.isArray(updates.codPincodes)
      ? updates.codPincodes.map((pin) => String(pin || '').replace(/\D/g, '')).filter((pin) => /^\d{6}$/.test(pin))
      : String(updates.codPincodes || '').split(/[,\s]+/).map((pin) => pin.replace(/\D/g, '')).filter((pin) => /^\d{6}$/.test(pin));
  }
  if (updates.prepaidDiscountType && !['Percentage', 'Flat', ''].includes(updates.prepaidDiscountType)) {
    throw new ApiError('VALIDATION_ERROR', 'Prepaid discount type must be Percentage or Flat');
  }

  const saved = await Settings.findOneAndUpdate({}, updates, { new: true, upsert: true, runValidators: true });
  logAudit({ req, action: 'SETTINGS_UPDATE', entityType: 'Settings', entityId: saved._id });
  res.json(saved);
});
