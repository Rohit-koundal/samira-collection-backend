const slugify = require('../utils/slugify');
const VariantGroup = require('../models/VariantGroup');
const Product = require('../models/Product');

exports.listGroups = async (req, res) => {
  const groups = await VariantGroup.find().populate('baseProduct').populate('products').sort('-updatedAt');
  res.json({ success: true, data: groups.map(formatGroup) });
};

exports.getGroup = async (req, res) => {
  const group = await VariantGroup.findById(req.params.id).populate('baseProduct').populate('products');
  if (!group) return res.status(404).json({ success: false, message: 'Variant group not found' });
  res.json({ success: true, data: formatGroup(group) });
};

exports.createGroup = async (req, res) => {
  const payload = normalizeGroupPayload(req.body);
  if (!payload.name) return res.status(400).json({ success: false, message: 'Group name is required' });
  const group = await VariantGroup.create({
    ...payload,
    slug: await ensureUniqueSlug(payload.slug || payload.name),
    createdBy: req.user?._id,
  });
  await attachProducts(group, payload.productIds || []);
  await group.populate(['baseProduct', 'products']);
  res.status(201).json({ success: true, message: 'Variant group created successfully', data: formatGroup(group) });
};

exports.updateGroup = async (req, res) => {
  const group = await VariantGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ success: false, message: 'Variant group not found' });
  const payload = normalizeGroupPayload(req.body);
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
};

exports.deleteGroup = async (req, res) => {
  const group = await VariantGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ success: false, message: 'Variant group not found' });
  await Product.updateMany({ variantGroupId: group._id }, { $unset: { variantGroupId: 1, variantName: 1, variantColor: 1, variantSize: 1 } });
  await VariantGroup.findByIdAndDelete(group._id);
  res.json({ success: true, message: 'Variant group deleted successfully' });
};

exports.addProducts = async (req, res) => {
  const group = await VariantGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ success: false, message: 'Variant group not found' });
  const productIds = ensureArray(req.body.productIds);
  await attachProducts(group, productIds);
  await group.populate(['baseProduct', 'products']);
  res.json({ success: true, message: 'Products added to group', data: formatGroup(group) });
};

exports.removeProducts = async (req, res) => {
  const group = await VariantGroup.findById(req.params.id);
  if (!group) return res.status(404).json({ success: false, message: 'Variant group not found' });
  const productIds = ensureArray(req.body.productIds);
  group.products = group.products.filter((id) => !productIds.some((item) => String(item) === String(id)));
  await group.save();
  await Product.updateMany({ _id: { $in: productIds } }, { $unset: { variantGroupId: 1, variantName: 1, variantColor: 1, variantSize: 1 } });
  await group.populate(['baseProduct', 'products']);
  res.json({ success: true, message: 'Products removed from group', data: formatGroup(group) });
};

exports.getGroupByIdPublic = exports.getGroup;

function normalizeGroupPayload(body = {}) {
  return {
    name: String(body.name || '').trim(),
    slug: String(body.slug || '').trim(),
    baseProduct: body.baseProduct || undefined,
    productIds: ensureArray(body.productIds),
    colors: splitList(body.colors),
    sizes: splitList(body.sizes),
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
  const products = await Product.find({ _id: { $in: productIds } });
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

async function syncGroupProducts(group, productIds = []) {
  const existingIds = (group.products || []).map(String);
  const nextIds = productIds.map(String);
  const removeIds = existingIds.filter((id) => !nextIds.includes(id));
  const addIds = nextIds.filter((id) => !existingIds.includes(id));
  if (removeIds.length) {
    await Product.updateMany({ _id: { $in: removeIds } }, { $unset: { variantGroupId: 1, variantName: 1, variantColor: 1, variantSize: 1 } });
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
