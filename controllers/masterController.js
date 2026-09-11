const mongoose = require('mongoose');
const { assertClientHandoverReady } = require('../services/clientHandoverService');
const User = require('../models/User');
const Store = require('../models/Store');
const Preset = require('../models/IndustryPreset');
const PlatformRelease = require('../models/PlatformRelease');
const { INDUSTRY_PRESETS, INDUSTRY_IDS } = require('../config/industryPresets');
const { assertMasterOwner, isOwnerPhone } = require('../config/masterOwner');
const { normalizePhone } = require('../utils/phoneUtils');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { readConfiguration, updateConfiguration, validateStructure, publicStructure } = require('../services/masterConfigurationService');
const {
  analyzeConfigurationImpact, assertImpactToken, getConfigurationVersion, listAffectedProducts, listChanges,
  listConfigurationVersions, presetUsage, recordConfigurationVersion,
} = require('../services/masterGovernanceService');
const { previewProject, generateProject, normalizeProject } = require('../services/projectGeneratorService');
const clientPlatform = require('../services/clientPlatformService');
const { signingReady } = require('../services/licenseSignatureService');
const { logAudit } = require('../services/auditService');
const portfolio = require('../services/storePortfolioService');
const storeDataExport = require('../services/storeDataExportService');
const pricingService = require('../services/subscriptionPricingService');
const requireId = (id) => { if (!mongoose.isValidObjectId(id)) throw new ApiError('VALIDATION_ERROR', 'Invalid record ID'); return id; };
const master = (handler) => asyncHandler(async (req, res) => { assertMasterOwner(req.user); return handler(req, res); });

function platformStoreView(store) {
  return portfolio.storeView(store);
}

exports.publicCatalog = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
  res.setHeader('Vary', 'Host, X-Store-Slug');
  res.json(publicStructure(await readConfiguration(req.store?._id)));
});
exports.workspace = master(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const configurationOnly = req.query?.view === 'configuration';
  if (configurationOnly) {
    const [configuration, presets, admins, planPricing] = await Promise.all([
      readConfiguration(),
      Preset.find().select('name key isActive archivedAt isBuiltinCopy structure revision createdAt updatedAt').sort('-updatedAt').limit(100).lean(),
      User.find({ role: 'admin' }).select('name phone isBlocked systemRole').limit(100).lean(),
      pricingService.readPlanPricing(),
    ]);
    return res.json({ configuration: { ...configuration, history: [] }, presets, builtins: INDUSTRY_PRESETS, admins, plans: planPricing.plans, planPricing });
  }
  const [configuration, presets, admins, stores, installations, releases, planPricing] = await Promise.all([
    readConfiguration(), Preset.find().select('name key isActive archivedAt isBuiltinCopy structure revision createdAt updatedAt').sort('-updatedAt').limit(100).lean(),
    User.find({ role: 'admin' }).select('name phone isBlocked systemRole').limit(100).lean(),
    Store.find().populate('owner', 'name phone email').sort('-createdAt').limit(250).lean(),
    clientPlatform.listInstallations(),
    PlatformRelease.find().sort('-publishedAt').limit(100).lean(),
    pricingService.readPlanPricing(),
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
    plans: planPricing.plans,
    planPricing,
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
    industryOptions: [...INDUSTRY_PRESETS, ...(await Preset.find({ isActive: { $ne: false }, archivedAt: null }).select('name key structure.industry').limit(100).lean()).map((preset) => ({ industry: preset.key || preset.structure?.industry, name: preset.name }))],
    controlPlane: { signingReady: signingReady(), deploymentHooksReady: Boolean(String(process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY || '').trim()), appVersion: String(process.env.APP_VERSION || '1.0.0') },
  });
});

exports.installationOperations = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const result = await clientPlatform.installationOperations(req.params.id, req.query || {});
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

exports.updateInstallationProfile = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const installation = await clientPlatform.updateInstallationProfile(req.params.id, req.body || {}, req.user);
  const view = clientPlatform.installationView(installation, await clientPlatform.latestReleaseFor(installation));
  await logAudit({ req, action: 'CLIENT_PROFILE_UPDATE', entityType: 'ClientInstallation', entityId: req.params.id, after: view, summary: 'Client profile and internal ownership details updated.' });
  res.json({ installation: view });
});

