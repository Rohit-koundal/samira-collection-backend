const Settings = require('../models/Settings');
const { cleanMultilineText, cleanString, finiteMoney, pick } = require('../utils/requestValidation');

const PUBLIC_FIELDS = [
  'storeName', 'contactEmail', 'contactPhone', 'whatsappNumber', 'address', 'freeShippingMinAmount',
  'deliveryCharge', 'codEnabled', 'codCharge', 'codMaxAmount', 'razorpayEnabled', 'upiEnabled',
  'cardPaymentEnabled', 'netBankingEnabled', 'walletEnabled', 'socialLinks', 'footerText',
  'returnPolicy', 'privacyPolicy', 'termsConditions',
];
const ADMIN_FIELDS = [
  ...PUBLIC_FIELDS, 'sellerLegalName', 'sellerAddress', 'sellerState', 'gstin', 'invoicePrefix', 'taxEnabled',
];

exports.getSettings = async (req, res) => {
  let settings = await Settings.findOne();
  if (!settings) settings = await Settings.create({});
  const isAdmin = ['admin', 'owner'].includes(req.user?.role)
    && String(req.baseUrl || '').startsWith('/api/admin/settings');
  const data = settings.toObject();
  return res.json(pick(data, isAdmin ? ADMIN_FIELDS : PUBLIC_FIELDS));
};

exports.updateSettings = async (req, res) => {
  const payload = normalizeSettings(pick(req.body, ADMIN_FIELDS));
  if (!payload.storeName && !(await Settings.exists({}))) {
    return res.status(400).json({ message: 'Store name is required' });
  }
  const settings = await Settings.findOneAndUpdate({}, payload, {
    new: true,
    upsert: true,
    runValidators: true,
    setDefaultsOnInsert: true,
  });
  return res.json(settings);
};

function normalizeSettings(data) {
  const payload = { ...data };
  for (const field of ['storeName', 'contactPhone', 'whatsappNumber', 'invoicePrefix', 'sellerState', 'gstin']) {
    if (payload[field] !== undefined) payload[field] = cleanString(payload[field], { field, max: 160 });
  }
  for (const field of ['address', 'sellerAddress', 'footerText', 'returnPolicy', 'privacyPolicy', 'termsConditions']) {
    if (payload[field] !== undefined) payload[field] = cleanMultilineText(payload[field], { field, max: 10000 });
  }
  if (payload.contactEmail !== undefined) {
    payload.contactEmail = String(payload.contactEmail || '').trim().toLowerCase();
    if (payload.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.contactEmail)) throw validationError('Valid email is required');
  }
  for (const field of ['freeShippingMinAmount', 'deliveryCharge', 'codCharge', 'codMaxAmount']) {
    if (payload[field] !== undefined && payload[field] !== '') payload[field] = finiteMoney(payload[field], { field });
  }
  for (const field of ['codEnabled', 'razorpayEnabled', 'upiEnabled', 'cardPaymentEnabled', 'netBankingEnabled', 'walletEnabled', 'taxEnabled']) {
    if (payload[field] !== undefined && typeof payload[field] !== 'boolean') throw validationError(`${field} must be a boolean`);
  }
  if (payload.socialLinks !== undefined) {
    if (!payload.socialLinks || typeof payload.socialLinks !== 'object' || Array.isArray(payload.socialLinks)) throw validationError('socialLinks must be an object');
    payload.socialLinks = Object.fromEntries(Object.entries(payload.socialLinks).slice(0, 20).map(([name, url]) => {
      const safeName = cleanString(name, { field: 'social link name', min: 1, max: 40, required: true });
      const safeUrl = String(url || '').trim();
      if (safeUrl && !/^https:\/\//i.test(safeUrl)) throw validationError('Social links must use HTTPS');
      return [safeName, safeUrl];
    }));
  }
  return payload;
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}
