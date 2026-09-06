const slugify = require('../utils/slugify');
const VariantGroup = require('../models/VariantGroup');
const Product = require('../models/Product');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { requireObjectId } = require('../utils/validators');

const isAdminRequest = req => String(req.baseUrl || '').startsWith('/api/admin/');
function populateGroup(query, req) {
  const match = isAdminRequest(req) ? {} : { isActive: true, isArchived: { $ne: true } };
  return query.populate({ path: 'baseProduct', match }).populate({ path: 'products', match });
}

exports.listGroups = asyncHandler(async (req, res) => {
  const groups = await populateGroup(VariantGroup.find(isAdminRequest(req) ? {} : { isActive: true }), req).sort('-updatedAt');
  res.json({ success: true, data: groups.map(formatGroup) });
});

exports.getGroup = asyncHandler(async (req, res) => {
  const group = await populateGroup(VariantGroup.findOne({ _id: requireObjectId(req.params.id), ...(isAdminRequest(req) ? {} : { isActive: true }) }), req);
  if (!group) return res.status(404).json({ success: false, message: 'Variant group not found' });
  res.json({ success: true, data: formatGroup(group) });
});

exports.createGroup = asyncHandler(async (req, res) => {
  const payload = normalizeGroupPayload(req.body);
  if (!payload.name) return res.status(400).json({ success: false, message: 'Group name is required' });
  await validateProducts(payload.productIds || []);
  const group = await VariantGroup.create({
    ...payload,
    slug: await ensureUniqueSlug(payload.slug || payload.name),
    createdBy: req.user?._id,
  });
  await attachProducts(group, payload.productIds || []);
  await group.populate(['baseProduct', 'products']);
  res.status(201).json({ success: true, message: 'Variant group created successfully', data: formatGroup(group) });
});

exports.updateGroup = asyncHandler(async (req, res) => {
  const group = await VariantGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ success: false, message: 'Variant group not found' });
  const payload = normalizeGroupPayload(req.body);
  if (Array.isArray(payload.productIds)) await validateProducts(payload.productIds);
  if (payload.name) group.name = payload.name;
  if (payload.slug || payload.name) group.slug = await ensureUniqueSlug(payload.slug || payload.name, group._id);
  if (payload.baseProduct !== undefined) group.baseProduct = payload.baseProduct || undefined;
  if (payload.colors) group.colors = payload.colors;
  if (payload.sizes) group.sizes = payload.sizes;
  if (payload.isActive !== undefined) group.isActive = Boolean(payload.isActive);
  await group.save();
  if (Array.isArray(payload.productIds)) await syncGroupProducts(group, payload.productIds);
  await group.populate(['baseProduct', 'products']);
  res.json({ success: true, message: 'Variant group updated successfully', data: formatGroup(group) });
});

exports.deleteGroup = asyncHandler(async (req, res) => {
  const group = await VariantGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ success: false, message: 'Variant group not found' });
  await Product.updateMany({ variantGroupId: group._id }, { $unset: { variantGroupId: 1, variantName: 1, variantColor: 1, variantSize: 1 } });
  await VariantGroup.findByIdAndDelete(group._id);
  res.json({ success: true, message: 'Variant group deleted successfully' });
});

exports.addProducts = asyncHandler(async (req, res) => {
  const group = await VariantGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ success: false, message: 'Variant group not found' });
  const productIds = ensureArray(req.body.productIds);
  await attachProducts(group, productIds);
  await group.populate(['baseProduct', 'products']);
  res.json({ success: true, message: 'Products added to group', data: formatGroup(group) });
});

exports.removeProducts = asyncHandler(async (req, res) => {
  const group = await VariantGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ success: false, message: 'Variant group not found' });
  const productIds = ensureArray(req.body.productIds);
  group.products = group.products.filter((id) => !productIds.some((item) => String(item) === String(id)));
  await group.save();
  await Product.updateMany({ _id: { $in: productIds }, variantGroupId: group._id }, { $unset: { variantGroupId: 1, variantName: 1, variantColor: 1, variantSize: 1 } });
  await group.populate(['baseProduct', 'products']);
  res.json({ success: true, message: 'Products removed from group', data: formatGroup(group) });
});

exports.getGroupByIdPublic = exports.getGroup;

function normalizeGroupPayload(body = {}) {
  return {
    name: String(body.name || '').trim(),
    slug: String(body.slug || '').trim(),
    baseProduct: body.baseProduct || undefined,
    productIds: body.productIds === undefined ? undefined : ensureArray(body.productIds),
    colors: body.colors === undefined ? undefined : splitList(body.colors),
    sizes: body.sizes === undefined ? undefined : splitList(body.sizes),
    isActive: body.isActive !== undefined ? Boolean(body.isActive) : undefined,
  };
}

function ensureArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch {
      return String(value).split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function splitList(value) {
  return ensureArray(value);
}

async function attachProducts(group, productIds = []) {
  if (!productIds.length) return;
  const products = await validateProducts(productIds);
  await VariantGroup.updateMany({ _id: { $ne: group._id }, products: { $in: productIds } }, { $pull: { products: { $in: productIds } } });
  for (const product of products) {
    product.variantGroupId = group._id;
    product.variantName = group.name;
    if (!group.colors.length && product.colors?.length) group.colors = Array.from(new Set([...group.colors, ...product.colors]));
    if (!group.sizes.length && product.sizes?.length) group.sizes = Array.from(new Set([...group.sizes, ...product.sizes]));
    await product.save();
  }
  group.products = Array.from(new Set([...(group.products || []).map(String), ...productIds.map(String)]));
  await group.save();
}

async function validateProducts(productIds) {
  const ids = [...new Set(productIds.map(id => requireObjectId(id, 'product id')))];
  const products = await Product.find({ _id: { $in: ids } });
  if (products.length !== ids.length) throw new ApiError('VALIDATION_ERROR', 'One or more selected products are no longer available');
  return products;
}

async function syncGroupProducts(group, productIds = []) {
  const existingIds = (group.products || []).map(String);
  const nextIds = productIds.map(String);
  const removeIds = existingIds.filter((id) => !nextIds.includes(id));
  const addIds = nextIds.filter((id) => !existingIds.includes(id));
  if (removeIds.length) {
    await Product.updateMany({ _id: { $in: removeIds }, variantGroupId: group._id }, { $unset: { variantGroupId: 1, variantName: 1, variantColor: 1, variantSize: 1 } });
  }
  if (addIds.length) {
    await attachProducts(group, addIds);
  }
  group.products = nextIds;
  await group.save();
}

async function ensureUniqueSlug(base, id) {
  const cleanBase = slugify(base || `variant-${id}`);
  let candidate = cleanBase;
  let suffix = 1;
  while (await VariantGroup.exists({ slug: candidate, _id: { $ne: id } })) {
    suffix += 1;
    candidate = `${cleanBase}-${suffix}`;
  }
  return candidate;
}

function formatGroup(group) {
  const data = typeof group.toObject === 'function' ? group.toObject() : { ...group };
  data.id = String(data._id || data.id);
  return data;
}
