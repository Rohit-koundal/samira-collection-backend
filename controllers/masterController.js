const mongoose = require('mongoose');
const { assertClientHandoverReady } = require('../services/clientHandoverService');
const User = require('../models/User');
const Store = require('../models/Store');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Preset = require('../models/IndustryPreset');
const PlatformRelease = require('../models/PlatformRelease');
const { INDUSTRY_PRESETS, INDUSTRY_IDS, getIndustryPreset } = require('../config/industryPresets');
const { BILLING_CYCLES, LICENSE_STATUSES, LIMIT_KEYS, PLAN_IDS, STORE_PLANS, nextPeriodEnd, normalizeBillingCycle, normalizePlan, planSummary } = require('../config/storePlans');
const { assertMasterOwner, isOwnerPhone } = require('../config/masterOwner');
const { normalizePhone } = require('../utils/phoneUtils');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { readConfiguration, updateConfiguration, validateStructure, publicStructure } = require('../services/masterConfigurationService');
const { previewProject, generateProject, normalizeProject } = require('../services/projectGeneratorService');
const clientPlatform = require('../services/clientPlatformService');
const { signingReady } = require('../services/licenseSignatureService');
const { logAudit } = require('../services/auditService');
const requireId = (id) => { if (!mongoose.isValidObjectId(id)) throw new ApiError('VALIDATION_ERROR', 'Invalid preset ID'); return id; };
const master = (handler) => asyncHandler(async (req, res) => { assertMasterOwner(req.user); return handler(req, res); });

function platformStoreView(store) {
  const data = typeof store?.toObject === 'function' ? store.toObject() : { ...store };
  const owner = data.owner && typeof data.owner === 'object' ? {
    id: String(data.owner._id || data.owner.id || ''),
    name: data.owner.name || '',
    phone: data.owner.phone || '',
    email: data.owner.email || '',
  } : null;
  return {
    id: String(data._id),
    name: data.name,
    slug: data.slug,
    status: data.status,
    isDefault: Boolean(data.isDefault),
    industry: data.industry || 'fashion',
    industryRevision: Number(data.industryRevision || 0),
    migration: data.industryMigration || { status: 'READY', totalProducts: 0, missingRequired: 0, legacyAttributes: 0 },
    owner,
    platform: planSummary(data),
    createdAt: data.createdAt,
  };
}

exports.publicCatalog = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
  res.setHeader('Vary', 'Host, X-Store-Slug');
  res.json(publicStructure(await readConfiguration(req.store?._id)));
});
exports.workspace = master(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const [configuration, presets, admins, stores, installations, releases] = await Promise.all([
    readConfiguration(), Preset.find().select('name key isActive isBuiltinCopy structure createdAt').sort('-createdAt').limit(100).lean(),
    User.find({ role: 'admin' }).select('name phone isBlocked systemRole').limit(100).lean(),
    Store.find().populate('owner', 'name phone email').sort('-createdAt').limit(250).lean(),
    clientPlatform.listInstallations(),
    PlatformRelease.find().sort('-publishedAt').limit(100).lean(),
  ]);
  const customIndustries = presets.filter((preset) => preset.isActive !== false).map((preset) => ({
    ...preset.structure, id: preset.key || preset.structure?.industry, industry: preset.key || preset.structure?.industry,
    name: preset.name, custom: true, presetId: String(preset._id),
  }));
  res.json({
    configuration,
    presets,
    builtins: INDUSTRY_PRESETS,
    industryOptions: [...INDUSTRY_PRESETS, ...customIndustries],
    admins,
    plans: Object.values(STORE_PLANS),
    stores: stores.map(platformStoreView),
    installations,
    releases: releases.map((release) => ({ ...release, id: String(release._id), _id: undefined })),
    controlPlane: {
      signingReady: signingReady(),
      deploymentHooksReady: Boolean(String(process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY || '').trim()),
      appVersion: String(process.env.APP_VERSION || '1.0.0'),
    },
  });
});

