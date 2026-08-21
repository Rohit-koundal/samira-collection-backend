const Product = require('../models/Product');
const Category = require('../models/Category');
const slugify = require('../utils/slugify');
const mongoose = require('mongoose');
const { normalizeProductImages, normalizeProductPayload, sanitizeProductImages } = require('../utils/imageUtils');
const { deleteImageFromR2, isR2Configured } = require('../services/r2Upload');
const { hasManagedVariants, normalizeVariantsPayload, totalVariantStock } = require('../services/variantService');
const { andFilter } = require('../services/storeService');
const { assertStoreOwned } = require('../middleware/storeMiddleware');
const { logAudit } = require('../services/auditService');
const { analyzeQuickAddImage, getQuickAddVisionStatus } = require('../services/quickAddVision.service');
const { wantsPagination, readPagination, buildPaginatedResponse } = require('../utils/validators');

function catalogQuery(req, extra = {}) {
  return andFilter(extra, req.tenantFilter);
}

function withStoreId(payload, req) {
  const next = { ...payload };
  delete next.storeId;
  if (req.store?._id) next.storeId = req.store._id;
  return next;
}

exports.getProducts = async (req, res) => {
  const isAdminRequest = req.query.admin === 'true'
    || String(req.baseUrl || '').startsWith('/api/admin/products')
    || String(req.baseUrl || '').startsWith('/api/seller/products');
  const query = catalogQuery(req, isAdminRequest ? {} : { isActive: true, isArchived: { $ne: true } });
  if (req.query.search) query.$or = [
    { name: { $regex: req.query.search, $options: 'i' } },
    { sku: { $regex: req.query.search, $options: 'i' } },
    { fabric: { $regex: req.query.search, $options: 'i' } },
    { occasion: { $regex: req.query.search, $options: 'i' } },
  ];
  if (req.query.category) {
    if (mongoose.Types.ObjectId.isValid(req.query.category)) {
      query.category = req.query.category;
    } else {
      const category = await Category.findOne({
        $or: [
          { slug: req.query.category },
          { name: { $regex: `^${escapeRegex(req.query.category)}$`, $options: 'i' } },
        ],
      });
      if (category) query.category = category._id;
      else query.category = null;
    }
  }
  if (req.query.size) query.sizes = req.query.size;
  if (req.query.color) query.colors = req.query.color;
  if (req.query.fabric) query.fabric = req.query.fabric;
  if (req.query.occasion) query.occasion = req.query.occasion;
  if (req.query.minPrice || req.query.maxPrice) {
    query.price = {};
    if (req.query.minPrice) query.price.$gte = Number(req.query.minPrice);
    if (req.query.maxPrice) query.price.$lte = Number(req.query.maxPrice);
  }
  if (req.query.discount) query.discountPercentage = { $gte: Number(req.query.discount) };
  if (req.query.rating) query.rating = { $gte: Number(req.query.rating) };
  if (req.query.stock === 'in') query.stock = { $gt: 0 };
  if (req.query.stock === 'out') query.stock = 0;
  if (req.query.featured === 'true') query.isFeatured = true;
  if (req.query.newArrival === 'true') query.isNewArrival = true;
  if (req.query.bestSeller === 'true') query.isBestSeller = true;

  const sortMap = {
    newest: '-createdAt',
    priceLowHigh: 'price',
    priceHighLow: '-price',
    discount: '-discountPercentage',
    rating: '-rating',
  };
  const sort = sortMap[req.query.sort] || '-createdAt';
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([
      Product.find(query).populate('category').sort(sort).skip(skip).limit(limit),
      Product.countDocuments(query),
    ]);
    return res.json(buildPaginatedResponse(items.map((product) => normalizeProductImages(product, req)), { page, limit, total }));
  }
  const products = await Product.find(query).populate('category').sort(sort);
  res.json(products.map((product) => normalizeProductImages(product, req)));
};

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

