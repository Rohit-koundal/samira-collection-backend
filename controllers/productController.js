const Product = require('../models/Product');
const Category = require('../models/Category');
const slugify = require('../utils/slugify');
const mongoose = require('mongoose');
const {
  cleanMultilineText,
  cleanString,
  finiteMoney,
  paginationEnvelope,
  parsePagination,
  pick,
  rejectUnknown,
} = require('../utils/requestValidation');
const { normalizeProductImages, normalizeProductPayload, sanitizeProductImages } = require('../utils/imageUtils');
const { deleteMedia, getMediaStorageState } = require('../services/mediaStorage');
const { effectivePermissions } = require('../config/adminPermissions');

const PRODUCT_FIELDS = [
  'name', 'slug', 'brand', 'shortDescription', 'description', 'category', 'subCategory', 'price',
  'originalPrice', 'images', 'videos', 'media', 'sizes', 'colors', 'fabric', 'occasion',
  'variantGroupId', 'variantName', 'variantColor', 'variantSize', 'variants', 'stock', 'lowStockAlert',
  'sku', 'tags', 'primaryImage', 'highlights', 'careInstructions', 'returnPolicy', 'metaTitle',
  'metaDescription', 'metaKeywords', 'isFeatured', 'isNewArrival', 'isBestSeller', 'showOnHomepage',
  'showInTrending', 'showInFestive', 'isActive',
];
const PROTECTED_PRODUCT_FIELDS = [
  '_id', 'reservedStock', 'rating', 'numReviews', 'discountPercentage', 'createdAt', 'updatedAt', '__v',
];

exports.getProducts = async (req, res) => {
  const isAdminRequest = ['admin', 'owner'].includes(req.user?.role)
    && String(req.baseUrl || '').startsWith('/api/admin/products');
  const query = isAdminRequest ? {} : { isActive: true, archivedAt: null };
  const search = String(req.query.search || '').trim().slice(0, 100);
  if (search) query.$or = [
    { name: { $regex: escapeRegex(search), $options: 'i' } },
    { sku: { $regex: escapeRegex(search), $options: 'i' } },
    { fabric: { $regex: escapeRegex(search), $options: 'i' } },
    { occasion: { $regex: escapeRegex(search), $options: 'i' } },
  ];
  if (req.query.category) {
    const categoryFilter = cleanString(req.query.category, { field: 'category', min: 1, max: 120, required: true });
    if (mongoose.Types.ObjectId.isValid(categoryFilter)) {
      query.category = categoryFilter;
    } else {
      const category = await Category.findOne({
        isActive: true,
        $or: [
          { slug: categoryFilter },
          { name: { $regex: `^${escapeRegex(categoryFilter)}$`, $options: 'i' } },
        ],
      });
      if (category) query.category = category._id;
      else query.category = null;
    }
  }
  if (req.query.size) query.sizes = cleanString(req.query.size, { field: 'size', min: 1, max: 80, required: true });
  if (req.query.color) query.colors = cleanString(req.query.color, { field: 'color', min: 1, max: 80, required: true });
  if (req.query.fabric) query.fabric = cleanString(req.query.fabric, { field: 'fabric', min: 1, max: 100, required: true });
  if (req.query.occasion) query.occasion = cleanString(req.query.occasion, { field: 'occasion', min: 1, max: 100, required: true });
  const hasMinPrice = req.query.minPrice !== undefined && req.query.minPrice !== '';
  const hasMaxPrice = req.query.maxPrice !== undefined && req.query.maxPrice !== '';
  if (hasMinPrice || hasMaxPrice) {
    query.price = {};
    if (hasMinPrice) query.price.$gte = finiteMoney(req.query.minPrice, { field: 'minPrice' });
    if (hasMaxPrice) query.price.$lte = finiteMoney(req.query.maxPrice, { field: 'maxPrice' });
    if (query.price.$gte !== undefined && query.price.$lte !== undefined && query.price.$gte > query.price.$lte) {
      const error = new Error('minPrice cannot exceed maxPrice');
      error.statusCode = 400;
      error.code = 'VALIDATION_ERROR';
      throw error;
    }
  }
  if (req.query.discount !== undefined && req.query.discount !== '') {
    query.discountPercentage = { $gte: finiteMoney(req.query.discount, { field: 'discount', min: 0, max: 100 }) };
  }
  if (req.query.rating !== undefined && req.query.rating !== '') {
    query.rating = { $gte: finiteMoney(req.query.rating, { field: 'rating', min: 0, max: 5 }) };
  }
  if (req.query.stock === 'in') query.stock = { $gt: 0 };
  if (req.query.stock === 'out') query.stock = 0;
  if (req.query.featured === 'true') query.isFeatured = true;
  if (req.query.newArrival === 'true') query.isNewArrival = true;
  if (req.query.bestSeller === 'true') query.isBestSeller = true;

  const sortAliases = {
    newest: '-createdAt',
    priceLowHigh: 'price',
    priceHighLow: '-price',
    discount: '-discountPercentage',
    rating: '-rating',
  };
  const paginationQuery = {
    ...req.query,
    sort: sortAliases[req.query.sort] || req.query.sort || '-createdAt',
  };
  const { page, limit, skip, sort } = parsePagination(paginationQuery, {
    defaultLimit: 24,
    maxLimit: 100,
    allowedSorts: ['createdAt', 'price', 'discountPercentage', 'rating', 'name'],
  });
  const [products, total] = await Promise.all([
    Product.find(query).populate('category').sort(sort).skip(skip).limit(limit),
    Product.countDocuments(query),
  ]);
  res.json(paginationEnvelope(
    products.map((product) => normalizeProductImages(product, req)),
    total,
    page,
    limit,
  ));
};

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

