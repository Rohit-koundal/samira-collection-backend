const crypto = require('crypto');
const Configuration = require('../models/MasterConfiguration');
const ConfigurationVersion = require('../models/MasterConfigurationVersion');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const Cart = require('../models/Cart');
const Order = require('../models/Order');
const Category = require('../models/Category');
const Store = require('../models/Store');
const ClientInstallation = require('../models/ClientInstallation');
const { ApiError } = require('../utils/apiError');
const { validateStructure } = require('./masterConfigurationService');
const DEFAULT_STORE_SCOPE = { storeId: null };

const clone = (value) => JSON.parse(JSON.stringify(value));
const comparable = (value) => JSON.stringify(value ?? null);
const printable = (value) => {
  if (value === undefined) return '';
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return String(raw).slice(0, 2000);
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function impactToken(revision, structure) {
  return crypto.createHash('sha256').update(JSON.stringify({ revision, structure: stable(structure) })).digest('hex');
}

function listChanges(before, after) {
  const changes = [];
  const add = (path, kind, left, right, risk = 'SAFE') => changes.push({ path, kind, before: printable(left), after: printable(right), risk });
  const beforeAttributes = new Map((before.attributes || []).map((item) => [item.key, item]));
  const afterAttributes = new Map((after.attributes || []).map((item) => [item.key, item]));
  for (const [key, item] of beforeAttributes) {
    const next = afterAttributes.get(key);
    if (!next) add(`attributes.${key}`, 'REMOVED', item, undefined, 'BREAKING');
    else if (comparable(item) !== comparable(next)) {
      const breaking = item.type !== next.type || (item.required !== true && next.required === true)
        || item.variant !== next.variant || (item.options || []).some((option) => !(next.options || []).includes(option));
      add(`attributes.${key}`, 'CHANGED', item, next, breaking ? 'BREAKING' : 'REVIEW');
    }
  }
  for (const [key, item] of afterAttributes) if (!beforeAttributes.has(key)) add(`attributes.${key}`, 'ADDED', undefined, item, item.required ? 'REVIEW' : 'SAFE');

  const beforeCategories = new Map((before.categoryDefinitions || []).map((item) => [item.key, item]));
  const afterCategories = new Map((after.categoryDefinitions || []).map((item) => [item.key, item]));
  for (const [key, item] of beforeCategories) {
    const next = afterCategories.get(key);
    if (!next) add(`categories.${key}`, 'REMOVED', item.name, undefined, 'BREAKING');
    else if (comparable(item) !== comparable(next)) add(`categories.${key}`, 'CHANGED', item, next, 'REVIEW');
  }
  for (const [key, item] of afterCategories) if (!beforeCategories.has(key)) add(`categories.${key}`, 'ADDED', undefined, item.name, 'SAFE');

  const handled = new Set(['attributes', 'categoryDefinitions', 'version', 'id']);
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (handled.has(key) || comparable(before?.[key]) === comparable(after?.[key])) continue;
    const risk = key === 'industry' || key === 'variantConfig' || key === 'inventory'
      || (key === 'features' && before?.features?.sizing !== after?.features?.sizing) ? 'BREAKING'
      : ['filters', 'sortingOptions', 'delivery', 'returns', 'clientPermissions'].includes(key) ? 'REVIEW' : 'SAFE';
    add(key, before?.[key] === undefined ? 'ADDED' : after?.[key] === undefined ? 'REMOVED' : 'CHANGED', before?.[key], after?.[key], risk);
  }
  return changes.slice(0, 250);
}

