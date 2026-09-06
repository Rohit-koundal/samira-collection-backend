const { asyncHandler } = require('../middleware/validate');
const { applyProductStructure } = require('../services/masterConfigurationService');
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
const { auditSnapshot } = require('../utils/auditData');
const PRODUCT_AUDIT_FIELDS = ['name', 'sku', 'slug', 'brand', 'category', 'subCategory', 'price', 'originalPrice', 'stock', 'lowStockAlert', 'isActive', 'isArchived', 'isFeatured', 'isBestSeller', 'isNewArrival', 'showOnHomepage', 'showInTrending', 'showInFestive', 'sizes', 'colors', 'fabric', 'occasion', 'description', 'shortDescription', 'variants', 'variantGroupId', 'sizingMode', 'sizeChartProfile', 'sizeChart', 'sizeFitNotes', 'attributeValues', 'specifications', 'highlights', 'careInstructions', 'returnPolicy', 'tags'];
const { analyzeQuickAddImage, getQuickAddVisionStatus } = require('../services/quickAddVision.service');
const { wantsPagination, readPagination, buildPaginatedResponse } = require('../utils/validators');
const { normalizeProductSizing, validateProductSizing } = require('../services/productSizingService');

function catalogQuery(req, extra = {}) {
  return andFilter(extra, req.tenantFilter);
}

function withStoreId(payload, req) {
  const next = { ...payload };
  delete next.storeId;
  if (req.store?._id) next.storeId = req.store._id;
  return next;
}

async function getCategoryName(categoryId) {
  if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) return '';
  const category = await Category.findById(categoryId).select('name').lean();
  return category?.name || '';
}

function normalizeProductResponse(product, req) {
  const data = normalizeProductImages(product, req);
  if (data.attributeValues instanceof Map) data.attributeValues = Object.fromEntries(data.attributeValues);
  return normalizeProductSizing(data, data.category?.name || '');
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
  // Admin designer choices need identifiers and labels, not every image,
  // variant, size chart and description in the catalog.
  if (String(req.baseUrl || '').startsWith('/api/admin/products') && req.query.customizationOptions === 'true') {
    return res.json(await Product.find(query).select('_id name slug').sort(sort).lean());
  }
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([
      Product.find(query).populate('category').sort(sort).skip(skip).limit(limit),
      Product.countDocuments(query),
    ]);
    return res.json(buildPaginatedResponse(items.map((product) => normalizeProductResponse(product, req)), { page, limit, total }));
  }
  const products = await Product.find(query).populate('category').sort(sort);
  res.json(products.map((product) => normalizeProductResponse(product, req)));
};

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

exports.getProductBySlug = async (req, res) => {
  const scoped = catalogQuery(req, { isArchived: { $ne: true } });
  const productKey = String(req.params.slug || '').trim();
  let product = mongoose.Types.ObjectId.isValid(productKey)
    ? await Product.findOne(andFilter({ _id: productKey }, scoped)).populate('category')
    : await Product.findOne(andFilter({ slug: productKey }, scoped)).populate('category');
  if (!product && productKey && !mongoose.Types.ObjectId.isValid(productKey)) {
    product = await Product.findOne(andFilter({
      slug: { $regex: `^\\s*${escapeRegex(productKey)}\\s*$`, $options: 'i' },
    }, scoped)).populate('category');
  }
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json(normalizeProductResponse(product, req));
};