exports.getProductBySlug = async (req, res) => {
  const scoped = catalogQuery(req, { isArchived: { $ne: true } });
  const product = mongoose.Types.ObjectId.isValid(req.params.slug)
    ? await Product.findOne(andFilter({ _id: req.params.slug }, scoped)).populate('category')
    : await Product.findOne(andFilter({ slug: req.params.slug }, scoped)).populate('category');
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json(normalizeProductImages(product, req));
};

exports.getProductById = async (req, res) => {
  const product = await Product.findOne(catalogQuery(req, { _id: req.params.id })).populate('category');
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json(normalizeProductImages(product, req));
};

exports.getQuickAddVisionStatus = async (_req, res) => {
  res.json(getQuickAddVisionStatus());
};

exports.analyzeQuickAdd = async (req, res) => {
  try {
    const result = await analyzeQuickAddImage({
      imageUrl: req.body?.imageUrl,
      categories: Array.isArray(req.body?.categories) ? req.body.categories : [],
      subcategories: Array.isArray(req.body?.subcategories) ? req.body.subcategories : [],
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ enabled: true, message: error.message || 'Could not read this photo' });
  }
};

exports.createProduct = async (req, res) => {
  const payload = applyVariantPayload(withStoreId({ ...req.body, images: sanitizeProductImages(req.body.images) }, req));
  const error = validateProduct(payload);
  if (error) return res.status(400).json({ message: error });
  const product = await Product.create(normalizeProductPayload({ ...payload, slug: payload.slug || slugify(payload.name) }));
  logAudit({ req, action: 'PRODUCT_CREATE', entityType: 'Product', entityId: product._id, after: { name: product.name, price: product.price, stock: product.stock } });
  res.status(201).json(normalizeProductImages(product, req));
};

exports.updateProduct = async (req, res) => {
  const existingProduct = await Product.findOne(catalogQuery(req, { _id: req.params.id }));
  if (!existingProduct) return res.status(404).json({ message: 'Product not found' });
  assertStoreOwned(existingProduct, req);
  const payload = applyVariantPayload(withStoreId({ ...req.body, images: sanitizeProductImages(req.body.images) }, req));
  const error = validateProduct(payload, false);
  if (error) return res.status(400).json({ message: error });
  const nextImages = Array.isArray(payload.images) && payload.images.length ? payload.images : existingProduct.images || [];
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    normalizeProductPayload({ ...payload, images: nextImages, storeId: existingProduct.storeId }),
    { new: true, runValidators: true },
  );
  await cleanupRemovedProductImages(existingProduct.images || [], product.images || []);
  logAudit({
    req,
    action: 'PRODUCT_UPDATE',
    entityType: 'Product',
    entityId: product._id,
    before: { price: existingProduct.price, stock: existingProduct.stock },
    after: { price: product.price, stock: product.stock },
  });
  res.json(normalizeProductImages(product, req));
};

exports.deleteProduct = async (req, res) => {
  const product = await Product.findOne(catalogQuery(req, { _id: req.params.id }));
  if (!product) return res.status(404).json({ message: 'Product not found' });
  assertStoreOwned(product, req);
  product.isActive = false;
  product.isArchived = true;
  product.deletedAt = product.deletedAt || new Date();
  await product.save();
  logAudit({ req, action: 'PRODUCT_ARCHIVE', entityType: 'Product', entityId: product._id });
  res.json({ message: 'Product archived', product });
};

exports.updateStatus = async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, { isActive: req.body.isActive }, { new: true });
  res.json(product);
};