async function analyzeConfigurationImpact(currentConfiguration, proposedInput) {
  const proposed = validateStructure(proposedInput);
  const current = validateStructure(currentConfiguration.structure);
  const changes = listChanges(current, proposed);
  const removedAttributeKeys = (current.attributes || []).filter((item) => !(proposed.attributes || []).some((next) => next.key === item.key)).map((item) => item.key);
  const requiredKeys = (proposed.attributes || []).filter((item) => item.required).map((item) => item.key);
  const removedCategoryKeys = (current.categoryDefinitions || []).filter((item) => !(proposed.categoryDefinitions || []).some((next) => next.key === item.key)).map((item) => item.key);
  const variantChanged = comparable(current.variantConfig) !== comparable(proposed.variantConfig) || current.features?.sizing !== proposed.features?.sizing;
  const missingRequiredQuery = requiredKeys.length ? {
    ...DEFAULT_STORE_SCOPE, isArchived: { $ne: true },
    $or: requiredKeys.flatMap((key) => [
      { [`attributeValues.${key}`]: { $exists: false } },
      { [`attributeValues.${key}`]: '' },
    ]),
  } : { _id: null };
  const legacyQuery = removedAttributeKeys.length ? { ...DEFAULT_STORE_SCOPE, isArchived: { $ne: true }, $or: [
    ...removedAttributeKeys.map((key) => ({ [`attributeValues.${key}`]: { $exists: true } })),
    { 'specifications.key': { $in: removedAttributeKeys } },
  ] } : { _id: null };
  const categoryQuery = removedCategoryKeys.length ? { ...DEFAULT_STORE_SCOPE, isArchived: { $ne: true }, categoryDefinitionKey: { $in: removedCategoryKeys } } : { _id: null };
  const reviewConditions = [
    ...(requiredKeys.length ? missingRequiredQuery.$or : []),
    ...(removedAttributeKeys.length ? legacyQuery.$or : []),
    ...(removedCategoryKeys.length ? [{ categoryDefinitionKey: { $in: removedCategoryKeys } }] : []),
    ...(variantChanged ? [{ 'variants.0': { $exists: true } }] : []),
  ];
  const reviewProductQuery = reviewConditions.length ? { ...DEFAULT_STORE_SCOPE, isArchived: { $ne: true }, $or: reviewConditions } : { _id: null };
  const activeOrderStatuses = ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Return Requested', 'Exchange Requested'];
  const [products, publishedProducts, missingRequired, legacyProducts, categoryProducts, variantProducts, affectedProducts, drafts, carts, activeOrders, categories] = await Promise.all([
    Product.countDocuments({ ...DEFAULT_STORE_SCOPE, isArchived: { $ne: true } }),
    Product.countDocuments({ ...DEFAULT_STORE_SCOPE, isArchived: { $ne: true }, isActive: { $ne: false } }),
    Product.countDocuments(missingRequiredQuery),
    Product.countDocuments(legacyQuery),
    Product.countDocuments(categoryQuery),
    variantChanged ? Product.countDocuments({ ...DEFAULT_STORE_SCOPE, isArchived: { $ne: true }, 'variants.0': { $exists: true } }) : 0,
    Product.countDocuments(reviewProductQuery),
    ProductDraft.countDocuments({ ...DEFAULT_STORE_SCOPE, status: 'draft' }),
    Cart.countDocuments({ ...DEFAULT_STORE_SCOPE, 'items.0': { $exists: true } }),
    Order.countDocuments({ ...DEFAULT_STORE_SCOPE, orderStatus: { $in: activeOrderStatuses } }),
    Category.countDocuments(DEFAULT_STORE_SCOPE),
  ]);
  const needsReview = affectedProducts;
  const breaking = changes.filter((item) => item.risk === 'BREAKING').length;
  const review = changes.filter((item) => item.risk === 'REVIEW').length;
  const requiresReview = breaking > 0 || (review > 0 && (products > 0 || drafts > 0));
  const sampleProducts = requiresReview ? await Product.find(reviewProductQuery).select('name sku industry categoryDefinitionKey').sort('-updatedAt').limit(8).lean() : [];
  const warnings = [];
  if (missingRequired) warnings.push(`${missingRequired} product(s) are missing one or more required fields.`);
  if (legacyProducts) warnings.push(`${legacyProducts} product(s) contain attributes removed by this draft.`);
  if (categoryProducts) warnings.push(`${categoryProducts} product(s) use categories removed by this draft.`);
  if (variantProducts) warnings.push(`${variantProducts} product(s) have variants that require review.`);
  if (drafts && requiresReview) warnings.push(`${drafts} unpublished draft(s) must be validated against the new structure.`);
  if (carts && variantChanged) warnings.push(`${carts} active shopping bag(s) may contain an old variant selection.`);
  if (activeOrders && requiresReview) warnings.push(`${activeOrders} active order(s) remain on their original order snapshots.`);
  return {
    revision: Number(currentConfiguration.revision || 0),
    proposed,
    token: impactToken(currentConfiguration.revision, proposed),
    requiresReview,
    risk: breaking ? 'BREAKING' : review ? 'REVIEW' : 'SAFE',
    changes,
    counts: { products, publishedProducts, productsNeedingReview: needsReview, missingRequired, legacyProducts, categoryProducts, variantProducts, drafts, carts, activeOrders, categories },
    warnings,
    preserves: ['Products', 'Orders and invoices', 'Customer accounts', 'Payments', 'Uploaded media'],
    estimatedMinutes: requiresReview ? Math.max(5, Math.ceil((needsReview + drafts) / 20) * 5) : 1,
    maintenanceRecommended: Boolean(variantChanged && (products || carts)),
    examples: sampleProducts.map((item) => ({ id: String(item._id), name: item.name, sku: item.sku || '', industry: item.industry || '', categoryDefinitionKey: item.categoryDefinitionKey || '' })),
  };
}