exports.getProductById = async (req, res) => {
  const product = await Product.findOne(catalogQuery(req, { _id: req.params.id })).populate('category');
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json(normalizeProductResponse(product, req));
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

exports.createProduct = asyncHandler(async (req, res) => {
  const basePayload = await applyProductStructure(withStoreId({ ...req.body, images: sanitizeProductImages(req.body.images) }, req));
  const categoryName = await getCategoryName(basePayload.category);
  const payload = applyVariantPayload(normalizeProductSizing(basePayload, categoryName));
  const error = validateProduct(payload);
  if (error) return res.status(400).json({ message: error });
  const sizingError = validateProductSizing(payload, categoryName);
  if (sizingError) return res.status(400).json({ message: sizingError });
  const product = await Product.create(normalizeProductPayload({ ...payload, slug: slugify(payload.slug || payload.name) }));
  logAudit({ req, action: 'PRODUCT_CREATE', entityType: 'Product', entityId: product._id, storeId: product.storeId, after: auditSnapshot(product, PRODUCT_AUDIT_FIELDS) });
  res.status(201).json(normalizeProductResponse(product, req));
});

exports.updateProduct = asyncHandler(async (req, res) => {
  const existingProduct = await Product.findOne(catalogQuery(req, { _id: req.params.id }));
  if (!existingProduct) return res.status(404).json({ message: 'Product not found' });
  assertStoreOwned(existingProduct, req);
  const basePayload = await applyProductStructure(withStoreId({ ...req.body, images: sanitizeProductImages(req.body.images) }, req), existingProduct);
  const categoryName = await getCategoryName(basePayload.category || existingProduct.category);
  const payload = applyVariantPayload(normalizeProductSizing(basePayload, categoryName));
  const error = validateProduct(payload, false);
  if (error) return res.status(400).json({ message: error });
  const sizingError = validateProductSizing(payload, categoryName);
  if (sizingError) return res.status(400).json({ message: sizingError });
  const nextImages = Array.isArray(payload.images) && payload.images.length ? payload.images : existingProduct.images || [];
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    normalizeProductPayload({
      ...payload,
      slug: slugify(payload.slug || existingProduct.slug || payload.name || existingProduct.name),
      images: nextImages,
      storeId: existingProduct.storeId,
    }),
    { new: true, runValidators: true },
  );
  await cleanupRemovedProductImages(existingProduct.images || [], product.images || []);
  logAudit({
    req,
    action: 'PRODUCT_UPDATE',
    entityType: 'Product',
    entityId: product._id,
    storeId: product.storeId,
    before: auditSnapshot(existingProduct, PRODUCT_AUDIT_FIELDS),
    after: auditSnapshot(product, PRODUCT_AUDIT_FIELDS),
  });
  res.json(normalizeProductResponse(product, req));
});

exports.deleteProduct = async (req, res) => {
  const product = await Product.findOne(catalogQuery(req, { _id: req.params.id }));
  if (!product) return res.status(404).json({ message: 'Product not found' });
  assertStoreOwned(product, req);
  const before = auditSnapshot(product, ['isActive', 'isArchived']);
  product.isActive = false;
  product.isArchived = true;
  product.deletedAt = product.deletedAt || new Date();
  await product.save();
  logAudit({ req, action: 'PRODUCT_ARCHIVE', entityType: 'Product', entityId: product._id, storeId: product.storeId, before, after: auditSnapshot(product, ['isActive', 'isArchived']) });
  res.json({ message: 'Product archived', product });
};

exports.updateStatus = asyncHandler(async (req, res) => {
  if (typeof req.body?.isActive !== 'boolean') return res.status(400).json({ message: 'isActive must be true or false' });
  const product = await Product.findOne(catalogQuery(req, { _id: req.params.id }));
  if (!product) return res.status(404).json({ message: 'Product not found' });
  const before = { isActive: product.isActive };
  product.isActive = req.body.isActive;
  await product.save();
  logAudit({ req, action: 'PRODUCT_VISIBILITY_UPDATE', entityType: 'Product', entityId: product._id, storeId: product.storeId, before, after: { isActive: product.isActive } });
  res.json(product);
});

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
    logAudit({ req, action: 'STOCK_UPDATE', entityType: 'Product', entityId: product._id, storeId: product.storeId, before: { stock: previousStock }, after: { stock: product.stock, variantId: req.body.variantId } });
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
  logAudit({ req, action: 'STOCK_UPDATE', entityType: 'Product', entityId: product._id, storeId: product.storeId, before: { stock: previousStock }, after: { stock: product.stock } });
  res.json(product);
};

exports.markOutOfStock = async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ message: 'Product not found' });
  const before = auditSnapshot(product, ['stock', 'variants']);
  if (hasManagedVariants(product)) {
    product.variants.forEach((variant) => { variant.stock = 0; });
  }
  product.stock = 0;
  await product.save();
  logAudit({ req, action: 'STOCK_UPDATE', entityType: 'Product', entityId: product._id, storeId: product.storeId, before, after: auditSnapshot(product, ['stock', 'variants']) });
  res.json(product);
};

exports.hideProduct = (req, res, next) => {
  req.body = { ...req.body, isActive: false };
  return exports.updateStatus(req, res, next);
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
