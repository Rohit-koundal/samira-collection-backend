const mongoose = require('mongoose');
const WebsiteTheme = require('../models/WebsiteTheme');
const WebsiteThemeVersion = require('../models/WebsiteThemeVersion');
const Settings = require('../models/Settings');
const { applyStorePresentation } = require('../services/storeSettingsValidation');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, notFound } = require('../utils/apiError');
const { logAudit } = require('../services/auditService');
const { hasStoreFeature, planSummary } = require('../config/storePlans');
const {
  DEFAULT_WEBSITE_CONFIG,
  buildPresetConfig,
  getPresetList,
  normalizeWebsiteConfig,
} = require('../config/websiteCustomization');

const PUBLIC_CACHE_MS = 60 * 1000;
const activeCache = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanName(value, fallback = 'Untitled Theme') {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) return fallback;
  return name.slice(0, 80);
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'theme';
}

async function uniqueSlug(value, excludeId) {
  const base = slugify(value);
  let slug = base;
  let suffix = 2;
  while (await WebsiteTheme.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function requireThemeId(value) {
  if (!mongoose.isValidObjectId(value)) throw new ApiError('VALIDATION_ERROR', 'Valid theme id is required');
  return value;
}

function requireCurrentRevision(req, theme) {
  if (req.body?.expectedUpdatedAt === undefined) return; // Compatibility with older admin clients.
  const expected = new Date(req.body.expectedUpdatedAt).getTime();
  if (!Number.isFinite(expected) || expected !== new Date(theme.updatedAt).getTime()) {
    throw new ApiError('DUPLICATE_REQUEST', 'This theme was changed in another session. Export your draft, then reload the theme before saving or publishing.');
  }
}

async function saveTheme(theme) {
  try { return await theme.save(); }
  catch (error) {
    if (error.name === 'VersionError') throw new ApiError('DUPLICATE_REQUEST', 'This theme changed while saving. Export your draft and reload before retrying.');
    throw error;
  }
}

async function ensureDefaultTheme(userId) {
  const existing = await WebsiteTheme.findOne().sort({ isActive: -1, createdAt: 1 });
  if (existing) return existing;
  const settings = await Settings.findOne().lean();
  const initialConfig = buildInitialConfig(settings);
  return WebsiteTheme.create({
    name: 'Default Theme',
    slug: 'default-theme',
    preset: 'default',
    draftConfig: initialConfig,
    publishedConfig: initialConfig,
    isActive: true,
    createdBy: userId,
    updatedBy: userId,
    publishedBy: userId,
    publishedAt: new Date(),
  });
}

function buildInitialConfig(settings) {
  if (!settings) return clone(DEFAULT_WEBSITE_CONFIG);
  return normalizeWebsiteConfig({
    branding: { websiteName: settings.storeName || DEFAULT_WEBSITE_CONFIG.branding.websiteName },
    footer: {
      description: settings.footerText || DEFAULT_WEBSITE_CONFIG.footer.description,
      contactEmail: settings.contactEmail || '',
      contactPhone: settings.contactPhone || '',
      contactAddress: settings.address || '',
      socialLinks: settings.socialLinks || {},
    },
  });
}

function themeSummary(theme) {
  return {
    _id: theme._id,
    name: theme.name,
    slug: theme.slug,
    preset: theme.preset,
    isActive: theme.isActive,
    hasPublishedVersion: Boolean(theme.publishedConfig),
    publishedAt: theme.publishedAt,
    createdAt: theme.createdAt,
    updatedAt: theme.updatedAt,
  };
}

function publicPayload(theme) {
  if (!theme?.publishedConfig) {
    return { config: clone(DEFAULT_WEBSITE_CONFIG), theme: null };
  }
  return {
    config: normalizeWebsiteConfig(theme.publishedConfig),
    theme: {
      id: theme._id,
      name: theme.name,
      slug: theme.slug,
      preset: theme.preset,
      publishedAt: theme.publishedAt,
    },
  };
}

const CLIENT_DESIGN_GROUPS = ['colors', 'header', 'homepage', 'typography', 'buttons', 'productCards', 'footer', 'layout', 'mobile', 'tablet', 'theme'];

function requireClientDesign(store) {
  if (hasStoreFeature(store, 'advancedCustomization')) return;
  const plan = planSummary(store);
  throw new ApiError('FORBIDDEN', `Store design is unavailable on the ${plan.name} plan while its licence is ${plan.status.toLowerCase()}.`);
}

function designOnly(config) {
  const normalized = normalizeWebsiteConfig(config);
  return Object.fromEntries(CLIENT_DESIGN_GROUPS.map((key) => [key, clone(normalized[key])]));
}

function mergeClientDesign(base, design) {
  if (!design) return normalizeWebsiteConfig(base);
  return normalizeWebsiteConfig({ ...base, ...designOnly(design), branding: base.branding });
}

async function globalPublishedConfig() {
  const active = await WebsiteTheme.findOne({ isActive: true, publishedConfig: { $exists: true, $ne: null } }).sort('-publishedAt').lean();
  return active ? publicPayload(active).config : clone(DEFAULT_WEBSITE_CONFIG);
}

function invalidateActiveCache() {
  activeCache.clear();
}

exports.getActiveConfig = asyncHandler(async (req, res) => {
  const cacheKey = String(req.store?._id || 'default');
  const cached = activeCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.json(cached.payload);
  }
  const active = await WebsiteTheme.findOne({ isActive: true, publishedConfig: { $exists: true, $ne: null } }).sort('-publishedAt').lean();
  const settings = await Settings.findOne(req.tenantFilter || {}).lean() || {};
  const payload = active ? publicPayload(active) : { config: buildInitialConfig(settings), theme: null };
  if (req.store?.storefrontDesign?.publishedConfig) {
    payload.config = mergeClientDesign(payload.config, req.store.storefrontDesign.publishedConfig);
    payload.theme = { ...(payload.theme || {}), storePreset: req.store.storefrontDesign.preset || 'custom', storePublishedAt: req.store.storefrontDesign.publishedAt };
  }
  payload.config = applyStorePresentation(payload.config, settings);
  payload.metadata = {
    title: settings.seoTitle || '',
    description: settings.seoDescription || '',
    image: settings.socialShareImage || payload.config?.branding?.logo || '',
    indexing: settings.searchIndexingEnabled !== false,
  };
  payload.brandIdentityManaged = Boolean(settings.brandIdentityEnabled);
  activeCache.set(cacheKey, { payload, expiresAt: Date.now() + PUBLIC_CACHE_MS });
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  return res.json(payload);
});

exports.getWorkspace = asyncHandler(async (req, res) => {
  const selected = await ensureDefaultTheme(req.user._id);
  const themes = await WebsiteTheme.find().sort({ isActive: -1, updatedAt: -1 });
  res.json({
    themes: themes.map(themeSummary),
    selectedTheme: selected,
    configurationLocked: (await require('../services/masterConfigurationService').readConfiguration()).locked,
    presets: getPresetList({ appearanceOnly: true }),
  });
});

exports.listThemes = asyncHandler(async (req, res) => {
  await ensureDefaultTheme(req.user._id);
  res.json((await WebsiteTheme.find().sort({ isActive: -1, updatedAt: -1 })).map(themeSummary));
});

exports.getTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  res.json(theme);
});