exports.updateInstallationSubscription = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const installation = await clientPlatform.updateInstallationSubscription(req.params.id, req.body || {}, req.user);
  const view = clientPlatform.installationView(installation, await clientPlatform.latestReleaseFor(installation));
  await logAudit({ req, action: 'CLIENT_SUBSCRIPTION_UPDATE', entityType: 'ClientInstallation', entityId: req.params.id, after: view, summary: req.body?.reason });
  res.json({ installation: view });
});

exports.grantInstallationAccess = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const result = await clientPlatform.grantInstallationAccess(req.params.id, req.body || {}, req.user);
  const view = clientPlatform.installationView(result.installation, await clientPlatform.latestReleaseFor(result.installation));
  if (!result.duplicate) await logAudit({ req, action: 'CLIENT_ACCESS_GRANTED', entityType: 'ClientInstallation', entityId: req.params.id, after: view, summary: req.body?.reason });
  res.json({ installation: view, duplicate: result.duplicate });
});

exports.updateInstallationLifecycle = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const installation = await clientPlatform.updateInstallationLifecycle(req.params.id, req.body || {}, req.user);
  const view = clientPlatform.installationView(installation, await clientPlatform.latestReleaseFor(installation));
  await logAudit({ req, action: `CLIENT_${String(req.body?.action || 'LIFECYCLE').toUpperCase()}`, entityType: 'ClientInstallation', entityId: req.params.id, after: view, summary: req.body?.reason });
  res.json({ installation: view });
});

exports.updateInstallationEntitlements = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const installation = await clientPlatform.updateInstallationEntitlements(req.params.id, req.body || {}, req.user);
  const view = clientPlatform.installationView(installation, await clientPlatform.latestReleaseFor(installation));
  await logAudit({ req, action: 'CLIENT_ENTITLEMENTS_UPDATE', entityType: 'ClientInstallation', entityId: req.params.id, after: view, summary: req.body?.reason });
  res.json({ installation: view });
});

exports.updateInstallationDeployment = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const installation = await clientPlatform.updateInstallationDeployment(req.params.id, req.body || {}, req.user);
  const view = clientPlatform.installationView(installation, await clientPlatform.latestReleaseFor(installation));
  await logAudit({ req, action: 'CLIENT_DEPLOYMENT_SETTINGS_UPDATE', entityType: 'ClientInstallation', entityId: req.params.id, after: view, summary: req.body?.reason });
  res.json({ installation: view });
});

exports.rotateInstallationKey = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const result = await clientPlatform.rotateInstallationKey(req.params.id, req.body || {}, req.user);
  if (!result.duplicate) await logAudit({ req, action: 'CLIENT_INSTALLATION_KEY_ROTATE', entityType: 'ClientInstallation', entityId: req.params.id, after: { installationId: result.installation.installationId, state: 'PENDING' }, summary: req.body?.reason });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ notice: result.credentials ? 'Apply the downloaded pending key to the client backend. The current key remains valid until the new key checks in.' : 'This key rotation was already completed.', credentials: result.credentials, installation: result.installation, duplicate: result.duplicate });
});

exports.cancelInstallationKeyRotation = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const installation = await clientPlatform.cancelInstallationKeyRotation(req.params.id, req.body || {}, req.user);
  const view = clientPlatform.installationView(installation, await clientPlatform.latestReleaseFor(installation));
  await logAudit({ req, action: 'CLIENT_INSTALLATION_KEY_ROTATION_CANCEL', entityType: 'ClientInstallation', entityId: req.params.id, after: { state: 'CANCELLED' }, summary: req.body?.reason });
  res.json({ installation: view });
});

exports.deployInstallation = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid installation ID');
  const installation = await clientPlatform.triggerDeployment(req.params.id, req.body || {}, req.user);
  await logAudit({ req, action: 'CLIENT_INSTALLATION_DEPLOY', entityType: 'ClientInstallation', entityId: req.params.id, after: { targetVersion: installation.targetVersion, deployment: installation.deployment } });
  res.json({ installation });
});

exports.createRelease = master(async (req, res) => {
  const release = await clientPlatform.createRelease(req.body || {}, req.user);
  await logAudit({ req, action: 'PLATFORM_RELEASE_CREATE', entityType: 'PlatformRelease', entityId: release._id, after: { version: release.version, channel: release.channel, mandatory: release.mandatory } });
  res.status(201).json({ release });
});