async function listAffectedProducts(currentConfiguration, proposedInput, { page = 1, limit = 100 } = {}) {
  const proposed = validateStructure(proposedInput);
  const current = validateStructure(currentConfiguration.structure);
  const removedKeys = (current.attributes || []).filter((field) => !(proposed.attributes || []).some((next) => next.key === field.key)).map((field) => field.key);
  const requiredKeys = (proposed.attributes || []).filter((field) => field.required).map((field) => field.key);
  const removedCategories = (current.categoryDefinitions || []).filter((category) => !(proposed.categoryDefinitions || []).some((next) => next.key === category.key)).map((category) => category.key);
  const variantChanged = comparable(current.variantConfig) !== comparable(proposed.variantConfig) || current.features?.sizing !== proposed.features?.sizing;
  const conditions = [
    ...requiredKeys.flatMap((key) => [{ [`attributeValues.${key}`]: { $exists: false } }, { [`attributeValues.${key}`]: '' }]),
    ...removedKeys.map((key) => ({ [`attributeValues.${key}`]: { $exists: true } })),
    ...(removedKeys.length ? [{ 'specifications.key': { $in: removedKeys } }] : []),
    ...(removedCategories.length ? [{ categoryDefinitionKey: { $in: removedCategories } }] : []),
    ...(variantChanged ? [{ 'variants.0': { $exists: true } }] : []),
  ];
  if (!conditions.length) return { items: [], page: 1, pages: 1, total: 0, truncated: false };
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(10000, Math.max(1, Number(limit) || 100));
  const query = { ...DEFAULT_STORE_SCOPE, isArchived: { $ne: true }, $or: conditions };
  const [items, total] = await Promise.all([
    Product.find(query).select('name sku slug industry categoryDefinitionKey attributeValues specifications variants isActive updatedAt').sort('name').skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    Product.countDocuments(query),
  ]);
  return {
    items: items.map((item) => {
      const values = item.attributeValues instanceof Map ? Object.fromEntries(item.attributeValues) : (item.attributeValues || {});
      const specificationKeys = new Set((item.specifications || []).map((row) => row.key));
      const reasons = [];
      const missing = requiredKeys.filter((key) => values[key] === undefined || values[key] === null || values[key] === '');
      const legacy = removedKeys.filter((key) => values[key] !== undefined || specificationKeys.has(key));
      if (missing.length) reasons.push(`Missing required: ${missing.join(', ')}`);
      if (legacy.length) reasons.push(`Removed attributes: ${legacy.join(', ')}`);
      if (removedCategories.includes(item.categoryDefinitionKey)) reasons.push(`Removed category: ${item.categoryDefinitionKey}`);
      if (variantChanged && item.variants?.length) reasons.push('Variant or sizing configuration changed');
      return { id: String(item._id), name: item.name, sku: item.sku || '', slug: item.slug || '', industry: item.industry || '', categoryDefinitionKey: item.categoryDefinitionKey || '', active: item.isActive !== false, updatedAt: item.updatedAt, reasons };
    }),
    page: safePage,
    pages: Math.max(1, Math.ceil(total / safeLimit)),
    total,
    truncated: safePage * safeLimit < total,
  };
}

