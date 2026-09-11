const crypto = require('node:crypto');
const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const Cart = require('../models/Cart');
const Category = require('../models/Category');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const StorePortfolioOperation = require('../models/StorePortfolioOperation');
const SubscriptionPayment = require('../models/SubscriptionPayment');
const User = require('../models/User');
const { BILLING_CYCLES, LICENSE_STATUSES, LIMIT_KEYS, PLAN_IDS, STORE_PLANS, nextPeriodEnd, normalizeBillingCycle, normalizePlan, planSummary } = require('../config/storePlans');
const { ApiError } = require('../utils/apiError');
const { runInTransaction } = require('../utils/transaction');
const { optionalEmail, optionalIndianMobile, optionalString, readPagination, requirePincode, requireString } = require('../utils/validators');
const { normalizePhone } = require('../utils/phoneUtils');
const slugify = require('../utils/slugify');

const ACTIVE_ORDER_STATUSES = { $nin: ['Delivered', 'Cancelled', 'Returned', 'Refunded'] };
const MEMBER_ROLES = ['MANAGER', 'CATALOG_MANAGER', 'ORDER_MANAGER', 'SUPPORT', 'MARKETING', 'WAREHOUSE'];
const MIGRATION_STATUSES = ['READY', 'IN_PROGRESS', 'REVIEW_REQUIRED', 'COMPLETED', 'FAILED', 'ROLLED_BACK'];
const STORE_STATUSES = ['DRAFT', 'ONBOARDING', 'PUBLISHED', 'SUSPENDED'];
const clone = (value) => JSON.parse(JSON.stringify(value));

