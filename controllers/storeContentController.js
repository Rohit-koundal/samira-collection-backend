const Theme = require('../models/WebsiteTheme');
const { readConfiguration } = require('../services/masterConfigurationService');
const { isMasterOwner } = require('../config/masterOwner');
const { normalizeWebsiteConfig } = require('../config/websiteCustomization');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { logAudit } = require('../services/auditService');
const fields = {
  websiteName: ['branding', 'websiteName'], tagline: ['branding', 'tagline'],
  announcement: ['header', 'announcementText'], footerDescription: ['footer', 'description'],
  contactEmail: ['footer', 'contactEmail'], contactPhone: ['footer', 'contactPhone'], contactAddress: ['footer', 'contactAddress'],
};
async function allowed(req) {
  if (!isMasterOwner(req.user) && !(await readConfiguration()).structure.clientPermissions.content) throw new ApiError('FORBIDDEN', 'Store content editing is not enabled for this account');
}
exports.get = asyncHandler(async (req, res) => {
  await allowed(req);
  const theme = await Theme.findOne({ isActive: true }).lean();
  if (!theme?.publishedConfig) return res.json({ available: false });
  const config = normalizeWebsiteConfig(theme.publishedConfig);
  res.json({ available: true, revision: theme.updatedAt,
    content: Object.fromEntries(Object.entries(fields).map(([key, [group, name]]) => [key, config[group][name]])),
    sections: config.homepage.sections.map(({ id, label, heading, description, buttonText }) => ({ id, label, heading, description, buttonText })) });
});
exports.update = asyncHandler(async (req, res) => {
  await allowed(req);
  const theme = await Theme.findOne({ isActive: true });
  if (!theme?.publishedConfig) throw new ApiError('NOT_FOUND', 'Ask the store owner to publish an initial theme');
  if (!req.body?.revision || new Date(req.body.revision).getTime() !== new Date(theme.updatedAt).getTime()) throw new ApiError('DUPLICATE_REQUEST', 'Content changed in another session. Reload before saving.');
  const content = req.body.content;
  if (!content || Object.keys(content).some((key) => !Object.prototype.hasOwnProperty.call(fields, key)) ||
    Object.keys(req.body).some((key) => !['content', 'sections', 'revision'].includes(key))) throw new ApiError('FORBIDDEN', 'Only store content can be edited here');
  for (const value of Object.values(content)) if (typeof value !== 'string' || value.length > 1000) throw new ApiError('VALIDATION_ERROR', 'Keep content fields under 1000 characters');
  if (!content.websiteName?.trim()) throw new ApiError('VALIDATION_ERROR', 'Enter a website name');
  const sections = req.body.sections || [];
  if (!Array.isArray(sections) || sections.length > 14 || sections.some((item) => !item || Object.keys(item).some((key) => !['id', 'label', 'heading', 'description', 'buttonText'].includes(key)))) throw new ApiError('FORBIDDEN', 'Only section wording can be edited here');
  const patch = (source) => {
    const config = normalizeWebsiteConfig(source);
    for (const [key, [group, name]] of Object.entries(fields)) if (content[key] !== undefined) config[group][name] = content[key].trim();
    for (const item of sections) {
      const section = config.homepage.sections.find((entry) => entry.id === item.id);
      if (!section) throw new ApiError('VALIDATION_ERROR', 'Unknown homepage section');
      for (const key of ['heading', 'description', 'buttonText']) {
        if (typeof item[key] !== 'string' || item[key].length > 1000) throw new ApiError('VALIDATION_ERROR', 'Keep section wording under 1000 characters');
        section[key] = item[key].trim();
      }
    }
    return normalizeWebsiteConfig(config);
  };
  const saved = await Theme.findOneAndUpdate({ _id: theme._id, isActive: true, updatedAt: theme.updatedAt }, {
    $set: { publishedConfig: patch(theme.publishedConfig), draftConfig: patch(theme.draftConfig), updatedBy: req.user._id },
    $inc: { __v: 1 },
  }, { new: true, runValidators: true });
  if (!saved) throw new ApiError('DUPLICATE_REQUEST', 'Content changed while saving. Reload and review.');
  require('./websiteCustomizationController')._invalidateActiveCache();
  logAudit({ req, action: 'STORE_CONTENT_UPDATE', entityType: 'WebsiteTheme', entityId: saved._id });
  res.json({ success: true, revision: saved.updatedAt });
});