exports.updateStock = async (req, res) => {
  if (Number(req.body.stock) < 0) return res.status(400).json({ message: 'Stock cannot be negative' });
  const product = await Product.findOne(catalogQuery(req, { _id: req.params.id }));
  if (!product) return res.status(404).json({ message: 'Product not found' });
  assertStoreOwned(product, req);
  const previousStock = product.stock;

  if (req.body.variantId) {
    const variant = product.variants.id(req.body.variantId);
    if (!variant) return res.status(404).json({ message: 'Variant not found' });
    variant.stock = Number(req.body.stock);
    product.stock = totalVariantStock(product);
    await product.save();
    logAudit({ req, action: 'STOCK_UPDATE', entityType: 'Product', entityId: product._id, before: { stock: previousStock }, after: { stock: product.stock, variantId: req.body.variantId } });
    return res.json(product);
  }

  if (hasManagedVariants(product)) {
    return res.status(400).json({
      message: 'This product tracks stock by size and colour. Update a specific variant instead.',
      code: 'VARIANT_UNAVAILABLE',
    });
  }

  product.stock = Number(req.body.stock);
  await product.save();
  logAudit({ req, action: 'STOCK_UPDATE', entityType: 'Product', entityId: product._id, before: { stock: previousStock }, after: { stock: product.stock } });
  res.json(product);
};

exports.markOutOfStock = async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ message: 'Product not found' });
  if (hasManagedVariants(product)) {
    product.variants.forEach((variant) => { variant.stock = 0; });
  }
  product.stock = 0;
  await product.save();
  res.json(product);
};

exports.hideProduct = async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  res.json(product);
};

function applyVariantPayload(data = {}) {
  const payload = { ...data };
  const variants = normalizeVariantsPayload(payload.variants, payload);
  if (variants === undefined) return payload;
  payload.variants = variants;
  if (variants.length) {
    payload.stock = totalVariantStock({ variants });
    payload.sizes = [...new Set(variants.map((variant) => variant.size).filter(Boolean))];
    payload.colors = [...new Set(variants.map((variant) => variant.color).filter(Boolean))];
  }
  return payload;
}

function validateProduct(data, creating = true) {
  if (!data.name || data.name.trim().length < 3) return 'Product name must be at least 3 characters';
  if (!data.sku) return 'SKU is required';
  if (creating && !data.category) return 'Category is required';
  if (Number(data.originalPrice) <= 0) return 'Original price is required';
  if (Number(data.price) <= 0) return 'Selling price is required';
  if (Number(data.price) > Number(data.originalPrice)) return 'Selling price cannot exceed original price';
  if (Number(data.stock) < 0) return 'Stock cannot be negative';
  if (creating && (!Array.isArray(data.images) || !data.images.length)) return 'At least one product image is required';
  if (Array.isArray(data.images) && data.images.some((image) => image.url?.startsWith('data:'))) return 'Images must be uploaded files or valid URLs, not base64 data';
  if (Array.isArray(data.images) && data.images.some((image) => image?.url && !image.url.startsWith('http') && !image.url.startsWith('/uploads/'))) {
    return 'Each image must be a valid uploaded URL';
  }
  if (process.env.NODE_ENV === 'production' && Array.isArray(data.images) && data.images.some((image) => isInaccessibleImageUrl(image?.url))) {
    return 'Image URLs must be publicly accessible. Please re-upload images before saving.';
  }
  return '';
}

function isInaccessibleImageUrl(url = '') {
  return /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(String(url));
}

async function cleanupRemovedProductImages(existingImages = [], nextImages = []) {
  const retainedKeys = new Set(
    nextImages.map((image) => String(image.publicId || image.url || '')).filter(Boolean),
  );
  const removedImages = existingImages.filter((image) => !retainedKeys.has(String(image.publicId || image.url || '')));
  await Promise.all(removedImages.map((image) => safeDeleteImage(image)));
}

async function safeDeleteImage(image) {
  if (!isR2Configured()) return;
  try {
    await deleteImageFromR2(image);
  } catch {
    // Ignore storage cleanup failures so product save/delete doesn't break.
  }
}

async function cleanupProductAssets(product) {
  const deletions = [];
  if (Array.isArray(product.images)) {
    deletions.push(...product.images.map((image) => safeDeleteImage(image)));
  }
  if (Array.isArray(product.videos)) {
    for (const video of product.videos) {
      deletions.push(safeDeleteImage(video));
      if (video?.thumbnail) deletions.push(safeDeleteImage(video.thumbnail));
    }
  }
  await Promise.all(deletions);
}
