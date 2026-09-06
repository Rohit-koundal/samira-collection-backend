const { assertMasterOwner } = require('../config/masterOwner');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, forbidden } = require('../utils/apiError');
const { optionalEmail, optionalIndianMobile, optionalString, requirePincode, requireString } = require('../utils/validators');
const {
  ensureDefaultStore,
  grantSellerMode,
  listMemberships,
  onboardingProgress,
  publicStoreView,
  resolveStoreFromHost,
  uniqueSlug,
} = require('../services/storeService');
const { logAudit } = require('../services/auditService');

function readAddress(value) {
  if (!value || typeof value !== 'object') return undefined;
  const pincode = String(value.pincode || '').replace(/\D/g, '');
  if (pincode && !/^\d{6}$/.test(pincode)) requirePincode(pincode);
  return {
    fullName: optionalString(value.fullName, 'fullName', { max: 80 }),
    mobile: optionalIndianMobile(value.mobile || value.phone, 'mobile') || undefined,
    pincode: pincode || undefined,
    state: optionalString(value.state, 'state', { max: 80 }),
    city: optionalString(value.city, 'city', { max: 80 }),
    houseNo: optionalString(value.houseNo || value.houseNumber, 'houseNo', { max: 80 }),
    area: optionalString(value.area, 'area', { max: 120 }),
    landmark: optionalString(value.landmark, 'landmark', { max: 120 }),
  };
}

exports.listMine = asyncHandler(async (req, res) => {
  const memberships = await listMemberships(req.user._id);
  res.json(memberships.map((item) => ({
    id: String(item._id),
    role: item.role,
    status: item.status,
    store: publicStoreView(item.store),
  })));
});

exports.createStore = asyncHandler(async (req, res) => {
  assertMasterOwner(req.user);
  const name = requireString(req.body?.name, 'name', { min: 2, max: 80 });
  const slug = await uniqueSlug(req.body?.slug || name);
  const store = await Store.create({
    name,
    slug,
    legalName: optionalString(req.body?.legalName, 'legalName', { max: 120 }) || name,
    logo: optionalString(req.body?.logo, 'logo', { max: 500 }) || undefined,
    bio: optionalString(req.body?.bio, 'bio', { max: 1000 }) || undefined,
    instagramHandle: optionalString(req.body?.instagramHandle, 'instagramHandle', { max: 80 }) || undefined,
    instagramUrl: optionalString(req.body?.instagramUrl, 'instagramUrl', { max: 300 }) || undefined,
    whatsappNumber: optionalIndianMobile(req.body?.whatsappNumber, 'whatsappNumber') || undefined,
    supportEmail: optionalEmail(req.body?.supportEmail, 'supportEmail') || undefined,
    supportPhone: optionalIndianMobile(req.body?.supportPhone, 'supportPhone') || undefined,
    pickupAddress: readAddress(req.body?.pickupAddress),
    returnAddress: readAddress(req.body?.returnAddress),
    paymentReady: Boolean(req.body?.paymentReady),
    shippingReady: Boolean(req.body?.shippingReady),
    customDomain: req.body?.customDomain ? parseCustomDomain(req.body.customDomain) : undefined,
    status: 'ONBOARDING',
    owner: req.user._id,
  });
  await StoreMember.create({ store: store._id, user: req.user._id, role: 'OWNER', status: 'ACTIVE' });
  await grantSellerMode(req.user._id);
  await Category.create({
    name: 'General',
    slug: `${slug}-general`,
    description: 'Starter category for this boutique',
    storeId: store._id,
  }).catch(() => null);
  logAudit({ req, action: 'STORE_CREATE', entityType: 'Store', entityId: store._id, after: { name, slug }, storeId: store._id });
  res.status(201).json(await serializeOnboarding(store));
});

exports.getMine = asyncHandler(async (req, res) => {
  res.json(await serializeOnboarding(req.store, req.storeMember));
});