exports.updateRelease = master(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError('VALIDATION_ERROR', 'Invalid release ID');
  const release = await clientPlatform.updateRelease(req.params.id, req.body || {}, req.user);
  await logAudit({ req, action: `PLATFORM_RELEASE_${String(req.body?.action || 'UPDATE').toUpperCase()}`, entityType: 'PlatformRelease', entityId: release._id, after: { version: release.version, rolloutStatus: release.rolloutStatus, rolloutPercent: release.rolloutPercent, status: release.status }, summary: req.body?.reason });
  res.json({ release });
});

async function resolveIndustry(industry) {
  const builtin = INDUSTRY_PRESETS.find((item) => item.industry === industry);
  if (builtin) return builtin;
  const custom = await Preset.findOne({ key: industry, isActive: { $ne: false }, archivedAt: null }).lean();
  if (!custom) throw new ApiError('VALIDATION_ERROR', 'Choose an active business type');
  return { ...custom.structure, id: custom.key, industry: custom.key, name: custom.name };
}

async function portfolioIndustries() {
  const custom = await Preset.find({ isActive: { $ne: false }, archivedAt: null }).select('name key structure.industry').sort('name').limit(100).lean();
  return [...INDUSTRY_PRESETS, ...custom.map((item) => ({ industry: item.key || item.structure?.industry, id: item.key || item.structure?.industry, name: item.name, custom: true }))];
}
async function findPortfolioStore(id, { owner = false } = {}) {
  let query = Store.findById(requireId(id));
  if (owner) query = query.populate('owner', 'name phone email isBlocked lastLoginAt');
  const store = await query;
  if (!store) throw new ApiError('NOT_FOUND', 'Store not found');
  return store;
}
async function refreshedStore(id) {
  return portfolio.storeView(await findPortfolioStore(id, { owner: true }));
}

exports.storePortfolio = master(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const [industries, planPricing] = await Promise.all([portfolioIndustries(), pricingService.readPlanPricing()]);
  const result = await portfolio.listStores(req.query || {}, industries, planPricing.plans);
  res.json({ ...result, pricing: { revision: planPricing.revision, currency: planPricing.currency, taxMode: planPricing.taxMode, gstPercent: planPricing.gstPercent } });
});

exports.getPlanPricing = master(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await pricingService.readPlanPricing());
});