exports.clientControl = master(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const result = await clientPlatform.clientControlWorkspace(req.query || {});
  res.json({
    ...result,
    industryOptions: [...INDUSTRY_PRESETS, ...(await Preset.find({ isActive: { $ne: false } }).select('name key structure.industry').limit(100).lean()).map((preset) => ({ industry: preset.key || preset.structure?.industry, name: preset.name }))],
    controlPlane: { signingReady: signingReady(), deploymentHooksReady: Boolean(String(process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY || '').trim()), appVersion: String(process.env.APP_VERSION || '1.0.0') },
  });
});

exports.installationOperations = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const result = await clientPlatform.installationOperations(req.params.id);
  const AuditLog = require('../models/AuditLog');
  const activity = await AuditLog.find({ entityType: 'ClientInstallation', entityId: req.params.id }).select('-before -after -ip -http').sort('-createdAt').limit(50).lean();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...result, activity: activity.map((item) => ({ id: String(item._id), action: item.action, summary: item.summary || '', outcome: item.outcome || 'SUCCESS', createdAt: item.createdAt, actor: item.actorSnapshot?.name || 'System' })) });
});

exports.previewProject = master(async (req, res) => {
  const target = await resolveIndustry(String(req.body?.industry || '').trim().toLowerCase());
  res.setHeader('Cache-Control', 'no-store');
  res.json(await previewProject(req.body || {}, target));
});

exports.generateProject = master(async (req, res) => {
  const target = await resolveIndustry(String(req.body?.industry || '').trim().toLowerCase());
  const project = normalizeProject(req.body || {}, target);
  const provisioned = await clientPlatform.provisionInstallation(project, req.user);
  let result;
  try {
    result = await generateProject(req.body || {}, target, { installation: provisioned.credentials });
  } catch (error) {
    await clientPlatform.updateInstallation(provisioned.installation._id, { status: 'REVOKED', statusReason: 'Project package generation failed before delivery.', notes: 'Project package generation failed before delivery.' }).catch(() => null);
    throw error;
  }
  await logAudit({
    req,
    action: 'STANDALONE_PROJECT_GENERATE',
    entityType: 'ProjectTemplate',
    entityId: result.project.projectSlug,
    after: { companyName: result.project.companyName, industry: result.project.industry, files: result.files, installationId: provisioned.credentials.installationId },
  });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${result.project.projectSlug}.zip"`);
  res.setHeader('Content-Length', String(result.buffer.length));
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(result.buffer);
});

exports.updateInstallation = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const installation = await clientPlatform.updateInstallation(req.params.id, req.body || {});
  await logAudit({ req, action: 'CLIENT_INSTALLATION_UPDATE', entityType: 'ClientInstallation', entityId: req.params.id, after: installation });
  res.json({ installation });
});

exports.rotateInstallationKey = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const credentials = await clientPlatform.rotateInstallationKey(req.params.id);
  await logAudit({ req, action: 'CLIENT_INSTALLATION_KEY_ROTATE', entityType: 'ClientInstallation', entityId: req.params.id, after: { installationId: credentials.CLIENT_INSTALLATION_ID } });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ notice: 'Replace the backend installation environment values immediately. The previous key no longer works.', credentials });
});

exports.deployInstallation = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const installation = await clientPlatform.triggerDeployment(req.params.id);
  await logAudit({ req, action: 'CLIENT_INSTALLATION_DEPLOY', entityType: 'ClientInstallation', entityId: req.params.id, after: { targetVersion: installation.targetVersion, deployment: installation.deployment } });
  res.json({ installation });
});

exports.createRelease = master(async (req, res) => {
  const release = await clientPlatform.createRelease(req.body || {}, req.user);
  await logAudit({ req, action: 'PLATFORM_RELEASE_CREATE', entityType: 'PlatformRelease', entityId: release._id, after: { version: release.version, channel: release.channel, mandatory: release.mandatory } });
  res.status(201).json({ release });
});

async function resolveIndustry(industry) {
  const builtin = INDUSTRY_PRESETS.find((item) => item.industry === industry);
  if (builtin) return builtin;
  const custom = await Preset.findOne({ key: industry, isActive: { $ne: false } }).lean();
  if (!custom) throw new ApiError('VALIDATION_ERROR', 'Choose an active business type');
  return { ...custom.structure, id: custom.key, industry: custom.key, name: custom.name };
}