exports.updateMine = asyncHandler(async (req, res) => {
  const store = req.store;
  if (req.body?.name !== undefined) store.name = requireString(req.body.name, 'name', { min: 2, max: 80 });
  if (req.body?.slug !== undefined) store.slug = await uniqueSlug(req.body.slug, store._id);
  if (req.body?.legalName !== undefined) store.legalName = optionalString(req.body.legalName, 'legalName', { max: 120 });
  if (req.body?.logo !== undefined) store.logo = optionalString(req.body.logo, 'logo', { max: 500 });
  if (req.body?.coverImage !== undefined) store.coverImage = optionalString(req.body.coverImage, 'coverImage', { max: 500 });
  if (req.body?.bio !== undefined) store.bio = optionalString(req.body.bio, 'bio', { max: 1000 });
  if (req.body?.instagramHandle !== undefined) store.instagramHandle = optionalString(req.body.instagramHandle, 'instagramHandle', { max: 80 });
  if (req.body?.instagramUrl !== undefined) store.instagramUrl = optionalString(req.body.instagramUrl, 'instagramUrl', { max: 300 });
  if (req.body?.whatsappNumber !== undefined) store.whatsappNumber = optionalIndianMobile(req.body.whatsappNumber, 'whatsappNumber');
  if (req.body?.supportEmail !== undefined) store.supportEmail = optionalEmail(req.body.supportEmail, 'supportEmail');
  if (req.body?.supportPhone !== undefined) store.supportPhone = optionalIndianMobile(req.body.supportPhone, 'supportPhone');
  if (req.body?.pickupAddress !== undefined) store.pickupAddress = readAddress(req.body.pickupAddress);
  if (req.body?.returnAddress !== undefined) store.returnAddress = readAddress(req.body.returnAddress);
  if (req.body?.paymentReady !== undefined) store.paymentReady = Boolean(req.body.paymentReady);
  if (req.body?.shippingReady !== undefined) store.shippingReady = Boolean(req.body.shippingReady);
  if (req.body?.customDomain !== undefined) store.customDomain = parseCustomDomain(req.body.customDomain);
  await store.save();
  logAudit({ req, action: 'STORE_UPDATE', entityType: 'Store', entityId: store._id, storeId: store._id });
  res.json(await serializeOnboarding(store, req.storeMember));
});

exports.publishMine = asyncHandler(async (req, res) => {
  const store = req.store;
  if (req.storeMember.role !== 'OWNER' && req.storeMember.role !== 'MANAGER') {
    throw forbidden('Only the store owner or manager can publish');
  }
  const productCount = await Product.countDocuments({ storeId: store._id, isActive: true, isArchived: { $ne: true } });
  const progress = onboardingProgress(store, { productCount });
  if (!progress.steps.name || !progress.steps.slug) {
    throw new ApiError('VALIDATION_ERROR', 'Add a store name and URL slug before publishing');
  }
  store.status = 'PUBLISHED';
  store.publishedAt = store.publishedAt || new Date();
  await store.save();
  logAudit({ req, action: 'STORE_PUBLISH', entityType: 'Store', entityId: store._id, storeId: store._id });
  res.json(await serializeOnboarding(store, req.storeMember));
});

exports.resolveHost = asyncHandler(async (req, res) => {
  const host = String(req.query.host || req.headers['x-forwarded-host'] || req.headers.host || '');
  const resolved = await resolveStoreFromHost(host);
  res.json({
    ...publicStoreView(resolved.store),
    isDefault: resolved.isDefaultStore,
    resolvedFrom: host,
  });
});

exports.getPublic = asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const store = slug
    ? await Store.findOne({ slug, status: 'PUBLISHED' })
    : await ensureDefaultStore();
  if (!store || (store.status !== 'PUBLISHED' && !store.isDefault)) {
    throw new ApiError('NOT_FOUND', 'Store not found');
  }
  res.json(publicStoreView(store));
});

function parseCustomDomain(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, '');
  if (!raw) return undefined;
  if (raw === 'localhost' || raw === '127.0.0.1' || raw.includes(' ')) {
    throw new ApiError('VALIDATION_ERROR', 'Enter a real hostname such as shop.example.com. DNS is not configured automatically.');
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw)) {
    throw new ApiError('VALIDATION_ERROR', 'Enter a hostname such as shop.example.com. Point a CNAME yourself; this app does not change DNS.');
  }
  return raw;
}

async function serializeOnboarding(store, membership) {
  const productCount = await Product.countDocuments({ storeId: store._id, isArchived: { $ne: true } });
  return {
    store: {
      ...publicStoreView(store),
      legalName: store.legalName,
      pickupAddress: store.pickupAddress,
      returnAddress: store.returnAddress,
      paymentReady: store.paymentReady,
      shippingReady: store.shippingReady,
      supportEmail: store.supportEmail,
      supportPhone: store.supportPhone,
      publishedAt: store.publishedAt,
    },
    role: membership?.role,
    progress: onboardingProgress(store, { productCount }),
  };
}
