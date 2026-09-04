const mongoose = require('mongoose');
const WebsiteTheme = require('../models/WebsiteTheme');
const WebsiteThemeVersion = require('../models/WebsiteThemeVersion');
const Settings = require('../models/Settings');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, notFound } = require('../utils/apiError');
const { logAudit } = require('../services/auditService');
const {
  DEFAULT_WEBSITE_CONFIG,
  buildPresetConfig,
  getPresetList,
  normalizeWebsiteConfig,
} = require('../config/websiteCustomization');

const PUBLIC_CACHE_MS = 60 * 1000;
let activeCache = null;
let activeCacheExpiresAt = 0;

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

function invalidateActiveCache() {
  activeCache = null;
  activeCacheExpiresAt = 0;
}

exports.getActiveConfig = asyncHandler(async (req, res) => {
  if (activeCache && Date.now() < activeCacheExpiresAt) {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.json(activeCache);
  }
  const active = await WebsiteTheme.findOne({ isActive: true, publishedConfig: { $exists: true, $ne: null } }).sort('-publishedAt').lean();
  activeCache = active ? publicPayload(active) : { config: buildInitialConfig(await Settings.findOne().lean()), theme: null };
  activeCacheExpiresAt = Date.now() + PUBLIC_CACHE_MS;
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  return res.json(activeCache);
});

exports.getWorkspace = asyncHandler(async (req, res) => {
  const selected = await ensureDefaultTheme(req.user._id);
  const themes = await WebsiteTheme.find().sort({ isActive: -1, updatedAt: -1 });
  res.json({
    themes: themes.map(themeSummary),
    selectedTheme: selected,
    presets: getPresetList().map(({ id, name }) => ({ id, name })),
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
  const before = clone(theme.draftConfig || {});
  if (req.body?.name !== undefined) {
    theme.name = cleanName(req.body.name, theme.name);
    theme.slug = await uniqueSlug(theme.name, theme._id);
  }
  theme.draftConfig = normalizeWebsiteConfig(req.body?.config || req.body?.draftConfig || {});
  theme.preset = theme.draftConfig.theme.preset;
  theme.updatedBy = req.user._id;
  theme.markModified('draftConfig');
  await theme.save();
  logAudit({ req, action: 'WEBSITE_THEME_DRAFT_SAVE', entityType: 'WebsiteTheme', entityId: theme._id, before, after: theme.draftConfig });
  res.json(theme);
});

exports.discardDraft = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  theme.draftConfig = normalizeWebsiteConfig(theme.publishedConfig || buildPresetConfig(theme.preset));
  theme.updatedBy = req.user._id;
  theme.markModified('draftConfig');
  await theme.save();
  logAudit({ req, action: 'WEBSITE_THEME_DRAFT_DISCARD', entityType: 'WebsiteTheme', entityId: theme._id });
  res.json(theme);
});

exports.publishTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  const config = normalizeWebsiteConfig(theme.draftConfig);
  const latest = await WebsiteThemeVersion.findOne({ theme: theme._id }).sort('-version').lean();
  const version = Number(latest?.version || 0) + 1;
  await WebsiteTheme.updateMany({ _id: { $ne: theme._id }, isActive: true }, { $set: { isActive: false } });
  theme.publishedConfig = config;
  theme.draftConfig = config;
  theme.isActive = true;
  theme.publishedAt = new Date();
  theme.publishedBy = req.user._id;
  theme.updatedBy = req.user._id;
  theme.markModified('publishedConfig');
  theme.markModified('draftConfig');
  await theme.save();
  const history = await WebsiteThemeVersion.create({
    theme: theme._id,
    version,
    config,
    note: String(req.body?.note || `Published ${theme.name}`).slice(0, 240),
    publishedBy: req.user._id,
  });
  invalidateActiveCache();
  logAudit({ req, action: 'WEBSITE_THEME_PUBLISH', entityType: 'WebsiteTheme', entityId: theme._id, after: { version, name: theme.name } });
  res.json({ theme, version: history });
});

exports.activateTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  if (!theme.publishedConfig) throw new ApiError('VALIDATION_ERROR', 'Publish this theme before activating it');
  await WebsiteTheme.updateMany({ _id: { $ne: theme._id }, isActive: true }, { $set: { isActive: false } });
  theme.isActive = true;
  theme.updatedBy = req.user._id;
  await theme.save();
  invalidateActiveCache();
  logAudit({ req, action: 'WEBSITE_THEME_ACTIVATE', entityType: 'WebsiteTheme', entityId: theme._id });
  res.json(theme);
});

exports.deleteTheme = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  if (theme.isActive) throw new ApiError('DUPLICATE_REQUEST', 'The active theme cannot be deleted');
  await Promise.all([
    WebsiteTheme.deleteOne({ _id: theme._id }),
    WebsiteThemeVersion.deleteMany({ theme: theme._id }),
  ]);
  logAudit({ req, action: 'WEBSITE_THEME_DELETE', entityType: 'WebsiteTheme', entityId: theme._id, before: themeSummary(theme) });
  res.json({ success: true, message: 'Theme deleted' });
});

exports.getHistory = asyncHandler(async (req, res) => {
  const themeId = requireThemeId(req.params.id);
  if (!await WebsiteTheme.exists({ _id: themeId })) throw notFound('Theme not found');
  res.json(await WebsiteThemeVersion.find({ theme: themeId }).populate('publishedBy', 'name email phone').sort('-version').limit(100));
});

exports.restoreVersion = asyncHandler(async (req, res) => {
  const theme = await WebsiteTheme.findById(requireThemeId(req.params.id));
  if (!theme) throw notFound('Theme not found');
  const versionId = requireThemeId(req.params.versionId);
  const version = await WebsiteThemeVersion.findOne({ _id: versionId, theme: theme._id });
  if (!version) throw notFound('Theme version not found');
  theme.draftConfig = normalizeWebsiteConfig(version.config);
  theme.updatedBy = req.user._id;
  theme.markModified('draftConfig');
  await theme.save();
  logAudit({ req, action: 'WEBSITE_THEME_VERSION_RESTORE', entityType: 'WebsiteTheme', entityId: theme._id, after: { restoredVersion: version.version } });
  res.json({ theme, restoredVersion: version.version, message: 'Version restored to draft. Review and publish it when ready.' });
});

exports._invalidateActiveCache = invalidateActiveCache;