async function industryImpact(store, target) {
  const current = store.catalogStructure || getIndustryPreset(store.industry);
  const currentKeys = new Set((current.attributes || []).map((item) => item.key));
  const nextKeys = new Set((target.attributes || []).map((item) => item.key));
  const addedAttributes = (target.attributes || []).filter((item) => !currentKeys.has(item.key)).map((item) => item.label);
  const inactiveAttributes = (current.attributes || []).filter((item) => !nextKeys.has(item.key)).map((item) => item.label);
  const existingNames = await Category.find({ storeId: store._id }).select('name').lean();
  const names = new Set(existingNames.map((item) => String(item.name || '').toLowerCase()));
  const addedCategories = (target.defaultCategories || []).filter((name) => !names.has(String(name).toLowerCase()));
  const required = (target.attributes || []).filter((item) => item.required).map((item) => item.key);
  const legacy = (current.attributes || []).filter((item) => !nextKeys.has(item.key)).map((item) => item.key);
  const [totalProducts, missingRequired, legacyAttributes] = await Promise.all([
    Product.countDocuments({ storeId: store._id, isArchived: { $ne: true } }),
    required.length ? Product.countDocuments({ storeId: store._id, isArchived: { $ne: true }, $or: required.map((key) => ({ [`attributeValues.${key}`]: { $exists: false } })) }) : 0,
    legacy.length ? Product.countDocuments({ storeId: store._id, isArchived: { $ne: true }, 'specifications.key': { $in: legacy } }) : 0,
  ]);
  return { addedCategories, addedAttributes, inactiveAttributes, variantAttributes: target.variantConfig?.attributes || [], productSections: target.productSections || [], totalProducts, missingRequired, legacyAttributes };
}

exports.previewStoreIndustry = master(async (req, res) => {
  const store = await Store.findById(requireId(req.params.id));
  if (!store) throw new ApiError('NOT_FOUND', 'Store not found');
  const industry = String(req.query.industry || '').trim().toLowerCase();
  const target = await resolveIndustry(industry);
  const currentName = store.catalogStructure?.name || INDUSTRY_PRESETS.find((item) => item.industry === store.industry)?.name || store.industry;
  res.json({ from: { id: store.industry, name: currentName }, to: { id: target.industry, name: target.name }, impact: await industryImpact(store, target), preservesData: true, reversible: true });
});

