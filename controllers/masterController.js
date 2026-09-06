const mongoose = require('mongoose');
const { assertClientHandoverReady } = require('../services/clientHandoverService');
const User = require('../models/User');
const Preset = require('../models/IndustryPreset');
const { INDUSTRY_PRESETS } = require('../config/industryPresets');
const { assertMasterOwner, isOwnerPhone } = require('../config/masterOwner');
const { normalizePhone } = require('../utils/phoneUtils');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { readConfiguration, updateConfiguration, validateStructure, publicStructure } = require('../services/masterConfigurationService');
const { logAudit } = require('../services/auditService');
const requireId = (id) => { if (!mongoose.isValidObjectId(id)) throw new ApiError('VALIDATION_ERROR', 'Invalid preset ID'); return id; };
const master = (handler) => asyncHandler(async (req, res) => { assertMasterOwner(req.user); return handler(req, res); });

exports.publicCatalog = asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicStructure(await readConfiguration()));
});
exports.workspace = master(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const [configuration, presets, admins] = await Promise.all([
    readConfiguration(), Preset.find().select('name structure createdAt').sort('-createdAt').limit(100).lean(),
    User.find({ role: 'admin' }).select('name phone isBlocked systemRole').limit(100).lean(),
  ]);
  res.json({ configuration, presets, builtins: INDUSTRY_PRESETS, admins });
});
exports.update = master(async (req, res) => {
  const config = await updateConfiguration(req.user, req.body || {});
  logAudit({ req, action: 'MASTER_CONFIG_UPDATE', entityType: 'MasterConfiguration', entityId: config._id, after: { revision: config.revision, locked: config.locked, industry: config.structure.industry } });
  res.json(config);
});
exports.export = master(async (_req, res) => {
  const configuration = await readConfiguration();
  res.setHeader('Cache-Control', 'no-store');
  // No customers, orders, credentials, identities or session data in templates.
  res.json({ format: 'samira-store-template', version: 1, structure: configuration.structure });
});
exports.import = master(async (req, res) => {
  if (req.body?.template?.format !== 'samira-store-template' || req.body.template.version !== 1 ||
    JSON.stringify(req.body.template).length > 64000) throw new ApiError('VALIDATION_ERROR', 'Choose a supported store template under 64 KB');
  const config = await updateConfiguration(req.user, { revision: req.body.revision, structure: req.body.template.structure, note: 'Template imported into unlocked configuration' });
  logAudit({ req, action: 'MASTER_TEMPLATE_IMPORT', entityType: 'MasterConfiguration', entityId: config._id });
  res.json(config);
});
exports.createPreset = master(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 80) throw new ApiError('VALIDATION_ERROR', 'Enter a preset name under 80 characters');
  const structure = validateStructure(req.body?.structure);
  if (await Preset.countDocuments() >= 100) throw new ApiError('VALIDATION_ERROR', 'Keep at most 100 custom presets');
  const preset = await Preset.create({ name, structure, createdBy: req.user._id });
  logAudit({ req, action: 'MASTER_PRESET_CREATE', entityType: 'IndustryPreset', entityId: preset._id });
  res.status(201).json(preset);
});
exports.deletePreset = master(async (req, res) => {
  const preset = await Preset.findByIdAndDelete(requireId(req.params.id));
  if (!preset) throw new ApiError('NOT_FOUND', 'Preset not found');
  logAudit({ req, action: 'MASTER_PRESET_DELETE', entityType: 'IndustryPreset', entityId: preset._id });
  res.json({ success: true });
});
exports.provisionAdmin = master(async (req, res) => {
  await assertClientHandoverReady();
  const phone = normalizePhone(req.body?.phone);
  const name = String(req.body?.name || '').trim();
  if (!phone || isOwnerPhone(phone) || !name || name.length > 80) throw new ApiError('VALIDATION_ERROR', 'Enter a client name and a different valid Indian mobile number');
  let user = await User.findOne({ phone });
  if (user?.isBlocked) throw new ApiError('FORBIDDEN', 'Unblock the existing account before granting access');
  if (!user) user = new User({ name, phone, isPhoneVerified: false });
  user.role = 'admin'; user.systemRole = 'USER'; user.masterSessionVersion = undefined;
  user.availableModes = ['customer', 'admin']; user.activeMode = 'customer';
  await user.save();
  logAudit({ req, action: 'CLIENT_ADMIN_PROVISION', entityType: 'User', entityId: user._id });
  res.status(201).json({ _id: user._id, name: user.name, phone: user.phone, role: 'admin', systemRole: 'USER' });
});