exports.getPresets = asyncHandler(async (req, res) => {
  res.json(getPresetList());
});

exports.getSellerDesign = asyncHandler(async (req, res) => {
  requireClientDesign(req.store);
  const base = await globalPublishedConfig();
  const saved = req.store.storefrontDesign || {};
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    store: { id: String(req.store._id), name: req.store.name, slug: req.store.slug },
    platform: planSummary(req.store),
    draftConfig: mergeClientDesign(base, saved.draftConfig || saved.publishedConfig),
    publishedConfig: saved.publishedConfig ? mergeClientDesign(base, saved.publishedConfig) : base,
    preset: saved.preset || 'default',
    updatedAt: saved.updatedAt || null,
    publishedAt: saved.publishedAt || null,
    presets: getPresetList({ appearanceOnly: true }),
  });
});

exports.updateSellerDesign = asyncHandler(async (req, res) => {
  requireClientDesign(req.store);
  const incoming = req.body?.config;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new ApiError('VALIDATION_ERROR', 'A website design is required');
  const design = designOnly(incoming);
  req.store.storefrontDesign = {
    ...(req.store.storefrontDesign?.toObject?.() || req.store.storefrontDesign || {}),
    preset: String(design.theme?.preset || req.body?.preset || 'custom').slice(0, 40),
    draftConfig: design,
    updatedAt: new Date(),
    updatedBy: req.user._id,
  };
  req.store.markModified('storefrontDesign');
  await req.store.save();
  invalidateActiveCache();
  logAudit({ req, action: 'STOREFRONT_DESIGN_DRAFT_SAVE', entityType: 'Store', entityId: req.store._id, after: { preset: req.store.storefrontDesign.preset } });
  res.json({ draftConfig: mergeClientDesign(await globalPublishedConfig(), design), updatedAt: req.store.storefrontDesign.updatedAt });
});