exports.updateStorePlatform = master(async (req, res) => {
  const store = await Store.findById(requireId(req.params.id));
  if (!store) throw new ApiError('NOT_FOUND', 'Store not found');
  const before = platformStoreView(store);
  let converted = false;
  store.license ||= {};

  if (req.body?.industry !== undefined) {
    const industry = String(req.body.industry || '').trim().toLowerCase();
    if (industry !== store.industry) {
      if (req.body.confirmIndustryChange !== true) throw new ApiError('CONFIRMATION_REQUIRED', 'Preview and confirm the industry change before applying it');
      const preset = await resolveIndustry(industry);
      const impact = await industryImpact(store, preset);
      const previousIndustry = store.industry;
      const configurations = store.industryConfigurations && typeof store.industryConfigurations === 'object'
        ? (store.industryConfigurations instanceof Map ? Object.fromEntries(store.industryConfigurations) : { ...store.industryConfigurations }) : {};
      configurations[previousIndustry] = store.catalogStructure || JSON.parse(JSON.stringify(getIndustryPreset(previousIndustry)));
      store.industry = industry;
      store.catalogStructure = { ...JSON.parse(JSON.stringify(configurations[industry] || preset)), industry, id: industry, name: preset.name, clientPermissions: store.catalogStructure?.clientPermissions || { content: true, payments: true } };
      configurations[industry] = store.catalogStructure;
      store.industryConfigurations = configurations;
      store.industryRevision = Number(store.industryRevision || 0) + 1;
      store.industryMigration = {
        status: impact.totalProducts ? 'REVIEW_REQUIRED' : 'READY', fromIndustry: previousIndustry, toIndustry: industry,
        totalProducts: impact.totalProducts, missingRequired: impact.missingRequired, legacyAttributes: impact.legacyAttributes,
        switchedAt: new Date(), completedAt: impact.totalProducts ? undefined : new Date(),
      };
      store.markModified?.('industryConfigurations');
      store.markModified?.('catalogStructure');
      converted = true;
    }
  }

  if (req.body?.plan !== undefined) {
    const plan = String(req.body.plan || '').trim().toUpperCase();
    if (!PLAN_IDS.includes(plan)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid store plan');
    store.plan = normalizePlan(plan);
  }
  if (req.body?.licenseStatus !== undefined) {
    const status = String(req.body.licenseStatus || '').trim().toUpperCase();
    if (!LICENSE_STATUSES.includes(status)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid licence status');
    store.license.status = status;
  }
  if (req.body?.billingCycle !== undefined) {
    const cycle = String(req.body.billingCycle || '').trim().toUpperCase();
    if (!BILLING_CYCLES.includes(cycle)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid billing cycle');
    store.license.billingCycle = cycle;
  }
  if (req.body?.grantCycle !== undefined) {
    const cycle = normalizeBillingCycle(req.body.grantCycle, '');
    if (!['TRIAL', 'MONTHLY', 'YEARLY', 'LIFETIME'].includes(cycle)) throw new ApiError('VALIDATION_ERROR', 'Choose trial, monthly, yearly or lifetime access');
    const now = new Date();
    let periodStart = now;
    const current = planSummary(store, now);
    if (cycle !== 'TRIAL' && cycle !== 'LIFETIME' && current.status === 'ACTIVE' && current.endsAt && new Date(current.endsAt) > now) periodStart = new Date(current.endsAt);
    const periodEnd = nextPeriodEnd(cycle, periodStart);
    store.license.status = cycle === 'TRIAL' ? 'TRIAL' : 'ACTIVE';
    store.license.billingCycle = cycle;
    store.license.startsAt = now;
    store.license.endsAt = periodEnd || undefined;
    if (cycle === 'TRIAL') store.license.trialEndsAt = periodEnd;
  }
  if (req.body?.licenseEndsAt !== undefined) {
    if (!req.body.licenseEndsAt) store.license.endsAt = undefined;
    else {
      const endsAt = new Date(req.body.licenseEndsAt);
      if (!Number.isFinite(endsAt.getTime())) throw new ApiError('VALIDATION_ERROR', 'Choose a valid licence expiry date');
      store.license.endsAt = endsAt;
    }
  }
  if (req.body?.renewalMessage !== undefined) {
    const message = String(req.body.renewalMessage || '').trim();
    if (message.length > 300) throw new ApiError('VALIDATION_ERROR', 'Renewal message must be 300 characters or fewer');
    store.license.renewalMessage = message;
  }
  if (req.body?.disabledFeatures !== undefined) {
    if (!Array.isArray(req.body.disabledFeatures)) throw new ApiError('VALIDATION_ERROR', 'Disabled features must be a list');
    const known = new Set(Object.values(STORE_PLANS).flatMap((plan) => plan.features));
    store.license.disabledFeatures = [...new Set(req.body.disabledFeatures.map((item) => String(item).trim()).filter((item) => known.has(item)))];
  }
  if (req.body?.featureOverrides !== undefined) {
    if (!Array.isArray(req.body.featureOverrides)) throw new ApiError('VALIDATION_ERROR', 'Feature overrides must be a list');
    const known = new Set(Object.values(STORE_PLANS).flatMap((plan) => plan.features));
    store.license.featureOverrides = [...new Set(req.body.featureOverrides.map((item) => String(item).trim()).filter((item) => known.has(item)))];
  }
  if (req.body?.limitOverrides !== undefined) {
    if (!req.body.limitOverrides || typeof req.body.limitOverrides !== 'object' || Array.isArray(req.body.limitOverrides)) throw new ApiError('VALIDATION_ERROR', 'Limit overrides must be an object');
    const limits = {};
    for (const key of LIMIT_KEYS) {
      const raw = req.body.limitOverrides[key];
      if (raw === '' || raw === null || raw === undefined) continue;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 10000000) throw new ApiError('VALIDATION_ERROR', `${key} limit must be a whole number from 0 to 10,000,000`);
      limits[key] = value;
    }
    store.license.limitOverrides = limits;
    store.markModified?.('license.limitOverrides');
  }
  await store.save();

  if (req.body?.grantCycle !== undefined && store.owner) {
    require('../services/notificationService').notifyLater({
      userId: store.owner, storeId: store._id, event: 'SUBSCRIPTION_ACTIVATED',
      title: 'Store access updated', message: `${store.plan} ${String(store.license.billingCycle || '').toLowerCase()} access is now active.`,
      metadata: { subscriptionId: `master:${store._id}:${Date.now()}` },
    });
  }

  if (converted) {
    const preset = await resolveIndustry(store.industry);
    const existing = await Category.find({ storeId: store._id }).select('name').lean();
    const names = new Set(existing.map((item) => String(item.name || '').toLowerCase()));
    const missing = preset.defaultCategories.filter((name) => !names.has(name.toLowerCase()));
    if (missing.length) {
      await Category.insertMany(missing.map((name, index) => {
        const definition = (preset.categoryDefinitions || []).find((item) => item.name.toLowerCase() === name.toLowerCase());
        return {
        name,
        slug: `${store.slug}-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${store.industryRevision}`,
        description: `Starter ${preset.name.toLowerCase()} category`,
        displayOrder: existing.length + index,
        storeId: store._id,
        definitionKey: definition?.key || '', parentDefinitionKey: definition?.parentKey || '',
        attributeOverrides: definition?.attributes || [], variantAttributes: definition?.variantAttributes || [], configuredFilters: definition?.filters || [],
      }; }), { ordered: false }).catch(() => null);
    }
  }
  const reviewProducts = converted ? Number(store.industryMigration?.totalProducts || 0) : 0;
  const after = platformStoreView(store);
  await logAudit({ req, action: converted ? 'STORE_INDUSTRY_CONVERT' : 'STORE_PLAN_UPDATE', entityType: 'Store', entityId: store._id, storeId: store._id, before, after });
  res.json({ store: after, converted, reviewProducts });
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
  const config = await updateConfiguration(req.user, {
    revision: req.body.revision,
    structure: req.body.template.structure,
    confirmIndustryChange: req.body.confirmIndustryChange === true,
    note: 'Template imported into unlocked configuration',
  });
  logAudit({ req, action: 'MASTER_TEMPLATE_IMPORT', entityType: 'MasterConfiguration', entityId: config._id });
  res.json(config);
});
exports.createPreset = master(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 80) throw new ApiError('VALIDATION_ERROR', 'Enter a preset name under 80 characters');
  const structure = validateStructure(req.body?.structure);
  if (await Preset.countDocuments() >= 100) throw new ApiError('VALIDATION_ERROR', 'Keep at most 100 custom presets');
  const key = String(req.body?.key || name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(key) || INDUSTRY_IDS.includes(key) || await Preset.exists({ key })) throw new ApiError('VALIDATION_ERROR', 'Choose a unique custom industry key');
  structure.industry = key; structure.id = key; structure.name = name;
  const preset = await Preset.create({ name, key, structure, createdBy: req.user._id });
  logAudit({ req, action: 'MASTER_PRESET_CREATE', entityType: 'IndustryPreset', entityId: preset._id });
  res.status(201).json(preset);
});
exports.updatePreset = master(async (req, res) => {
  const preset = await Preset.findById(requireId(req.params.id));
  if (!preset) throw new ApiError('NOT_FOUND', 'Preset not found');
  if (req.body?.name !== undefined) preset.name = String(req.body.name || '').trim().slice(0, 80);
  if (req.body?.isActive !== undefined) preset.isActive = req.body.isActive === true;
  if (req.body?.structure !== undefined) {
    const structure = validateStructure({ ...req.body.structure, industry: preset.key });
    structure.name = preset.name; structure.id = preset.key; preset.structure = structure; preset.markModified('structure');
  }
  await preset.save();
  res.json(preset);
});
exports.duplicatePreset = master(async (req, res) => {
  const source = await Preset.findById(requireId(req.params.id)).lean();
  if (!source) throw new ApiError('NOT_FOUND', 'Preset not found');
  req.body = { name: req.body?.name || `${source.name} copy`, key: req.body?.key, structure: { ...source.structure, industry: req.body?.key || `${source.key}-copy` } };
  return exports.createPreset(req, res);
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