exports.getProductBySlug = async (req, res) => {
  const product = mongoose.Types.ObjectId.isValid(req.params.slug)
    ? await Product.findOne({ _id: req.params.slug, isActive: true, archivedAt: null }).populate('category')
    : await Product.findOne({ slug: req.params.slug, isActive: true, archivedAt: null }).populate('category');
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json(normalizeProductImages(product, req));
};

exports.getProductById = async (req, res) => {
  const product = await Product.findById(req.params.id).populate('category');
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json(normalizeProductImages(product, req));
};

exports.createProduct = async (req, res) => {
  rejectUnknown(req.body, PRODUCT_FIELDS, PROTECTED_PRODUCT_FIELDS);
  const payload = buildProductPayload(req.body, { creating: true });
  const error = validateProduct(payload);
  if (error) return res.status(400).json({ message: error });
  const product = await Product.create(normalizeProductPayload({ ...payload, slug: payload.slug || slugify(payload.name) }));
  res.status(201).json(normalizeProductImages(product, req));
};

exports.updateProduct = async (req, res) => {
  const existingProduct = await Product.findById(req.params.id);
  if (!existingProduct) return res.status(404).json({ message: 'Product not found' });
  rejectUnknown(req.body, PRODUCT_FIELDS, PROTECTED_PRODUCT_FIELDS);
  const payload = buildProductPayload(req.body, { existingProduct });
  const error = validateProduct(payload, false);
  if (error) return res.status(400).json({ message: error });
  const nextImages = Array.isArray(payload.images) && payload.images.length ? payload.images : existingProduct.images || [];
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    normalizeProductPayload({ ...payload, images: nextImages }),
    { new: true, runValidators: true },
  );
  if (effectivePermissions(req.user).has('delete_media')) {
    await cleanupRemovedProductImages(existingProduct.images || [], product.images || []);
  }
  res.json(normalizeProductImages(product, req));
};

exports.deleteProduct = async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ message: 'Product not found' });
  product.isActive = false;
  product.archivedAt = new Date();
  await product.save();
  return res.json({ message: 'Product archived', product });
};

exports.updateStatus = async (req, res) => {
  if (typeof req.body.isActive !== 'boolean' || Object.keys(req.body).some((field) => field !== 'isActive')) {
    return res.status(400).json({ message: 'isActive must be a boolean' });
  }
  const product = await Product.findByIdAndUpdate(req.params.id, { isActive: req.body.isActive }, { new: true });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json(product);
};

exports.updateStock = async (req, res) => {
  const stock = Number(req.body.stock);
  if (!Number.isSafeInteger(stock) || stock < 0 || Object.keys(req.body).some((field) => field !== 'stock')) {
    return res.status(400).json({ message: 'Stock must be a non-negative whole number' });
  }
  const product = await Product.findByIdAndUpdate(req.params.id, { stock }, { new: true, runValidators: true });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json(product);
};

exports.markOutOfStock = async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, { stock: 0 }, { new: true });
  res.json(product);
};