exports.updatePlanPricing = master(async (req, res) => {
  const before = await pricingService.readPlanPricing();
  const pricing = await pricingService.updatePlanPricing(req.user, req.body || {});
  await logAudit({
    req,
    action: 'SUBSCRIPTION_PRICING_UPDATE',
    entityType: 'SubscriptionPricing',
    entityId: 'platform',
    before: { revision: before.revision, prices: Object.fromEntries(before.plans.map((item) => [item.id, item.prices])), taxMode: before.taxMode, gstPercent: before.gstPercent },
    after: { revision: pricing.revision, prices: Object.fromEntries(pricing.plans.map((item) => [item.id, item.prices])), taxMode: pricing.taxMode, gstPercent: pricing.gstPercent },
    summary: String(req.body?.reason || '').trim(),
  });
  res.json(pricing);
});
exports.storePortfolioOperations = master(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await portfolio.storeOperations(req.params.id));
});
exports.exportStoreData = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id);
  const operation = storeDataExport.prepare(store, req.body || {});
  await logAudit({ req, action: 'STORE_DATA_EXPORT', entityType: 'Store', entityId: store._id, storeId: store._id, summary: operation.reason });
  const filename = `${store.slug || 'store'}-data-${new Date().toISOString().slice(0, 10)}.ndjson`;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  await storeDataExport.streamStoreData(res, store);
  res.end();
});
exports.updateStoreProfile = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); const before = portfolio.storeView(store);
  await portfolio.updateProfile({ store, input: req.body || {}, actor: req.user }); const after = await refreshedStore(store._id);
  await logAudit({ req, action: 'STORE_PROFILE_UPDATE', entityType: 'Store', entityId: store._id, storeId: store._id, before, after, summary: String(req.body?.reason || 'Store profile updated') });
  res.json({ store: after });
});
exports.updateStoreSubscription = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); const before = portfolio.storeView(store);
  await portfolio.updateSubscription({ store, input: req.body || {}, actor: req.user }); const after = await refreshedStore(store._id);
  await logAudit({ req, action: 'STORE_SUBSCRIPTION_UPDATE', entityType: 'Store', entityId: store._id, storeId: store._id, before, after, summary: req.body?.reason });
  res.json({ store: after });
});
exports.grantStoreAccess = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); const before = portfolio.storeView(store);
  const result = await portfolio.grantAccess({ store, input: req.body || {}, actor: req.user }); const after = await refreshedStore(store._id);
  if (!result.duplicate && store.owner) require('../services/notificationService').notifyLater({ userId: store.owner, storeId: store._id, event: 'SUBSCRIPTION_ACTIVATED', title: 'Store access updated', message: `${after.platform.name} ${String(after.platform.billingCycle || '').toLowerCase()} access is now active.`, metadata: { subscriptionId: req.body?.idempotencyKey } });
  await logAudit({ req, action: result.duplicate ? 'STORE_ACCESS_GRANT_REPLAY' : 'STORE_ACCESS_GRANT', entityType: 'Store', entityId: store._id, storeId: store._id, before, after, summary: req.body?.reason });
  res.json({ store: after, duplicate: result.duplicate });
});
exports.updateStoreLifecycle = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); const before = portfolio.storeView(store);
  await portfolio.updateLifecycle({ store, input: req.body || {}, actor: req.user }); const after = await refreshedStore(store._id);
  await logAudit({ req, action: `STORE_${String(req.body?.action || 'LIFECYCLE').toUpperCase()}`, entityType: 'Store', entityId: store._id, storeId: store._id, before, after, summary: req.body?.reason });
  res.json({ store: after });
});
exports.createStoreMember = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); const member = await portfolio.createMember({ store, input: req.body || {}, actor: req.user });
  await logAudit({ req, action: 'STORE_MEMBER_ADD', entityType: 'StoreMember', entityId: member._id, storeId: store._id, after: { user: member.user?._id, role: member.role, status: member.status }, summary: req.body?.reason });
  res.status(201).json({ member, store: await refreshedStore(store._id) });
});
exports.updateStoreMember = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); const member = await portfolio.updateMember({ store, memberId: req.params.memberId, input: req.body || {}, actor: req.user });
  await logAudit({ req, action: member.status === 'REVOKED' ? 'STORE_MEMBER_REVOKE' : 'STORE_MEMBER_UPDATE', entityType: 'StoreMember', entityId: member._id, storeId: store._id, after: { user: member.user?._id, role: member.role, status: member.status }, summary: req.body?.reason });
  res.json({ member, store: await refreshedStore(store._id) });
});
exports.transferStoreOwner = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); const before = portfolio.storeView(store);
  await portfolio.transferOwner({ store, input: req.body || {}, actor: req.user }); const after = await refreshedStore(store._id);
  await logAudit({ req, action: 'STORE_OWNER_TRANSFER', entityType: 'Store', entityId: store._id, storeId: store._id, before, after, summary: req.body?.reason });
  res.json({ store: after });
});
exports.previewStoreIndustry = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); const industry = String(req.query.industry || '').trim().toLowerCase(); const target = await resolveIndustry(industry);
  const preview = await portfolio.previewIndustry(store, target); const currentName = store.catalogStructure?.name || store.industry;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ from: { id: store.industry, name: currentName }, to: { id: target.industry, name: target.name }, revision: Number(store.portfolioRevision || 0), ...preview, preservesData: true, reversible: true });
});
exports.storeIndustryAffectedProducts = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); const target = await resolveIndustry(String(req.query.industry || '').trim().toLowerCase());
  res.setHeader('Cache-Control', 'no-store'); res.json(await portfolio.affectedProducts(store, target, req.query.impactToken, req.query || {}));
});
exports.convertStoreIndustry = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); const before = portfolio.storeView(store); const target = await resolveIndustry(String(req.body?.industry || '').trim().toLowerCase());
  const result = await portfolio.convertIndustry({ store, target, impactToken: req.body?.impactToken, baseRevision: req.body?.baseRevision, reviewNote: req.body?.reviewNote, actor: req.user }); const after = await refreshedStore(store._id);
  await logAudit({ req, action: 'STORE_INDUSTRY_CONVERT', entityType: 'Store', entityId: store._id, storeId: store._id, before, after, summary: req.body?.reviewNote });
  res.json({ store: after, converted: true, impact: result.impact, reviewProducts: result.impact.affectedProducts });
});
exports.storeMigrationProducts = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); res.setHeader('Cache-Control', 'no-store'); res.json(await portfolio.currentMigrationProducts(store, req.query || {}));
});
exports.updateStoreMigrationReview = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); await portfolio.updateMigrationReview({ store, input: req.body || {} });
  await logAudit({ req, action: 'STORE_MIGRATION_REVIEW_UPDATE', entityType: 'Store', entityId: store._id, storeId: store._id, summary: req.body?.note }); res.json({ store: await refreshedStore(store._id) });
});
exports.completeStoreMigration = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); const result = await portfolio.completeMigration({ store, input: req.body || {}, target: store.catalogStructure || {} });
  await logAudit({ req, action: 'STORE_MIGRATION_COMPLETE', entityType: 'Store', entityId: store._id, storeId: store._id, after: result.impact, summary: req.body?.note }); res.json({ store: await refreshedStore(store._id), impact: result.impact });
});
exports.rollbackStoreIndustry = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id); const before = portfolio.storeView(store); await portfolio.rollbackIndustry({ store, input: req.body || {}, actor: req.user }); const after = await refreshedStore(store._id);
  await logAudit({ req, action: 'STORE_INDUSTRY_ROLLBACK', entityType: 'Store', entityId: store._id, storeId: store._id, before, after, summary: req.body?.reason }); res.json({ store: after });
});