exports.publishSellerDesign = asyncHandler(async (req, res) => {
  requireClientDesign(req.store);
  if (!req.store.storefrontDesign?.draftConfig) throw new ApiError('VALIDATION_ERROR', 'Save the website design before publishing');
  req.store.storefrontDesign.publishedConfig = clone(req.store.storefrontDesign.draftConfig);
  req.store.storefrontDesign.publishedAt = new Date();
  req.store.storefrontDesign.updatedAt = new Date();
  req.store.storefrontDesign.updatedBy = req.user._id;
  req.store.markModified('storefrontDesign');
  await req.store.save();
  invalidateActiveCache();
  logAudit({ req, action: 'STOREFRONT_DESIGN_PUBLISH', entityType: 'Store', entityId: req.store._id, after: { preset: req.store.storefrontDesign.preset, publishedAt: req.store.storefrontDesign.publishedAt } });
  res.json({ success: true, publishedAt: req.store.storefrontDesign.publishedAt, config: mergeClientDesign(await globalPublishedConfig(), req.store.storefrontDesign.publishedConfig) });
});

exports.createTheme = asyncHandler(async (req, res) => {
  const name = cleanName(req.body?.name);
  const preset = String(req.body?.preset || 'default');
  if (!getPresetList().some((item) => item.id === preset)) throw new ApiError('VALIDATION_ERROR', 'Unknown theme preset');
  const config = req.body?.config ? normalizeWebsiteConfig(req.body.config) : buildPresetConfig(preset);
  const theme = await WebsiteTheme.create({
    name,
    slug: await uniqueSlug(name),
    preset,
    draftConfig: config,
    isActive: false,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });
  logAudit({ req, action: 'WEBSITE_THEME_CREATE', entityType: 'WebsiteTheme', entityId: theme._id, after: themeSummary(theme) });
  res.status(201).json(theme);
});

exports.duplicateTheme = asyncHandler(async (req, res) => {
  const source = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!source) throw notFound('Theme not found');
  const name = cleanName(req.body?.name, `${source.name} Copy`);
  const theme = await WebsiteTheme.create({
    name,
    slug: await uniqueSlug(name),
    preset: source.preset,
    draftConfig: normalizeWebsiteConfig(source.draftConfig || source.publishedConfig),
    isActive: false,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });
  logAudit({ req, action: 'WEBSITE_THEME_DUPLICATE', entityType: 'WebsiteTheme', entityId: theme._id, before: { sourceThemeId: source._id }, after: themeSummary(theme) });
  res.status(201).json(theme);
});

exports.updateDraft = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  const incoming = req.body?.config ?? req.body?.draftConfig;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new ApiError('VALIDATION_ERROR', 'A theme configuration is required. The existing draft has not changed.');
  }
  const before = clone(theme.draftConfig || {});
  if (req.body?.name !== undefined) {
    theme.name = cleanName(req.body.name, theme.name);
    theme.slug = await uniqueSlug(theme.name, theme._id);
  }
  theme.draftConfig = normalizeWebsiteConfig(incoming);
  theme.preset = theme.draftConfig.theme.preset;
  theme.updatedBy = req.user._id;
  theme.markModified('draftConfig');
  await saveTheme(theme);
  logAudit({ req, action: 'WEBSITE_THEME_DRAFT_SAVE', entityType: 'WebsiteTheme', entityId: theme._id, before, after: theme.draftConfig });
  res.json(theme);
});

exports.discardDraft = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  theme.draftConfig = normalizeWebsiteConfig(theme.publishedConfig || buildPresetConfig(theme.preset));
  theme.updatedBy = req.user._id;
  theme.markModified('draftConfig');
  await saveTheme(theme);
  logAudit({ req, action: 'WEBSITE_THEME_DRAFT_DISCARD', entityType: 'WebsiteTheme', entityId: theme._id });
  res.json(theme);
});