exports.hideProduct = async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  res.json(product);
};

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
  if (data.media?.spin360?.enabled && data.media.spin360.type === 'image-sequence' && (!Array.isArray(data.media.spin360.frames) || data.media.spin360.frames.length < 12)) {
    return '360 image sequences require at least 12 frames';
  }
  if (process.env.NODE_ENV === 'production' && Array.isArray(data.images) && data.images.some((image) => isInaccessibleImageUrl(image?.url))) {
    return 'Image URLs must be publicly accessible. Please re-upload images before saving.';
  }
  return '';
}

function isInaccessibleImageUrl(url = '') {
  return /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(String(url));
}

function buildProductPayload(body, { creating = false, existingProduct } = {}) {
  const payload = pick(body, PRODUCT_FIELDS);
  if (payload.name !== undefined) payload.name = cleanString(payload.name, { field: 'name', min: 3, max: 200, required: true });
  for (const field of [
    'brand', 'shortDescription', 'subCategory', 'fabric', 'occasion', 'variantName', 'variantColor',
    'variantSize', 'sku', 'primaryImage', 'metaTitle', 'metaKeywords',
  ]) {
    if (payload[field] !== undefined) payload[field] = cleanString(payload[field], { field, max: 300 });
  }
  for (const field of ['description', 'careInstructions', 'returnPolicy', 'metaDescription']) {
    if (payload[field] !== undefined) payload[field] = cleanMultilineText(payload[field], { field, max: 5000 });
  }
  if (payload.slug !== undefined) payload.slug = slugify(payload.slug);
  if (payload.images !== undefined) payload.images = sanitizeProductImages(payload.images);
  if (payload.videos !== undefined) payload.videos = normalizeMediaEntries(payload.videos, 'video');
  if (payload.media !== undefined) payload.media = normalizeProductMedia(payload.media);
  for (const field of ['sizes', 'colors', 'tags', 'highlights']) {
    if (payload[field] !== undefined) payload[field] = normalizeStringArray(payload[field], field);
  }
  for (const field of ['price', 'originalPrice']) {
    if (payload[field] !== undefined) {
      const value = Number(payload[field]);
      if (!Number.isFinite(value) || value <= 0 || value > 100000000) throw productValidationError(`Invalid ${field}`);
      payload[field] = Math.round(value * 100) / 100;
    }
  }
  for (const field of ['stock', 'lowStockAlert']) {
    if (payload[field] !== undefined) {
      const value = Number(payload[field]);
      if (!Number.isSafeInteger(value) || value < 0 || value > 100000000) throw productValidationError(`Invalid ${field}`);
      payload[field] = value;
    }
  }
  if (payload.variants !== undefined) payload.variants = normalizeVariants(payload.variants, existingProduct);
  if (existingProduct) payload.reservedStock = Number(existingProduct.reservedStock || 0);
  if (creating && payload.stock === undefined) payload.stock = 0;
  return payload;
}

function normalizeVariants(value, existingProduct) {
  if (!Array.isArray(value) || value.length > 500) throw productValidationError('variants must be an array with at most 500 entries');
  const existing = new Map((existingProduct?.variants || []).map((variant) => [String(variant._id), variant]));
  const retainedIds = new Set();
  const variants = value.map((variant, index) => {
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)) throw productValidationError(`Invalid variant at position ${index + 1}`);
    const allowed = pick(variant, ['_id', 'sku', 'size', 'color', 'stock', 'price', 'originalPrice', 'barcode', 'weight', 'images', 'isActive']);
    const old = allowed._id ? existing.get(String(allowed._id)) : null;
    if (allowed._id && !old) throw productValidationError('Variant identifier does not belong to this product');
    if (old) retainedIds.add(String(old._id));
    for (const field of ['sku', 'size', 'color', 'barcode']) {
      if (allowed[field] !== undefined) allowed[field] = cleanString(allowed[field], { field: `variant.${field}`, max: 120 });
    }
    const stock = Number(allowed.stock ?? old?.stock ?? 0);
    if (!Number.isSafeInteger(stock) || stock < 0) throw productValidationError('Variant stock must be a non-negative whole number');
    allowed.stock = stock;
    allowed.reservedStock = Number(old?.reservedStock || 0);
    for (const field of ['price', 'originalPrice', 'weight']) {
      if (allowed[field] !== undefined && allowed[field] !== '') {
        const number = Number(allowed[field]);
        if (!Number.isFinite(number) || number < 0) throw productValidationError(`Invalid variant ${field}`);
        allowed[field] = number;
      }
    }
    if (allowed.images !== undefined) allowed.images = normalizeMediaEntries(allowed.images, 'image');
    return allowed;
  });
  const removedReserved = [...existing.values()].find(
    (variant) => !retainedIds.has(String(variant._id)) && Number(variant.reservedStock || 0) > 0,
  );
  if (removedReserved) throw productValidationError('A variant with reserved inventory cannot be removed');
  return variants;
}