// Kept for older master clients, but now routed through the same validated,
// revision-protected operations as the dedicated portfolio endpoints.
exports.updateStorePlatform = master(async (req, res) => {
  const store = await findPortfolioStore(req.params.id);
  const before = portfolio.storeView(store);
  if (req.body?.industry !== undefined) {
    const target = await resolveIndustry(String(req.body.industry || '').trim().toLowerCase());
    const result = await portfolio.convertIndustry({ store, target, impactToken: req.body.impactToken, baseRevision: req.body.baseRevision, reviewNote: req.body.reviewNote || req.body.reason, actor: req.user });
    const after = await refreshedStore(store._id);
    await logAudit({ req, action: 'STORE_INDUSTRY_CONVERT', entityType: 'Store', entityId: store._id, storeId: store._id, before, after, summary: req.body?.reviewNote || req.body?.reason });
    return res.json({ store: after, converted: true, reviewProducts: result.impact.affectedProducts, impact: result.impact });
  }
  if (req.body?.grantCycle !== undefined) {
    const result = await portfolio.grantAccess({ store, input: { ...req.body, billingCycle: req.body.grantCycle }, actor: req.user });
    const after = await refreshedStore(store._id);
    await logAudit({ req, action: result.duplicate ? 'STORE_ACCESS_GRANT_REPLAY' : 'STORE_ACCESS_GRANT', entityType: 'Store', entityId: store._id, storeId: store._id, before, after, summary: req.body?.reason });
    return res.json({ store: after, duplicate: result.duplicate });
  }
  await portfolio.updateSubscription({ store, input: req.body || {}, actor: req.user });
  const after = await refreshedStore(store._id);
  await logAudit({ req, action: 'STORE_SUBSCRIPTION_UPDATE', entityType: 'Store', entityId: store._id, storeId: store._id, before, after, summary: req.body?.reason });
  return res.json({ store: after });
});
exports.update = master(async (req, res) => {
  let impact;
  const before = await readConfiguration();
  if (req.body?.structure !== undefined) {
    impact = await analyzeConfigurationImpact(before, req.body.structure);
    if (impact.requiresReview) assertImpactToken(before, impact.proposed, req.body?.impactToken);
  }
  await recordConfigurationVersion(before, req.user, { kind: 'BASELINE', note: `Revision ${before.revision} preserved before update` });
  const config = await updateConfiguration(req.user, req.body || {});
  const requestedKind = String(req.body?.versionKind || 'PUBLISH').toUpperCase();
  const kind = req.body?.structure !== undefined
    ? (['PUBLISH', 'IMPORT', 'ROLLBACK'].includes(requestedKind) ? requestedKind : 'PUBLISH')
    : config.locked ? 'LOCK' : 'UNLOCK';
  const changes = before ? listChanges(before.structure, config.structure) : [];
  await recordConfigurationVersion(config, req.user, { kind, note: req.body?.note, changes, impact: impact ? { risk: impact.risk, counts: impact.counts, warnings: impact.warnings } : undefined });
  await logAudit({ req, action: 'MASTER_CONFIG_UPDATE', entityType: 'MasterConfiguration', entityId: config._id, before: before ? { revision: before.revision, locked: before.locked, industry: before.structure.industry } : undefined, after: { revision: config.revision, locked: config.locked, industry: config.structure.industry }, summary: req.body?.note });
  res.json(config);
});
exports.configurationImpact = master(async (req, res) => {
  const configuration = await readConfiguration();
  res.setHeader('Cache-Control', 'no-store');
  res.json(await analyzeConfigurationImpact(configuration, req.body?.structure));
});
exports.configurationImpactProducts = master(async (req, res) => {
  const configuration = await readConfiguration();
  assertImpactToken(configuration, req.body?.structure, req.body?.impactToken);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await listAffectedProducts(configuration, req.body?.structure, req.body || {}));
});
exports.configurationHistory = master(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const result = await listConfigurationVersions(req.query || {});
  if (!result.total) {
    const configuration = await readConfiguration();
    result.items = [...(configuration.history || [])].reverse().slice(0, 30).map((item) => ({ id: `legacy-${item.revision}`, revision: item.revision, kind: 'BASELINE', note: item.note, locked: item.locked, createdAt: item.at, publishedBy: item.actor ? { name: 'Master owner' } : null, changes: [] }));
    result.total = result.items.length; result.pages = 1;
  }
  res.json(result);
});
exports.configurationVersion = master(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await getConfigurationVersion(req.params.id));
});
exports.restoreConfigurationVersion = master(async (req, res) => {
  const before = await readConfiguration();
  if (before.locked) throw new ApiError('FORBIDDEN', 'Unlock the configuration before restoring a version');
  const version = await getConfigurationVersion(req.params.id);
  const impact = await analyzeConfigurationImpact(before, version.structure);
  if (impact.requiresReview) assertImpactToken(before, impact.proposed, req.body?.impactToken);
  await recordConfigurationVersion(before, req.user, { kind: 'BASELINE', note: `Revision ${before.revision} preserved before rollback` });
  const config = await updateConfiguration(req.user, { revision: req.body?.revision, structure: version.structure, confirmIndustryChange: true, note: req.body?.note || `Restored revision ${version.revision}` });
  const changes = listChanges(before.structure, config.structure);
  await recordConfigurationVersion(config, req.user, { kind: 'ROLLBACK', note: req.body?.note || `Restored revision ${version.revision}`, changes, impact: { risk: impact.risk, counts: impact.counts, warnings: impact.warnings } });
  await logAudit({ req, action: 'MASTER_CONFIG_ROLLBACK', entityType: 'MasterConfiguration', entityId: config._id, before: { revision: before.revision }, after: { revision: config.revision, restoredRevision: version.revision } });
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
  const before = await readConfiguration();
  const impact = await analyzeConfigurationImpact(before, req.body.template.structure);
  if (impact.requiresReview) assertImpactToken(before, impact.proposed, req.body?.impactToken);
  await recordConfigurationVersion(before, req.user, { kind: 'BASELINE', note: `Revision ${before.revision} preserved before import` });
  const config = await updateConfiguration(req.user, {
    revision: req.body.revision,
    structure: req.body.template.structure,
    confirmIndustryChange: req.body.confirmIndustryChange === true,
    note: 'Template imported into unlocked configuration',
  });
  await recordConfigurationVersion(config, req.user, { kind: 'IMPORT', note: 'Template imported into unlocked configuration', changes: listChanges(before.structure, config.structure), impact: { risk: impact.risk, counts: impact.counts, warnings: impact.warnings } });
  await logAudit({ req, action: 'MASTER_TEMPLATE_IMPORT', entityType: 'MasterConfiguration', entityId: config._id, before: { revision: before.revision }, after: { revision: config.revision } });
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
  await logAudit({ req, action: 'MASTER_PRESET_CREATE', entityType: 'IndustryPreset', entityId: preset._id, after: { key, revision: preset.revision } });
  res.status(201).json(preset);
});
exports.updatePreset = master(async (req, res) => {
  const preset = await Preset.findById(requireId(req.params.id));
  if (!preset) throw new ApiError('NOT_FOUND', 'Preset not found');
  if (req.body?.revision !== undefined && Number(req.body.revision) !== Number(preset.revision)) throw new ApiError('DUPLICATE_REQUEST', 'This preset changed in another session. Reload before saving.');
  const before = { name: preset.name, key: preset.key, isActive: preset.isActive, archivedAt: preset.archivedAt, revision: preset.revision };
  if (req.body?.name !== undefined) preset.name = String(req.body.name || '').trim().slice(0, 80);
  if (req.body?.isActive !== undefined) preset.isActive = req.body.isActive === true;
  if (req.body?.archived === false) { preset.archivedAt = null; preset.archivedBy = undefined; }
  if (req.body?.structure !== undefined) {
    const structure = validateStructure({ ...req.body.structure, industry: preset.key });
    structure.name = preset.name; structure.id = preset.key; preset.structure = structure; preset.markModified('structure');
  }
  preset.updatedBy = req.user._id;
  preset.revision = Number(preset.revision || 1) + 1;
  await preset.save();
  await logAudit({ req, action: preset.archivedAt ? 'MASTER_PRESET_ARCHIVE' : req.body?.isActive !== undefined ? 'MASTER_PRESET_STATUS_UPDATE' : 'MASTER_PRESET_UPDATE', entityType: 'IndustryPreset', entityId: preset._id, before, after: { name: preset.name, isActive: preset.isActive, archivedAt: preset.archivedAt, revision: preset.revision } });
  res.json(preset);
});
exports.duplicatePreset = master(async (req, res) => {
  const source = await Preset.findById(requireId(req.params.id)).lean();
  if (!source) throw new ApiError('NOT_FOUND', 'Preset not found');
  if (await Preset.countDocuments() >= 100) throw new ApiError('VALIDATION_ERROR', 'Keep at most 100 custom presets');
  const name = String(req.body?.name || `${source.name} copy`).trim().slice(0, 80);
  const requestedKey = String(req.body?.key || name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(requestedKey) || INDUSTRY_IDS.includes(requestedKey) || await Preset.exists({ key: requestedKey })) throw new ApiError('VALIDATION_ERROR', 'Choose a unique custom industry key');
  const structure = validateStructure({ ...source.structure, id: requestedKey, name, industry: requestedKey });
  const preset = await Preset.create({ name, key: requestedKey, structure, isBuiltinCopy: source.isBuiltinCopy === true, createdBy: req.user._id });
  await logAudit({ req, action: 'MASTER_PRESET_DUPLICATE', entityType: 'IndustryPreset', entityId: preset._id, before: { sourcePresetId: String(source._id), sourceKey: source.key }, after: { key: preset.key, revision: preset.revision } });
  res.status(201).json(preset);
});
exports.deletePreset = master(async (req, res) => {
  const preset = await Preset.findById(requireId(req.params.id));
  if (!preset) throw new ApiError('NOT_FOUND', 'Preset not found');
  if (preset.archivedAt) return res.json({ success: true, archived: true, preset, usage: await presetUsage(preset.key) });
  const usage = await presetUsage(preset.key);
  preset.isActive = false; preset.archivedAt = new Date(); preset.archivedBy = req.user._id; preset.updatedBy = req.user._id; preset.revision = Number(preset.revision || 1) + 1;
  await preset.save();
  await logAudit({ req, action: 'MASTER_PRESET_ARCHIVE', entityType: 'IndustryPreset', entityId: preset._id, before: { key: preset.key, active: true }, after: { archivedAt: preset.archivedAt, usage } });
  res.json({ success: true, archived: true, preset, usage });
});
exports.presetUsage = master(async (req, res) => {
  const preset = await Preset.findById(requireId(req.params.id)).select('key name').lean();
  if (!preset) throw new ApiError('NOT_FOUND', 'Preset not found');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ preset: { id: String(preset._id), key: preset.key, name: preset.name }, usage: await presetUsage(preset.key) });
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
  await logAudit({ req, action: 'CLIENT_ADMIN_PROVISION', entityType: 'User', entityId: user._id, after: { phone: user.phone, role: 'admin', systemRole: 'USER' } });
  res.status(201).json({ _id: user._id, name: user.name, phone: user.phone, role: 'admin', systemRole: 'USER' });
});