function assertImpactToken(configuration, structure, token) {
  const expected = impactToken(configuration.revision, validateStructure(structure));
  const supplied = String(token || '');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new ApiError('CONFIRMATION_REQUIRED', 'Review the latest configuration impact before publishing this structure.');
  }
}

async function recordConfigurationVersion(configuration, user, { kind = 'PUBLISH', note = '', changes = [], impact } = {}) {
  return ConfigurationVersion.findOneAndUpdate(
    { scopeKey: 'store', revision: configuration.revision },
    { $setOnInsert: { structure: clone(configuration.structure), locked: Boolean(configuration.locked), kind, note: String(note || '').trim().slice(0, 240), changes: changes.slice(0, 250), impact, publishedBy: user?._id } },
    { upsert: true, new: true, runValidators: true },
  );
}

async function listConfigurationVersions({ page = 1, limit = 12, query = '' } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 12));
  const filter = { scopeKey: 'store' };
  if (String(query || '').trim()) filter.$or = [
    { note: { $regex: escapeRegex(String(query).trim().slice(0, 80)), $options: 'i' } },
    { kind: { $regex: escapeRegex(String(query).trim().slice(0, 80)), $options: 'i' } },
  ];
  const [items, total] = await Promise.all([
    ConfigurationVersion.find(filter).select('-structure').populate('publishedBy', 'name phone').sort('-revision').skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    ConfigurationVersion.countDocuments(filter),
  ]);
  return { items: items.map((item) => ({ ...item, id: String(item._id), _id: undefined })), page: safePage, pages: Math.max(1, Math.ceil(total / safeLimit)), total };
}

async function getConfigurationVersion(idOrRevision) {
  const numericRevision = Number(idOrRevision);
  let version = Number.isInteger(numericRevision)
    ? await ConfigurationVersion.findOne({ scopeKey: 'store', revision: numericRevision }).lean()
    : null;
  if (!version && /^[a-f0-9]{24}$/i.test(String(idOrRevision || ''))) version = await ConfigurationVersion.findOne({ _id: idOrRevision, scopeKey: 'store' }).lean();
  if (!version) {
    const configuration = await Configuration.findById('store').lean();
    const legacy = (configuration?.history || []).find((item) => Number(item.revision) === numericRevision);
    if (legacy) version = { revision: legacy.revision, structure: legacy.structure, locked: legacy.locked, note: legacy.note, createdAt: legacy.at, kind: 'BASELINE', changes: [] };
  }
  if (!version) throw new ApiError('NOT_FOUND', 'Configuration version not found');
  return { ...version, id: String(version._id || `legacy-${version.revision}`), _id: undefined };
}

async function presetUsage(key) {
  const path = `industryConfigurations.${key}`;
  const [activeStores, savedConfigurations, installations, historyReferences] = await Promise.all([
    Store.countDocuments({ industry: key }),
    Store.countDocuments({ [path]: { $exists: true } }),
    ClientInstallation.countDocuments({ industry: key, status: { $ne: 'REVOKED' } }),
    ConfigurationVersion.countDocuments({ 'structure.industry': key }),
  ]);
  return { activeStores, savedConfigurations, installations, historyReferences, total: activeStores + savedConfigurations + installations + historyReferences };
}

module.exports = {
  analyzeConfigurationImpact, assertImpactToken, getConfigurationVersion, impactToken,
  listAffectedProducts, listChanges, listConfigurationVersions, presetUsage, recordConfigurationVersion,
};