function normalizeStringArray(value, field) {
  if (!Array.isArray(value) || value.length > 100) throw productValidationError(`${field} must be an array`);
  return [...new Set(value.map((item) => cleanString(item, { field, max: 100 })).filter(Boolean))];
}

function normalizeMediaEntries(value, kind) {
  if (!Array.isArray(value) || value.length > 100) throw productValidationError(`${kind} media must be an array`);
  return value.map((entry) => {
    const source = typeof entry === 'string' ? { url: entry } : entry;
    const url = String(source?.url || '').trim();
    if (!isSafeMediaUrl(url)) throw productValidationError(`Invalid ${kind} media URL`);
    return {
      url,
      publicId: source.publicId ? String(source.publicId).slice(0, 500) : undefined,
      ...(kind === 'image' ? {} : { thumbnail: source.thumbnail ? String(source.thumbnail).slice(0, 2000) : undefined }),
    };
  });
}

function normalizeProductMedia(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw productValidationError('media must be an object');
  const media = {};
  if (value.images !== undefined) media.images = normalizeMediaEntries(value.images, 'image');
  if (value.videos !== undefined) media.videos = normalizeMediaEntries(value.videos, 'video').map((video) => ({
    ...video,
    thumbnailUrl: video.thumbnail,
  }));
  if (value.spin360 !== undefined) {
    const spin = value.spin360 || {};
    media.spin360 = {
      enabled: Boolean(spin.enabled),
      type: spin.type === 'video' ? 'video' : 'image-sequence',
      frames: Array.isArray(spin.frames) ? spin.frames.slice(0, 180).map((frame, index) => {
        const url = String(frame?.url || frame || '').trim();
        if (!isSafeMediaUrl(url)) throw productValidationError('Invalid 360 frame URL');
        return { url, sortOrder: Number(frame?.sortOrder ?? index) };
      }) : [],
      videoUrl: spin.videoUrl && isSafeMediaUrl(spin.videoUrl) ? spin.videoUrl : undefined,
      thumbnailUrl: spin.thumbnailUrl && isSafeMediaUrl(spin.thumbnailUrl) ? spin.thumbnailUrl : undefined,
      totalFrames: Array.isArray(spin.frames) ? spin.frames.length : 0,
    };
  }
  if (value.ar !== undefined) {
    const ar = value.ar || {};
    media.ar = {
      enabled: Boolean(ar.enabled),
      glbUrl: optionalSafeMediaUrl(ar.glbUrl, 'AR GLB'),
      usdzUrl: optionalSafeMediaUrl(ar.usdzUrl, 'AR USDZ'),
      posterUrl: optionalSafeMediaUrl(ar.posterUrl, 'AR poster'),
      scale: cleanString(ar.scale, { field: 'AR scale', max: 50 }),
      placement: cleanString(ar.placement, { field: 'AR placement', max: 50 }),
    };
  }
  return media;
}

function optionalSafeMediaUrl(value, label) {
  if (!value) return undefined;
  const url = String(value).trim();
  if (!isSafeMediaUrl(url)) throw productValidationError(`Invalid ${label} URL`);
  return url;
}

function isSafeMediaUrl(value) {
  return /^https:\/\//i.test(String(value || '')) || /^\/uploads\/[a-z0-9._-]+$/i.test(String(value || ''));
}

function productValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}

async function cleanupRemovedProductImages(existingImages = [], nextImages = []) {
  const retainedKeys = new Set(
    nextImages.map((image) => String(image.publicId || image.url || '')).filter(Boolean),
  );
  const removedImages = existingImages.filter((image) => !retainedKeys.has(String(image.publicId || image.url || '')));
  await Promise.all(removedImages.map((image) => safeDeleteImage(image)));
}

async function safeDeleteImage(image) {
  if (!getMediaStorageState().configured) return;
  try {
    await deleteMedia(image);
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
