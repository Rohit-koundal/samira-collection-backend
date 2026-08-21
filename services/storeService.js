const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const User = require('../models/User');
const slugify = require('../utils/slugify');
const { ApiError } = require('../utils/apiError');

const DEFAULT_STORE_SLUG = 'samira-collection';
const DEFAULT_STORE_NAME = 'Samira Collection';

function defaultStoreFilter(storeId) {
  return {
    $or: [
      { storeId },
      { storeId: null },
      { storeId: { $exists: false } },
    ],
  };
}

function andFilter(query, extra) {
  if (!extra || !Object.keys(extra).length) return query;
  if (!query || !Object.keys(query).length) return extra;
  return { $and: [query, extra] };
}

function publicCatalogFilter(req) {
  return req.tenantFilter || {};
}

function isPlatformAdmin(user) {
  return user?.role === 'admin' && user?.activeMode === 'admin';
}

async function ensureDefaultStore() {
  let store = await Store.findOne({ isDefault: true });
  if (store) return store;
  store = await Store.findOne({ slug: DEFAULT_STORE_SLUG });
  if (store) {
    if (!store.isDefault) {
      store.isDefault = true;
      store.status = store.status === 'SUSPENDED' ? store.status : 'PUBLISHED';
      await store.save();
    }
    return store;
  }
  return Store.create({
    name: DEFAULT_STORE_NAME,
    slug: DEFAULT_STORE_SLUG,
    legalName: DEFAULT_STORE_NAME,
    status: 'PUBLISHED',
    isDefault: true,
    paymentReady: true,
    shippingReady: true,
    publishedAt: new Date(),
  });
}

const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'admin', 'app', 'mail', 'seller', 'static', 'cdn', 'health']);

function normalizeHost(hostHeader = '') {
  return String(hostHeader || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}

function identifyHost(hostHeader = '') {
  const host = normalizeHost(hostHeader);
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return null;
  const root = String(process.env.PLATFORM_ROOT_DOMAIN || '').trim().toLowerCase().replace(/^www\./, '');
  if (root && (host === root || host === `www.${root}`)) return null;
  if (root && host.endsWith(`.${root}`)) {
    const sub = host.slice(0, -(root.length + 1));
    if (sub && !sub.includes('.') && !RESERVED_SUBDOMAINS.has(sub)) return { slug: sub };
    return null;
  }
  return { customDomain: host };
}

function packStore(store, { isDefaultStore } = {}) {
  const defaultStore = isDefaultStore ?? Boolean(store?.isDefault);
  return {
    store,
    isDefaultStore: defaultStore,
    tenantFilter: defaultStore ? defaultStoreFilter(store._id) : { storeId: store._id },
  };
}

async function resolveStoreFromHost(hostHeader = '') {
  const identified = identifyHost(hostHeader);
  if (!identified) return resolvePublicStore('');
  if (identified.customDomain) {
    const store = await Store.findOne({ customDomain: identified.customDomain, status: 'PUBLISHED' });
    if (store) return packStore(store);
    return resolvePublicStore('');
  }
  if (identified.slug) {
    try {
      return await resolvePublicStore(identified.slug);
    } catch {
      return resolvePublicStore('');
    }
  }
  return resolvePublicStore('');
}

async function resolvePublicStore(slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) {
    const store = await ensureDefaultStore();
    return { store, isDefaultStore: true, tenantFilter: defaultStoreFilter(store._id) };
  }
  const store = await Store.findOne({ slug: normalized, status: { $in: ['PUBLISHED', 'ONBOARDING'] } });
  if (!store) throw new ApiError('NOT_FOUND', 'Store not found');
  if (store.status !== 'PUBLISHED' && !store.isDefault) {
    throw new ApiError('NOT_FOUND', 'This store is not published yet');
  }
  const isDefaultStore = Boolean(store.isDefault);
  return {
    store,
    isDefaultStore,
    tenantFilter: isDefaultStore ? defaultStoreFilter(store._id) : { storeId: store._id },
  };
}

async function uniqueSlug(base, excludeId) {
  const root = slugify(base || 'store') || 'store';
  let slug = root;
  let n = 1;
  while (await Store.findOne({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).select('_id')) {
    n += 1;
    slug = `${root}-${n}`;
  }
  return slug;
}

async function grantSellerMode(userId) {
  const user = await User.findById(userId);
  if (!user) return;
  const modes = new Set(user.availableModes || ['customer']);
  modes.add('customer');
  modes.add('seller');
  if (user.role === 'admin') modes.add('admin');
  user.availableModes = [...modes];
  await user.save();
}

async function listMemberships(userId) {
  return StoreMember.find({ user: userId, status: 'ACTIVE' }).populate('store').sort('-createdAt');
}

function onboardingProgress(store, { productCount = 0 } = {}) {
  const steps = {
    name: Boolean(String(store?.name || '').trim()),
    slug: Boolean(String(store?.slug || '').trim()),
    logo: Boolean(store?.logo),
    instagram: Boolean(store?.instagramHandle || store?.instagramUrl),
    whatsapp: Boolean(store?.whatsappNumber),
    pickupAddress: Boolean(store?.pickupAddress?.pincode && store?.pickupAddress?.city),
    returnAddress: Boolean(store?.returnAddress?.pincode && store?.returnAddress?.city),
    payments: Boolean(store?.paymentReady),
    shipping: Boolean(store?.shippingReady),
    firstProduct: Number(productCount) > 0,
    published: store?.status === 'PUBLISHED',
  };
  const keys = Object.keys(steps);
  const completed = keys.filter((key) => steps[key]).length;
  return {
    steps,
    completed,
    total: keys.length,
    percent: Math.round((completed / keys.length) * 100),
  };
}

function publicStoreView(store, extra = {}) {
  if (!store) return null;
  const data = typeof store.toObject === 'function' ? store.toObject() : { ...store };
  return {
    id: String(data._id),
    name: data.name,
    slug: data.slug,
    logo: data.logo,
    coverImage: data.coverImage,
    bio: data.bio,
    instagramHandle: data.instagramHandle,
    instagramUrl: data.instagramUrl,
    whatsappNumber: data.whatsappNumber,
    customDomain: data.customDomain || '',
    status: data.status,
    isDefault: Boolean(data.isDefault),
    ...extra,
  };
}

module.exports = {
  DEFAULT_STORE_NAME,
  DEFAULT_STORE_SLUG,
  RESERVED_SUBDOMAINS,
  andFilter,
  defaultStoreFilter,
  ensureDefaultStore,
  grantSellerMode,
  identifyHost,
  isPlatformAdmin,
  listMemberships,
  onboardingProgress,
  publicCatalogFilter,
  publicStoreView,
  resolvePublicStore,
  resolveStoreFromHost,
  uniqueSlug,
};