function escapeRegex(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function requireId(value, label = 'store') {
  if (!mongoose.isValidObjectId(value)) throw new ApiError('VALIDATION_ERROR', `Choose a valid ${label}`);
  return value;
}
function reason(value, action = 'change') {
  const text = String(value || '').trim();
  if (text.length < 3) throw new ApiError('VALIDATION_ERROR', `Add a reason for this ${action}`);
  if (text.length > 500) throw new ApiError('VALIDATION_ERROR', 'Reason must be 500 characters or fewer');
  return text;
}
function portfolioSecret() {
  const secret = String(process.env.STORE_PORTFOLIO_SIGNING_SECRET || process.env.JWT_SECRET || '').trim();
  if (secret.length < 12) throw new ApiError('SERVICE_UNAVAILABLE', 'Store portfolio signing is not configured');
  return secret;
}
function signPayload(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', portfolioSecret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}
function verifyPayload(token) {
  const [encoded, supplied] = String(token || '').split('.');
  if (!encoded || !supplied) throw new ApiError('CONFIRMATION_REQUIRED', 'Preview this industry change again before applying it');
  const expected = crypto.createHmac('sha256', portfolioSecret()).update(encoded).digest('base64url');
  const left = Buffer.from(supplied); const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw new ApiError('CONFIRMATION_REQUIRED', 'Industry review confirmation is invalid');
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new ApiError('CONFIRMATION_REQUIRED', 'Industry review confirmation is invalid'); }
  if (!payload?.exp || payload.exp < Date.now()) throw new ApiError('CONFIRMATION_REQUIRED', 'Industry review expired. Preview the change again.');
  return payload;
}
function assertRevision(store, value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) throw new ApiError('VALIDATION_ERROR', 'A valid store revision is required');
  if (revision !== Number(store.portfolioRevision || 0)) throw new ApiError('DUPLICATE_REQUEST', 'This store changed in another session. Reload before saving.');
  return revision;
}
async function saveRevision(store, revision, session) {
  store.portfolioRevision = revision + 1;
  store.$where = { portfolioRevision: revision };
  try { return await store.save({ ...(session ? { session } : {}) }); }
  catch (error) {
    if (error?.name === 'DocumentNotFoundError' || error?.code === 112) throw new ApiError('DUPLICATE_REQUEST', 'This store changed in another session. Reload before saving.');
    throw error;
  }
}
function endOfIndiaDate(value, label = 'access expiry') {
  if (!value) return null;
  const text = String(value).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T18:29:59.999Z`) : new Date(text);
  if (!Number.isFinite(date.getTime())) throw new ApiError('VALIDATION_ERROR', `Choose a valid ${label}`);
  return date;
}
function readiness(store, usage = {}) {
  const steps = {
    identity: Boolean(String(store.name || '').trim() && String(store.slug || '').trim()),
    brand: Boolean(store.logo),
    contact: Boolean(store.supportPhone || store.supportEmail || store.whatsappNumber),
    pickup: Boolean(store.pickupAddress?.pincode && store.pickupAddress?.city),
    returns: Boolean(store.returnAddress?.pincode && store.returnAddress?.city),
    payments: Boolean(store.paymentReady),
    shipping: Boolean(store.shippingReady),
    catalog: Number(usage.products || 0) > 0,
  };
  const completed = Object.values(steps).filter(Boolean).length;
  return { steps, completed, total: Object.keys(steps).length, percent: Math.round((completed / Object.keys(steps).length) * 100), ready: completed === Object.keys(steps).length };
}
function ownerView(owner) {
  if (!owner || typeof owner !== 'object') return null;
  return { id: String(owner._id || owner.id || ''), name: owner.name || '', phone: owner.phone || '', email: owner.email || '', isBlocked: Boolean(owner.isBlocked), lastLoginAt: owner.lastLoginAt || null };
}
function projectedLimitAt({ current, addedThisMonth, limit, resetsMonthly = false }, now = new Date()) {
  if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) return null;
  if (Number(current) >= Number(limit)) return now;
  if (!Number.isFinite(Number(addedThisMonth)) || Number(addedThisMonth) <= 0) return null;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const elapsedDays = Math.max(1, (now.getTime() - monthStart.getTime()) / 86400000);
  const dailyPace = Number(addedThisMonth) / elapsedDays;
  const projection = new Date(now.getTime() + Math.ceil((Number(limit) - Number(current)) / dailyPace) * 86400000);
  if (resetsMonthly) {
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    if (projection >= nextMonth) return null;
  }
  return projection;
}
function storeView(store, usage = {}) {
  const data = typeof store?.toObject === 'function' ? store.toObject() : { ...store };
  const migration = data.industryMigration || {};
  const platform = planSummary(data);
  const usageView = {
    products: Number(usage.products || 0), productsAddedMonth: Number(usage.productsAddedMonth || 0),
    ordersPerMonth: Number(usage.ordersPerMonth || 0), paidRevenueMonth: Number(usage.paidRevenueMonth || 0),
  };
  usageView.projectedProductLimitAt = projectedLimitAt({ current: usageView.products, addedThisMonth: usageView.productsAddedMonth, limit: platform.limits.products });
  usageView.projectedOrderLimitAt = projectedLimitAt({ current: usageView.ordersPerMonth, addedThisMonth: usageView.ordersPerMonth, limit: platform.limits.ordersPerMonth, resetsMonthly: true });
  return {
    id: String(data._id), revision: Number(data.portfolioRevision || 0), name: data.name, legalName: data.legalName || '', slug: data.slug,
    logo: data.logo || '', customDomain: data.customDomain || '', status: data.status, statusReason: data.statusReason || '', archivedAt: data.archivedAt || null,
    checkoutEnabled: data.checkoutEnabled !== false, paymentReady: Boolean(data.paymentReady), shippingReady: Boolean(data.shippingReady),
    pickupAddress: data.pickupAddress || {}, returnAddress: data.returnAddress || {}, supportPhone: data.supportPhone || '', supportEmail: data.supportEmail || '', whatsappNumber: data.whatsappNumber || '',
    isDefault: Boolean(data.isDefault), industry: data.industry || 'fashion', industryRevision: Number(data.industryRevision || 0),
    migration: {
      status: migration.status || 'READY', fromIndustry: migration.fromIndustry || '', toIndustry: migration.toIndustry || '',
      totalProducts: Number(migration.totalProducts || 0), affectedProducts: Number(migration.affectedProducts || 0),
      missingRequired: Number(migration.missingRequired || 0), invalidValues: Number(migration.invalidValues || 0),
      incompatibleVariants: Number(migration.incompatibleVariants || 0), legacyAttributes: Number(migration.legacyAttributes || 0),
      draftProducts: Number(migration.draftProducts || 0), activeCarts: Number(migration.activeCarts || 0), activeOrders: Number(migration.activeOrders || 0),
      reviewAssignedTo: migration.reviewAssignedTo ? String(migration.reviewAssignedTo) : '', reviewNote: migration.reviewNote || '',
      failureMessage: migration.failureMessage || '', checkedAt: migration.checkedAt || null, switchedAt: migration.switchedAt || null,
      completedAt: migration.completedAt || null, rolledBackAt: migration.rolledBackAt || null, canRollback: Boolean(migration.rollbackSnapshot),
    }, owner: ownerView(data.owner), platform, usage: usageView,
    readiness: readiness(data, usageView), createdAt: data.createdAt, updatedAt: data.updatedAt, publishedAt: data.publishedAt || null,
  };
}
async function usageForStores(ids) {
  if (!ids.length) return new Map();
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [products, productsAdded, orders, revenue] = await Promise.all([
    Product.aggregate([{ $match: { storeId: { $in: ids }, isArchived: { $ne: true } } }, { $group: { _id: '$storeId', count: { $sum: 1 } } }]),
    Product.aggregate([{ $match: { storeId: { $in: ids }, isArchived: { $ne: true }, createdAt: { $gte: monthStart } } }, { $group: { _id: '$storeId', count: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { storeId: { $in: ids }, createdAt: { $gte: monthStart }, orderStatus: { $ne: 'Cancelled' } } }, { $group: { _id: '$storeId', count: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { storeId: { $in: ids }, createdAt: { $gte: monthStart }, paymentStatus: 'Paid', orderStatus: { $ne: 'Cancelled' } } }, { $group: { _id: '$storeId', value: { $sum: { $ifNull: ['$finalAmount', { $ifNull: ['$totalPrice', 0] }] } } } }]),
  ]);
  const map = new Map(ids.map((id) => [String(id), { products: 0, productsAddedMonth: 0, ordersPerMonth: 0, paidRevenueMonth: 0 }]));
  products.forEach((row) => { map.get(String(row._id)).products = row.count; });
  productsAdded.forEach((row) => { map.get(String(row._id)).productsAddedMonth = row.count; });
  orders.forEach((row) => { map.get(String(row._id)).ordersPerMonth = row.count; });
  revenue.forEach((row) => { map.get(String(row._id)).paidRevenueMonth = row.value; });
  return map;
}
function licenseFilter(status) {
  const now = new Date();
  if (status === 'EXPIRED') return { $or: [{ 'license.status': 'EXPIRED' }, { 'license.billingCycle': { $ne: 'LIFETIME' }, 'license.endsAt': { $lte: now } }] };
  if (status === 'ACTIVE') return { 'license.status': 'ACTIVE', $or: [{ 'license.billingCycle': 'LIFETIME' }, { 'license.endsAt': { $gt: now } }] };
  return status ? { 'license.status': status } : {};
}
function usagePressure(store, usage = {}) {
  const limits = planSummary(store).limits || {};
  const ratio = (value, limit) => Number(limit) > 0 ? Number(value || 0) / Number(limit) : 0;
  return Math.max(ratio(usage.products, limits.products), ratio(usage.ordersPerMonth, limits.ordersPerMonth));
}
async function listStores(query = {}, industryOptions = [], pricedPlans = Object.values(STORE_PLANS)) {
  const { page, limit, skip } = readPagination(query, { defaultLimit: 20, maxLimit: 100 });
  const filter = {};
  const q = String(query.q || '').trim().slice(0, 100);
  const clauses = [];
  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    const owners = await User.find({ $or: [{ name: pattern }, { phone: pattern }, { email: pattern }] }).select('_id').limit(100).lean();
    clauses.push({ $or: [{ name: pattern }, { slug: pattern }, { customDomain: pattern }, { owner: { $in: owners.map((item) => item._id) } }] });
  }
  if (query.industry) filter.industry = String(query.industry).toLowerCase();
  if (query.plan) filter.plan = String(query.plan).toUpperCase();
  if (query.storeStatus) filter.status = String(query.storeStatus).toUpperCase();
  if (query.migration) filter['industryMigration.status'] = String(query.migration).toUpperCase();
  if (query.archive === 'only') filter.archivedAt = { $ne: null }; else if (query.archive !== 'all') filter.archivedAt = null;
  const access = licenseFilter(String(query.license || '').toUpperCase());
  if (Object.keys(access).length) clauses.push(access);
  if (query.readiness === 'incomplete') clauses.push({ $or: [{ paymentReady: { $ne: true } }, { shippingReady: { $ne: true } }, { 'pickupAddress.pincode': { $in: [null, ''] } }] });
  if (clauses.length) filter.$and = clauses;
  const sortMap = { name: 'name', expiry: 'license.endsAt', updated: '-updatedAt', readiness: 'paymentReady shippingReady', newest: '-createdAt' };
  const sort = sortMap[query.sort] || '-createdAt';
  let stores; let total; let usage;
  if (query.sort === 'usage') {
    // Only the explicit usage sort calculates pressure across matching stores.
    // Normal browsing remains a bounded database query.
    const candidates = await Store.find(filter).select('_id plan license').lean();
    const candidateUsage = await usageForStores(candidates.map((item) => item._id));
    const pageIds = candidates
      .sort((left, right) => usagePressure(right, candidateUsage.get(String(right._id))) - usagePressure(left, candidateUsage.get(String(left._id))))
      .slice(skip, skip + limit)
      .map((item) => item._id);
    const rows = await Store.find({ _id: { $in: pageIds } }).populate('owner', 'name phone email isBlocked lastLoginAt').lean();
    const rowMap = new Map(rows.map((item) => [String(item._id), item]));
    stores = pageIds.map((id) => rowMap.get(String(id))).filter(Boolean);
    total = candidates.length;
    usage = candidateUsage;
  } else {
    [stores, total] = await Promise.all([
      Store.find(filter).populate('owner', 'name phone email isBlocked lastLoginAt').sort(sort).skip(skip).limit(limit).lean(),
      Store.countDocuments(filter),
    ]);
    usage = await usageForStores(stores.map((item) => item._id));
  }
  const all = await Store.find({ archivedAt: null }).select('license status industryMigration paymentReady shippingReady pickupAddress').lean();
  const summaries = all.map((item) => ({ item, platform: planSummary(item) }));
  const expiringDate = new Date(Date.now() + 30 * 86400000);
  const summary = {
    total: all.length,
    active: summaries.filter(({ platform }) => platform.status === 'ACTIVE').length,
    trials: summaries.filter(({ platform }) => platform.status === 'TRIAL').length,
    expired: summaries.filter(({ platform }) => platform.status === 'EXPIRED').length,
    expiring: summaries.filter(({ platform }) => platform.endsAt && new Date(platform.endsAt) <= expiringDate && !['EXPIRED', 'SUSPENDED'].includes(platform.status)).length,
    suspended: summaries.filter(({ platform }) => platform.status === 'SUSPENDED').length,
    migrationPending: all.filter((item) => ['IN_PROGRESS', 'REVIEW_REQUIRED', 'FAILED'].includes(item.industryMigration?.status)).length,
    setupIncomplete: all.filter((item) => !item.paymentReady || !item.shippingReady || !item.pickupAddress?.pincode).length,
  };
  return { stores: stores.map((item) => storeView(item, usage.get(String(item._id)))), summary, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }, plans: pricedPlans, industryOptions };
}

async function storeOperations(storeId) {
  const id = requireId(storeId);
  const store = await Store.findById(id).populate('owner', 'name phone email isBlocked lastLoginAt');
  if (!store) throw new ApiError('NOT_FOUND', 'Store not found');
  const usageMap = await usageForStores([store._id]); const usage = usageMap.get(String(store._id));
  const [members, payments, activity, draftProducts, activeCarts, activeOrders] = await Promise.all([
    StoreMember.find({ store: id }).populate('user', 'name phone email isBlocked lastLoginAt').sort('role createdAt').lean(),
    SubscriptionPayment.find({ store: id }).select('-__v').sort('-createdAt').limit(50).lean(),
    AuditLog.find({ storeId: id, visibility: 'OWNER' }).select('-before -after -ip -http').sort('-createdAt').limit(100).lean(),
    ProductDraft.countDocuments({ storeId: id, status: { $ne: 'archived' } }),
    Cart.countDocuments({ storeId: id, 'items.0': { $exists: true } }),
    Order.countDocuments({ storeId: id, orderStatus: ACTIVE_ORDER_STATUSES }),
  ]);
  return {
    store: storeView(store, usage),
    members: members.map((item) => ({ id: String(item._id), role: item.role, status: item.status, statusReason: item.statusReason || '', invitedAt: item.invitedAt, activatedAt: item.activatedAt, revokedAt: item.revokedAt, user: ownerView(item.user) })),
    payments: payments.map((item) => ({ ...item, id: String(item._id), _id: undefined })), paymentTotal: await SubscriptionPayment.countDocuments({ store: id }),
    activity: activity.map((item) => ({ id: String(item._id), action: item.action, summary: item.summary || '', outcome: item.outcome || 'SUCCESS', actor: item.actorSnapshot?.name || 'System', createdAt: item.createdAt })),
    related: { draftProducts, activeCarts, activeOrders }, roles: MEMBER_ROLES,
  };
}

function valuesObject(product) {
  const source = product.attributeValues instanceof Map ? Object.fromEntries(product.attributeValues) : (product.attributeValues || {});
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value]));
}
function empty(value) { return value === undefined || value === null || String(value).trim() === '' || (Array.isArray(value) && !value.length); }
function validateAttribute(value, attribute) {
  if (empty(value)) return attribute.required ? 'missing' : '';
  const text = String(value).trim(); const validation = attribute.validation || {};
  if (['number', 'measurement', 'range'].includes(attribute.type)) {
    const number = Number(text); if (!Number.isFinite(number)) return 'invalid';
    if (validation.min != null && number < Number(validation.min)) return 'invalid';
    if (validation.max != null && number > Number(validation.max)) return 'invalid';
  }
  if (attribute.type === 'dropdown' && attribute.options?.length && !attribute.options.some((item) => String(item).toLowerCase() === text.toLowerCase())) return 'invalid';
  if (attribute.type === 'multi_select' && attribute.options?.length) {
    const choices = text.split(/[,|]/).map((item) => item.trim()).filter(Boolean);
    if (choices.some((choice) => !attribute.options.some((item) => String(item).toLowerCase() === choice.toLowerCase()))) return 'invalid';
  }
  if (attribute.type === 'boolean' && !['true', 'false', 'yes', 'no', '1', '0'].includes(text.toLowerCase())) return 'invalid';
  if (attribute.type === 'date' && !Number.isFinite(new Date(text).getTime())) return 'invalid';
  if (validation.minLength != null && text.length < Number(validation.minLength)) return 'invalid';
  if (validation.maxLength != null && text.length > Number(validation.maxLength)) return 'invalid';
  return '';
}
function attributesForProduct(target, product) {
  const map = new Map((target.attributes || []).map((item) => [item.key, item]));
  const definition = (target.categoryDefinitions || []).find((item) => item.key === product.categoryDefinitionKey);
  (definition?.attributes || []).forEach((item) => map.set(item.key, { ...(map.get(item.key) || {}), ...item }));
  return [...map.values()];
}
function productReasons(product, target) {
  const values = valuesObject(product); const attributes = attributesForProduct(target, product); const reasons = [];
  const missing = []; const invalid = [];
  attributes.forEach((attribute) => { const result = validateAttribute(values[attribute.key], attribute); if (result === 'missing') missing.push(attribute.label || attribute.key); if (result === 'invalid') invalid.push(attribute.label || attribute.key); });
  if (missing.length) reasons.push({ code: 'MISSING_REQUIRED', fields: missing });
  if (invalid.length) reasons.push({ code: 'INVALID_VALUE', fields: invalid });
  const targetKeys = new Set(attributes.map((item) => item.key));
  const legacy = [...new Set([...(product.specifications || []).map((item) => item.key), ...Object.keys(values)].filter((key) => key && !targetKeys.has(key)))];
  if (legacy.length) reasons.push({ code: 'LEGACY_ATTRIBUTE', fields: legacy });
  const definitions = new Set((target.categoryDefinitions || []).map((item) => item.key));
  if (product.categoryDefinitionKey && definitions.size && !definitions.has(product.categoryDefinitionKey)) reasons.push({ code: 'CATEGORY_MISMATCH', fields: [product.categoryDefinitionKey] });
  const requiredVariants = target.variantConfig?.enabled ? (target.variantConfig.attributes || []) : [];
  if (requiredVariants.length && Array.isArray(product.variants) && product.variants.length) {
    const incompatible = product.variants.some((variant) => variant.isActive !== false && requiredVariants.some((key) => {
      const options = variant.optionValues instanceof Map ? Object.fromEntries(variant.optionValues) : (variant.optionValues || {});
      return empty(options[key] ?? (key === 'size' ? variant.size : key === 'colour' || key === 'color' ? variant.color : undefined));
    }));
    if (incompatible) reasons.push({ code: 'VARIANT_MISMATCH', fields: requiredVariants });
  }
  return reasons;
}
async function industryImpact(store, target) {
  const products = await Product.find({ storeId: store._id, isArchived: { $ne: true } }).select('_id name sku updatedAt categoryDefinitionKey attributeValues specifications variants sizes sizingMode').lean();
  const affected = products.map((product) => ({ product, reasons: productReasons(product, target) })).filter((item) => item.reasons.length);
  const fingerprint = crypto.createHash('sha256').update(products.map((item) => `${item._id}:${new Date(item.updatedAt || 0).getTime()}`).sort().join('|')).digest('hex');
  const current = store.catalogStructure || {}; const currentKeys = new Set((current.attributes || []).map((item) => item.key)); const nextKeys = new Set((target.attributes || []).map((item) => item.key));
  const categoryNames = new Set((await Category.find({ storeId: store._id, isArchived: { $ne: true } }).select('name').lean()).map((item) => String(item.name).toLowerCase()));
  const [draftProducts, activeCarts, activeOrders] = await Promise.all([
    ProductDraft.countDocuments({ storeId: store._id, status: { $ne: 'archived' } }),
    Cart.countDocuments({ storeId: store._id, 'items.0': { $exists: true } }),
    Order.countDocuments({ storeId: store._id, orderStatus: ACTIVE_ORDER_STATUSES }),
  ]);
  const count = (code) => affected.filter((item) => item.reasons.some((entry) => entry.code === code)).length;
  return {
    addedCategories: (target.defaultCategories || []).filter((name) => !categoryNames.has(String(name).toLowerCase())),
    addedAttributes: (target.attributes || []).filter((item) => !currentKeys.has(item.key)).map((item) => item.label),
    inactiveAttributes: (current.attributes || []).filter((item) => !nextKeys.has(item.key)).map((item) => item.label),
    variantAttributes: target.variantConfig?.attributes || [], productSections: target.productSections || [],
    totalProducts: products.length, affectedProducts: affected.length, missingRequired: count('MISSING_REQUIRED'), invalidValues: count('INVALID_VALUE'),
    legacyAttributes: count('LEGACY_ATTRIBUTE'), incompatibleVariants: count('VARIANT_MISMATCH'), draftProducts, activeCarts, activeOrders, fingerprint,
    examples: affected.slice(0, 12).map(({ product, reasons }) => ({ id: String(product._id), name: product.name, sku: product.sku || '', reasons })),
    affected,
  };
}
function compactImpact(impact) { const { affected: _affected, ...safe } = impact; return safe; }
async function previewIndustry(store, target) {
  const impact = await industryImpact(store, target);
  const token = signPayload({ storeId: String(store._id), revision: Number(store.portfolioRevision || 0), from: store.industry, to: target.industry, fingerprint: impact.fingerprint, exp: Date.now() + 15 * 60 * 1000 });
  return { impact: compactImpact(impact), impactToken: token };
}
function assertImpact(store, target, token, impact) {
  const data = verifyPayload(token);
  if (data.storeId !== String(store._id) || data.revision !== Number(store.portfolioRevision || 0) || data.from !== store.industry || data.to !== target.industry || data.fingerprint !== impact.fingerprint) {
    throw new ApiError('DUPLICATE_REQUEST', 'The store catalog changed after this review. Preview the industry change again.');
  }
  return data;
}
async function affectedProducts(store, target, token, query = {}) {
  const impact = await industryImpact(store, target); assertImpact(store, target, token, impact);
  const { page, limit, skip } = readPagination(query, { defaultLimit: 50, maxLimit: 500 });
  const items = impact.affected.slice(skip, skip + limit).map(({ product, reasons }) => ({ id: String(product._id), name: product.name, sku: product.sku || '', reasons }));
  return { items, page, limit, total: impact.affected.length, pages: Math.max(1, Math.ceil(impact.affected.length / limit)), impact: compactImpact(impact) };
}
async function currentMigrationProducts(store, query = {}) {
  const target = store.catalogStructure || {};
  const impact = await industryImpact(store, target);
  const { page, limit, skip } = readPagination(query, { defaultLimit: 50, maxLimit: 500 });
  const items = impact.affected.slice(skip, skip + limit).map(({ product, reasons }) => ({ id: String(product._id), name: product.name, sku: product.sku || '', reasons }));
  return { items, page, limit, total: impact.affected.length, pages: Math.max(1, Math.ceil(impact.affected.length / limit)), impact: compactImpact(impact) };
}
function starterCategory(preset, store, name, index, revision) {
  const definition = (preset.categoryDefinitions || []).find((item) => item.name.toLowerCase() === String(name).toLowerCase());
  return { name, slug: `${store.slug}-${slugify(name)}-${revision}`, description: `Starter ${preset.name.toLowerCase()} category`, displayOrder: index, storeId: store._id, definitionKey: definition?.key || '', parentDefinitionKey: definition?.parentKey || '', attributeOverrides: definition?.attributes || [], variantAttributes: definition?.variantAttributes || [], configuredFilters: definition?.filters || [] };
}
async function convertIndustry({ store, target, impactToken, baseRevision, reviewNote, actor }) {
  const revision = assertRevision(store, baseRevision); const note = reason(reviewNote, 'industry conversion');
  const impact = await industryImpact(store, target); assertImpact(store, target, impactToken, impact);
  const previous = { industry: store.industry, catalogStructure: clone(store.catalogStructure || {}), industryConfigurations: clone(store.industryConfigurations || {}) };
  let createdIds = [];
  return runInTransaction(async (session) => {
    const current = await Store.findById(store._id).session(session || null);
    assertRevision(current, revision);
    const existing = await Category.find({ storeId: current._id, isArchived: { $ne: true } }).select('name').session(session || null).lean();
    const names = new Set(existing.map((item) => String(item.name).toLowerCase()));
    const missing = (target.defaultCategories || []).filter((name) => !names.has(String(name).toLowerCase()));
    try {
      if (missing.length) {
        const docs = missing.map((name, index) => starterCategory(target, current, name, existing.length + index, Number(current.industryRevision || 0) + 1));
        const created = session ? await Category.create(docs, { session, ordered: true }) : await Category.create(docs);
        createdIds = created.map((item) => item._id);
      }
      const configurations = previous.industryConfigurations || {};
      configurations[previous.industry] = previous.catalogStructure;
      current.industry = target.industry;
      current.catalogStructure = { ...clone(configurations[target.industry] || target), industry: target.industry, id: target.industry, name: target.name, clientPermissions: current.catalogStructure?.clientPermissions || { content: true, payments: true } };
      configurations[target.industry] = clone(current.catalogStructure);
      current.industryConfigurations = configurations; current.industryRevision = Number(current.industryRevision || 0) + 1;
      current.industryMigration = { status: impact.affectedProducts ? 'REVIEW_REQUIRED' : 'COMPLETED', fromIndustry: previous.industry, toIndustry: target.industry, ...compactImpact(impact), examples: undefined, fingerprint: undefined, reviewNote: note, rollbackSnapshot: previous, createdCategoryIds: createdIds, checkedAt: new Date(), switchedAt: new Date(), completedAt: impact.affectedProducts ? undefined : new Date() };
      current.markModified('catalogStructure'); current.markModified('industryConfigurations'); current.markModified('industryMigration');
      await saveRevision(current, revision, session);
      await StorePortfolioOperation.create([{ store: current._id, actor: actor._id, type: 'INDUSTRY_CONVERSION', reason: note, before: { industry: previous.industry, revision }, after: { industry: target.industry, revision: current.portfolioRevision, impact: compactImpact(impact) } }], { ordered: true, ...(session ? { session } : {}) });
      return { store: current, impact: compactImpact(impact) };
    } catch (error) {
      if (!session && createdIds.length) await Category.deleteMany({ _id: { $in: createdIds }, storeId: current._id }).catch(() => null);
      throw error;
    }
  });
}

async function grantAccess({ store, input, actor }) {
  const key = String(input.idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9:_-]{12,100}$/.test(key)) throw new ApiError('VALIDATION_ERROR', 'A valid access-operation key is required');
  const existing = await StorePortfolioOperation.findOne({ store: store._id, idempotencyKey: key });
  if (existing) return { store: await Store.findById(store._id).populate('owner', 'name phone email isBlocked lastLoginAt'), duplicate: true };
  const revision = assertRevision(store, input.baseRevision); const note = reason(input.reason, 'access grant');
  const cycle = normalizeBillingCycle(input.billingCycle, '');
  if (!['TRIAL', 'MONTHLY', 'YEARLY', 'LIFETIME'].includes(cycle)) throw new ApiError('VALIDATION_ERROR', 'Choose trial, monthly, yearly or lifetime access');
  const plan = String(input.plan || store.plan).toUpperCase(); if (!PLAN_IDS.includes(plan)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid store plan');
  try {
    return await runInTransaction(async (session) => {
      const current = await Store.findById(store._id).session(session || null); assertRevision(current, revision);
      const before = planSummary(current); const now = new Date(); let periodStart = now;
      if (!['TRIAL', 'LIFETIME'].includes(cycle) && before.status === 'ACTIVE' && before.endsAt && new Date(before.endsAt) > now && before.id === plan) periodStart = new Date(before.endsAt);
      const periodEnd = nextPeriodEnd(cycle, periodStart);
      current.plan = plan; current.license.status = cycle === 'TRIAL' ? 'TRIAL' : 'ACTIVE'; current.license.billingCycle = cycle; current.license.startsAt = now;
      current.license.endsAt = periodEnd || undefined; current.license.trialEndsAt = cycle === 'TRIAL' ? periodEnd : undefined;
      await saveRevision(current, revision, session);
      await StorePortfolioOperation.create([{ store: current._id, actor: actor._id, type: 'ACCESS_GRANT', idempotencyKey: key, reason: note, before, after: planSummary(current) }], { ordered: true, ...(session ? { session } : {}) });
      return { store: current, duplicate: false };
    });
  } catch (error) {
    if (error?.code === 11000) return { store: await Store.findById(store._id).populate('owner', 'name phone email isBlocked lastLoginAt'), duplicate: true };
    throw error;
  }
}
function knownFeatures() { return new Set(Object.values(STORE_PLANS).flatMap((plan) => plan.features)); }
function featureList(value, label) {
  if (!Array.isArray(value)) throw new ApiError('VALIDATION_ERROR', `${label} must be a list`);
  const known = knownFeatures(); const items = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]; const unknown = items.filter((item) => !known.has(item));
  if (unknown.length) throw new ApiError('VALIDATION_ERROR', `Unknown store feature: ${unknown[0]}`);
  return items;
}
function limitOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('VALIDATION_ERROR', 'Limit overrides must be an object');
  const output = {};
  for (const key of LIMIT_KEYS) { const raw = value[key]; if (raw === '' || raw == null) continue; const number = Number(raw); if (!Number.isInteger(number) || number < 0 || number > 10000000) throw new ApiError('VALIDATION_ERROR', `${key} limit must be a whole number from 0 to 10,000,000`); output[key] = number; }
  return output;
}
async function updateSubscription({ store, input, actor }) {
  const revision = assertRevision(store, input.baseRevision); const before = planSummary(store); const note = reason(input.reason, 'subscription change');
  if (input.plan !== undefined) { const plan = String(input.plan).toUpperCase(); if (!PLAN_IDS.includes(plan)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid store plan'); store.plan = plan; }
  if (input.licenseStatus !== undefined) { const status = String(input.licenseStatus).toUpperCase(); if (!LICENSE_STATUSES.includes(status)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid licence status'); store.license.status = status; }
  if (input.billingCycle !== undefined) { const cycle = String(input.billingCycle).toUpperCase(); if (!BILLING_CYCLES.includes(cycle)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid billing cycle'); store.license.billingCycle = cycle; }
  if (input.licenseEndsAt !== undefined) store.license.endsAt = endOfIndiaDate(input.licenseEndsAt) || undefined;
  if (store.license.billingCycle === 'LIFETIME') store.license.endsAt = undefined;
  if (store.license.status === 'ACTIVE' && store.license.billingCycle !== 'LIFETIME' && (!store.license.endsAt || store.license.endsAt <= new Date())) throw new ApiError('VALIDATION_ERROR', 'Active time-limited access needs a future expiry date');
  if (store.license.status === 'TRIAL') {
    store.license.billingCycle = 'TRIAL'; store.license.endsAt ||= nextPeriodEnd('TRIAL');
    if (store.license.endsAt <= new Date()) throw new ApiError('VALIDATION_ERROR', 'Trial access needs a future expiry date');
    store.license.trialEndsAt = store.license.endsAt;
  }
  if (input.renewalMessage !== undefined) store.license.renewalMessage = optionalString(input.renewalMessage, 'renewalMessage', { max: 300 });
  if (input.featureOverrides !== undefined) store.license.featureOverrides = featureList(input.featureOverrides, 'Feature overrides');
  if (input.disabledFeatures !== undefined) store.license.disabledFeatures = featureList(input.disabledFeatures, 'Disabled features');
  if (input.limitOverrides !== undefined) store.license.limitOverrides = limitOverrides(input.limitOverrides);
  await saveRevision(store, revision);
  await StorePortfolioOperation.create({ store: store._id, actor: actor._id, type: 'SUBSCRIPTION_UPDATE', reason: note, before, after: planSummary(store) });
  return store;
}
function normalizeDomain(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, '');
  if (!raw) return undefined;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw)) throw new ApiError('VALIDATION_ERROR', 'Enter a hostname such as shop.example.com');
  return raw;
}
async function updateProfile({ store, input }) {
  const revision = assertRevision(store, input.baseRevision);
  if (input.checkoutEnabled !== undefined) throw new ApiError('VALIDATION_ERROR', 'Use the reason-protected lifecycle action to change checkout availability');
  if (input.name !== undefined) store.name = requireString(input.name, 'name', { min: 2, max: 80 });
  if (input.slug !== undefined) {
    const slug = slugify(requireString(input.slug, 'slug', { min: 2, max: 80 }));
    if (await Store.exists({ _id: { $ne: store._id }, slug })) throw new ApiError('DUPLICATE_REQUEST', 'This storefront URL is already in use');
    store.slug = slug;
  }
  if (input.legalName !== undefined) store.legalName = optionalString(input.legalName, 'legalName', { max: 120 });
  if (input.logo !== undefined) store.logo = optionalString(input.logo, 'logo', { max: 500 });
  if (input.supportEmail !== undefined) store.supportEmail = optionalEmail(input.supportEmail, 'supportEmail');
  if (input.supportPhone !== undefined) store.supportPhone = optionalIndianMobile(input.supportPhone, 'supportPhone');
  if (input.whatsappNumber !== undefined) store.whatsappNumber = optionalIndianMobile(input.whatsappNumber, 'whatsappNumber');
  if (input.customDomain !== undefined) store.customDomain = normalizeDomain(input.customDomain);
  for (const field of ['pickupAddress', 'returnAddress']) {
    if (input[field] === undefined) continue;
    const value = input[field] && typeof input[field] === 'object' ? input[field] : {};
    const pincode = String(value.pincode || '').replace(/\D/g, '');
    store[field] = {
      fullName: optionalString(value.fullName, `${field}.fullName`, { max: 80 }), mobile: optionalIndianMobile(value.mobile, `${field}.mobile`) || undefined,
      pincode: pincode ? requirePincode(pincode, `${field}.pincode`) : undefined, state: optionalString(value.state, `${field}.state`, { max: 80 }), city: optionalString(value.city, `${field}.city`, { max: 80 }),
      houseNo: optionalString(value.houseNo, `${field}.houseNo`, { max: 80 }), area: optionalString(value.area, `${field}.area`, { max: 120 }), landmark: optionalString(value.landmark, `${field}.landmark`, { max: 120 }),
    };
  }
  if (input.paymentReady !== undefined) store.paymentReady = input.paymentReady === true;
  if (input.shippingReady !== undefined) store.shippingReady = input.shippingReady === true;
  await saveRevision(store, revision); return store;
}
async function updateLifecycle({ store, input, actor }) {
  const revision = assertRevision(store, input.baseRevision); const action = String(input.action || '').toUpperCase();
  if (!['PAUSE', 'RESUME', 'ARCHIVE', 'RESTORE', 'DISABLE_CHECKOUT', 'ENABLE_CHECKOUT'].includes(action)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid store lifecycle action');
  if (store.isDefault && ['PAUSE', 'ARCHIVE'].includes(action)) throw new ApiError('FORBIDDEN', 'The default store cannot be paused or archived');
  const needsReason = ['PAUSE', 'ARCHIVE', 'DISABLE_CHECKOUT'].includes(action); const note = needsReason ? reason(input.reason, 'store action') : String(input.reason || action).trim();
  const before = { status: store.status, archivedAt: store.archivedAt, checkoutEnabled: store.checkoutEnabled !== false };
  if (action === 'PAUSE') store.status = 'SUSPENDED';
  if (action === 'RESUME') store.status = store.publishedAt ? 'PUBLISHED' : 'ONBOARDING';
  if (action === 'ARCHIVE') { store.archivedAt = new Date(); store.archivedBy = actor._id; store.status = 'SUSPENDED'; store.checkoutEnabled = false; }
  if (action === 'RESTORE') { store.archivedAt = null; store.archivedBy = undefined; store.status = 'ONBOARDING'; }
  if (action === 'DISABLE_CHECKOUT') store.checkoutEnabled = false;
  if (action === 'ENABLE_CHECKOUT') store.checkoutEnabled = true;
  store.statusReason = note;
  await saveRevision(store, revision);
  await StorePortfolioOperation.create({ store: store._id, actor: actor._id, type: 'LIFECYCLE_UPDATE', reason: note || action, before, after: { status: store.status, archivedAt: store.archivedAt, checkoutEnabled: store.checkoutEnabled !== false } });
  return store;
}
async function createMember({ store, input, actor }) {
  const revision = assertRevision(store, input.baseRevision); const note = optionalString(input.reason, 'reason', { max: 500 }) || 'Team access added by platform owner'; const phone = normalizePhone(input.phone); if (!phone) throw new ApiError('VALIDATION_ERROR', 'Enter a valid 10-digit team member number');
  const role = String(input.role || '').toUpperCase(); if (!MEMBER_ROLES.includes(role)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid team role');
  const status = input.status === 'INVITED' ? 'INVITED' : 'ACTIVE';
  return runInTransaction(async (session) => {
    const current = await Store.findById(store._id).session(session || null); assertRevision(current, revision);
    if (!session) await saveRevision(current, revision);
    let user = await User.findOne({ phone }).session(session || null);
    if (user?.isBlocked) throw new ApiError('FORBIDDEN', 'Unblock this account before adding it to a store');
    if (!user) [user] = await User.create([{ name: requireString(input.name, 'name', { min: 2, max: 80 }), phone, role: 'customer', isPhoneVerified: false, availableModes: ['customer', 'seller'], activeMode: 'customer' }], { ordered: true, ...(session ? { session } : {}) });
    const existing = await StoreMember.findOne({ store: current._id, user: user._id }).session(session || null);
    if (existing?.role === 'OWNER') throw new ApiError('VALIDATION_ERROR', 'Use ownership transfer for the current owner');
    const member = existing || new StoreMember({ store: current._id, user: user._id }); member.role = role; member.status = status; member.statusReason = note; member.invitedBy = actor._id; member.invitedAt ||= new Date(); if (status === 'ACTIVE') member.activatedAt = new Date();
    await member.save({ ...(session ? { session } : {}) });
    await User.updateOne({ _id: user._id }, { $addToSet: { availableModes: { $each: ['customer', 'seller'] } } }, { ...(session ? { session } : {}) });
    if (session) await saveRevision(current, revision, session);
    await StorePortfolioOperation.create([{ store: current._id, actor: actor._id, type: 'MEMBER_UPDATE', reason: note, after: { member: member._id, user: user._id, role, status } }], { ordered: true, ...(session ? { session } : {}) });
    return member.populate('user', 'name phone email isBlocked lastLoginAt');
  });
}
async function updateMember({ store, memberId, input, actor }) {
  const revision = assertRevision(store, input.baseRevision); const requestedStatus = input.status === undefined ? '' : String(input.status).toUpperCase();
  const note = requestedStatus === 'REVOKED' ? reason(input.reason, 'access revocation') : (optionalString(input.reason, 'reason', { max: 500 }) || 'Team access updated by platform owner');
  const id = requireId(memberId, 'team member');
  return runInTransaction(async (session) => {
    const current = await Store.findById(store._id).session(session || null); assertRevision(current, revision);
    if (!session) await saveRevision(current, revision);
    const member = await StoreMember.findOne({ _id: id, store: current._id }).populate('user', 'name phone email isBlocked lastLoginAt').session(session || null);
    if (!member) throw new ApiError('NOT_FOUND', 'Team member not found'); if (member.role === 'OWNER') throw new ApiError('VALIDATION_ERROR', 'Transfer ownership before changing the owner membership');
    const before = { role: member.role, status: member.status };
    if (input.role !== undefined) { const role = String(input.role).toUpperCase(); if (!MEMBER_ROLES.includes(role)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid team role'); member.role = role; }
    if (input.status !== undefined) { const status = String(input.status).toUpperCase(); if (!['ACTIVE', 'INVITED', 'REVOKED'].includes(status)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid member status'); member.status = status; member.statusReason = note; if (status === 'ACTIVE') { member.activatedAt = new Date(); member.revokedAt = undefined; member.revokedBy = undefined; } if (status === 'REVOKED') { member.revokedAt = new Date(); member.revokedBy = actor._id; } }
    await member.save({ ...(session ? { session } : {}) }); if (session) await saveRevision(current, revision, session);
    await StorePortfolioOperation.create([{ store: current._id, actor: actor._id, type: 'MEMBER_UPDATE', reason: note, before, after: { role: member.role, status: member.status, member: member._id } }], { ordered: true, ...(session ? { session } : {}) });
    return member;
  });
}
async function transferOwner({ store, input, actor }) {
  const revision = assertRevision(store, input.baseRevision); const note = reason(input.reason, 'ownership transfer'); const phone = normalizePhone(input.phone); if (!phone) throw new ApiError('VALIDATION_ERROR', 'Enter the new owner mobile number');
  const user = await User.findOne({ phone }); if (!user) throw new ApiError('NOT_FOUND', 'Add this person as a team member before transferring ownership'); if (user.isBlocked) throw new ApiError('FORBIDDEN', 'Unblock the new owner account first'); if (String(user._id) === String(store.owner)) throw new ApiError('DUPLICATE_REQUEST', 'This person already owns the store');
  const target = await StoreMember.findOne({ store: store._id, user: user._id }); if (!target || target.status !== 'ACTIVE') throw new ApiError('VALIDATION_ERROR', 'The new owner must be an active team member');
  const previousOwner = store.owner;
  await runInTransaction(async (session) => {
    target.role = 'OWNER'; target.status = 'ACTIVE'; await target.save({ ...(session ? { session } : {}) });
    if (previousOwner) await StoreMember.updateOne({ store: store._id, user: previousOwner }, { $set: { role: 'MANAGER', status: 'ACTIVE', statusReason: `Ownership transferred: ${note}` } }, { ...(session ? { session } : {}) });
    store.owner = user._id; await saveRevision(store, revision, session);
    await StorePortfolioOperation.create([{ store: store._id, actor: actor._id, type: 'OWNER_TRANSFER', reason: note, before: { owner: previousOwner }, after: { owner: user._id } }], { ordered: true, ...(session ? { session } : {}) });
  });
  return store.populate('owner', 'name phone email isBlocked lastLoginAt');
}
async function completeMigration({ store, input, target }) {
  const revision = assertRevision(store, input.baseRevision); const note = reason(input.note, 'migration completion'); const impact = await industryImpact(store, target);
  if (impact.affectedProducts) throw new ApiError('VALIDATION_ERROR', `${impact.affectedProducts} products still need review before this migration can be completed`, { details: { impact: compactImpact(impact) } });
  store.industryMigration.status = 'COMPLETED'; store.industryMigration.completedAt = new Date(); store.industryMigration.checkedAt = new Date(); store.industryMigration.reviewNote = note; store.industryMigration.failureMessage = '';
  store.markModified('industryMigration'); await saveRevision(store, revision); return { store, impact: compactImpact(impact) };
}
async function updateMigrationReview({ store, input }) {
  const revision = assertRevision(store, input.baseRevision);
  if (input.reviewAssignedTo !== undefined) {
    if (!input.reviewAssignedTo) store.industryMigration.reviewAssignedTo = undefined;
    else {
      requireId(input.reviewAssignedTo, 'reviewer');
      const member = await StoreMember.findOne({ store: store._id, user: input.reviewAssignedTo, status: 'ACTIVE' });
      if (!member) throw new ApiError('VALIDATION_ERROR', 'Assign an active member of this store');
      store.industryMigration.reviewAssignedTo = input.reviewAssignedTo;
    }
  }
  if (input.note !== undefined) store.industryMigration.reviewNote = optionalString(input.note, 'note', { max: 500 });
  store.industryMigration.checkedAt = new Date(); store.markModified('industryMigration'); await saveRevision(store, revision); return store;
}
async function rollbackIndustry({ store, input, actor }) {
  const revision = assertRevision(store, input.baseRevision); const note = reason(input.reason, 'industry rollback'); const snapshot = store.industryMigration?.rollbackSnapshot;
  if (!snapshot?.industry || !snapshot?.catalogStructure) throw new ApiError('VALIDATION_ERROR', 'No industry rollback snapshot is available');
  const before = { industry: store.industry, revision };
  await runInTransaction(async (session) => {
    const created = store.industryMigration?.createdCategoryIds || [];
    if (created.length) await Category.updateMany({ _id: { $in: created }, storeId: store._id }, { $set: { isActive: false, isArchived: true, archivedAt: new Date() } }, { ...(session ? { session } : {}) });
    store.industry = snapshot.industry; store.catalogStructure = clone(snapshot.catalogStructure); store.industryConfigurations = clone(snapshot.industryConfigurations || {}); store.industryRevision = Number(store.industryRevision || 0) + 1;
    store.industryMigration.status = 'ROLLED_BACK'; store.industryMigration.rolledBackAt = new Date(); store.industryMigration.reviewNote = note; store.markModified('catalogStructure'); store.markModified('industryConfigurations'); store.markModified('industryMigration');
    await saveRevision(store, revision, session);
    await StorePortfolioOperation.create([{ store: store._id, actor: actor._id, type: 'INDUSTRY_ROLLBACK', reason: note, before, after: { industry: store.industry, revision: store.portfolioRevision } }], { ordered: true, ...(session ? { session } : {}) });
  });
  return store;
}

module.exports = {
  MEMBER_ROLES, MIGRATION_STATUSES, STORE_STATUSES, affectedProducts, completeMigration, convertIndustry, createMember, currentMigrationProducts, grantAccess,
  industryImpact, listStores, previewIndustry, rollbackIndustry, storeOperations, storeView, transferOwner, updateLifecycle, updateMember, updateMigrationReview, updateProfile, updateSubscription,
};