exports.publishTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  const config = normalizeWebsiteConfig(theme.draftConfig);
  const latest = await WebsiteThemeVersion.findOne({ theme: theme._id }).sort('-version').lean();
  const version = Number(latest?.version || 0) + 1;
  // Reserve the history version before altering the live store. A failed
  // history insert (including a simultaneous publish) must not deactivate it.
  const previousActive = await WebsiteTheme.findOne({ isActive: true }).lean();
  const history = await WebsiteThemeVersion.create({
    theme: theme._id,
    version,
    config,
    note: String(req.body?.note || `Published ${theme.name}`).slice(0, 240),
    publishedBy: req.user._id,
  });
  try {
    await WebsiteTheme.updateMany({ _id: { $ne: theme._id }, isActive: true }, { $set: { isActive: false } });
    theme.publishedConfig = config;
    theme.draftConfig = config;
    theme.isActive = true;
    theme.publishedAt = new Date();
    theme.publishedBy = req.user._id;
    theme.updatedBy = req.user._id;
    theme.markModified('publishedConfig');
    theme.markModified('draftConfig');
    await saveTheme(theme);
  } catch (error) {
    await WebsiteThemeVersion.deleteOne({ _id: history._id }).catch(() => null);
    // Standalone MongoDB has no multi-document transactions. Restore the
    // previous selection only if another successful publish has not won.
    if (previousActive && !await WebsiteTheme.exists({ isActive: true })) {
      await WebsiteTheme.updateOne({ _id: previousActive._id }, { $set: { isActive: true } }).catch(() => null);
    }
    invalidateActiveCache();
    throw error;
  }
  invalidateActiveCache();
  logAudit({ req, action: 'WEBSITE_THEME_PUBLISH', entityType: 'WebsiteTheme', entityId: theme._id, after: { version, name: theme.name } });
  res.json({ theme, version: history });
});

exports.activateTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  if (!theme.publishedConfig) throw new ApiError('VALIDATION_ERROR', 'Publish this theme before activating it');
  const previousActive = await WebsiteTheme.findOne({ isActive: true }).lean();
  try {
    await WebsiteTheme.updateMany({ _id: { $ne: theme._id }, isActive: true }, { $set: { isActive: false } });
    theme.isActive = true;
    theme.updatedBy = req.user._id;
    await saveTheme(theme);
  } catch (error) {
    if (previousActive && !await WebsiteTheme.exists({ isActive: true })) {
      await WebsiteTheme.updateOne({ _id: previousActive._id }, { $set: { isActive: true } }).catch(() => null);
    }
    invalidateActiveCache();
    throw error;
  }
  invalidateActiveCache();
  logAudit({ req, action: 'WEBSITE_THEME_ACTIVATE', entityType: 'WebsiteTheme', entityId: theme._id });
  res.json(theme);
});

exports.deleteTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  if (theme.isActive) throw new ApiError('DUPLICATE_REQUEST', 'The active theme cannot be deleted');
  const deleted = await WebsiteTheme.deleteOne({ _id: theme._id, isActive: false, __v: theme.__v });
  if (!deleted.deletedCount) throw new ApiError('DUPLICATE_REQUEST', 'This theme changed or became active. Reload before deleting.');
  await WebsiteThemeVersion.deleteMany({ theme: theme._id });
  logAudit({ req, action: 'WEBSITE_THEME_DELETE', entityType: 'WebsiteTheme', entityId: theme._id, before: themeSummary(theme) });
  res.json({ success: true, message: 'Theme deleted' });
});

exports.getHistory = asyncHandler(async (req, res) => {
  const themeId = requireThemeId(req.params.id);
  if (!await WebsiteTheme.exists({ _id: themeId })) throw notFound('Theme not found');
  const versions = WebsiteThemeVersion.find({ theme: themeId }).populate('publishedBy', 'name email phone').sort('-version').limit(100);
  // Restoring still reads the immutable snapshot on the server. The designer
  // only needs metadata, not 100 complete theme configurations in memory.
  if (req.query?.summary === 'true') versions.select('-config');
  res.json(await versions.lean());
});

exports.restoreVersion = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  requireCurrentRevision(req, theme);
  const versionId = requireThemeId(req.params.versionId);
  const version = await WebsiteThemeVersion.findOne({ _id: versionId, theme: theme._id });
  if (!version) throw notFound('Theme version not found');
  theme.draftConfig = normalizeWebsiteConfig(version.config);
  theme.updatedBy = req.user._id;
  theme.markModified('draftConfig');
  await saveTheme(theme);
  logAudit({ req, action: 'WEBSITE_THEME_VERSION_RESTORE', entityType: 'WebsiteTheme', entityId: theme._id, after: { restoredVersion: version.version } });
  res.json({ theme, restoredVersion: version.version, message: 'Version restored to draft. Review and publish it when ready.' });
});

exports._invalidateActiveCache = invalidateActiveCache;
