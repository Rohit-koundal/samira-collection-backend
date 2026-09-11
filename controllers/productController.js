const { asyncHandler } = require('../middleware/validate');
const { applyProductStructure, readConfiguration } = require('../services/masterConfigurationService');
const Product = require('../models/Product');
const InventoryTransaction = require('../models/InventoryTransaction');
const Category = require('../models/Category');
const slugify = require('../utils/slugify');
const mongoose = require('mongoose');
const { normalizeProductImages, normalizeProductPayload, sanitizeProductImages } = require('../utils/imageUtils');
const { deleteImageFromR2, isR2Configured } = require('../services/r2Upload');
const { hasManagedVariants, normalizeVariantsPayload, totalVariantStock, validateVariantPayload } = require('../services/variantService');
const { applyInventoryAdjustment, markProductOutOfStock, recordOpeningInventory } = require('../services/inventoryService');
const { andFilter } = require('../services/storeService');
const { assertStoreOwned } = require('../middleware/storeMiddleware');
const { logAudit } = require('../services/auditService');
const { auditSnapshot } = require('../utils/auditData');
const PRODUCT_AUDIT_FIELDS = ['name', 'sku', 'slug', 'brand', 'category', 'subCategory', 'price', 'originalPrice', 'salePrice', 'costPrice', 'gstRate', 'hsnCode', 'barcode', 'stock', 'lowStockAlert', 'reorderQuantity', 'shippingWeightKg', 'packageDimensions', 'countryOfOrigin', 'manufacturerDetails', 'warranty', 'supplierName', 'supplierSku', 'restockAt', 'publishAt', 'saleStartAt', 'saleEndAt', 'isActive', 'isArchived', 'isFeatured', 'isBestSeller', 'isNewArrival', 'showOnHomepage', 'showInTrending', 'showInFestive', 'sizes', 'colors', 'fabric', 'occasion', 'description', 'shortDescription', 'variants', 'variantGroupId', 'sizingMode', 'sizeChartProfile', 'sizeChart', 'sizeFitNotes', 'attributeValues', 'specifications', 'highlights', 'careInstructions', 'returnPolicy', 'returnable', 'exchangeable', 'returnWindowDays', 'tags'];
const { analyzeQuickAddImage, getQuickAddVisionStatus } = require('../services/quickAddVision.service');
const { wantsPagination, readPagination, buildPaginatedResponse } = require('../utils/validators');
const { normalizeProductSizing, validateProductSizing } = require('../services/productSizingService');
const { applyEffectivePricing } = require('../services/productPricingService');
const { availableStock, stockWarning } = require('../services/dashboardAnalytics');
const { runInTransaction } = require('../utils/transaction');
const { ApiError } = require('../utils/apiError');
const { isMasterOwner } = require('../config/masterOwner');

function inventoryMovementDrafts(beforeProduct, afterProduct, req) {
  const base = { storeId: afterProduct.storeId, product: afterProduct._id, type: 'MANUAL_ADJUSTMENT', mode: 'SET', bucket: 'SELLABLE', reasonCode: 'CORRECTION', reason: 'Product form inventory update', createdBy: req.user?._id };
  const beforeVariants = Array.isArray(beforeProduct.variants) ? beforeProduct.variants : [];
  const afterVariants = Array.isArray(afterProduct.variants) ? afterProduct.variants : [];
  if (!beforeVariants.length && !afterVariants.length) {
    const before = Number(beforeProduct.stock || 0); const after = Number(afterProduct.stock || 0);
    return before === after ? [] : [{ ...base, sku: afterProduct.sku, quantity: after - before, stockBefore: before, stockAfter: after }];
  }
  const key = (variant) => String(variant?._id || '') || [variant?.sku, variant?.size, variant?.color].join('::');
  const previous = new Map(beforeVariants.map((variant) => [key(variant), variant]));
  const current = new Map(afterVariants.map((variant) => [key(variant), variant]));
  const keys = new Set([...previous.keys(), ...current.keys()]);
  return [...keys].flatMap((variantKey) => {
    const beforeVariant = previous.get(variantKey); const afterVariant = current.get(variantKey);
    const before = Number(beforeVariant?.stock || 0); const after = Number(afterVariant?.stock || 0);
    if (before === after) return [];
    return [{ ...base, variantId: String(afterVariant?._id || beforeVariant?._id || ''), sku: afterVariant?.sku || beforeVariant?.sku || afterProduct.sku, quantity: after - before, stockBefore: before, stockAfter: after }];
  });
}

function inventoryFingerprint(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  return JSON.stringify({
    stock: Number(product?.stock || 0),
    variants: variants.map((variant) => ({ id: String(variant?._id || ''), sku: variant?.sku || '', size: variant?.size || '', color: variant?.color || '', stock: Number(variant?.stock || 0), active: variant?.isActive !== false })),
  });
}

function withInventoryRevision(query, revision) {
  if (Number(revision) === 0) {
    return { $and: [query, { $or: [{ inventoryRevision: 0 }, { inventoryRevision: { $exists: false } }] }] };
  }
  return { ...query, inventoryRevision: revision };
}

function catalogQuery(req, extra = {}) {
  return andFilter(extra, req.tenantFilter);
}

function withStoreId(payload, req) {
  const next = { ...payload };
  delete next.storeId;
  if (req.store?._id) next.storeId = req.store._id;
  return next;
}

async function getCategoryName(categoryId, req) {
  if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) return '';
  const category = await Category.findOne(andFilter({ _id: categoryId, isArchived: { $ne: true } }, req?.tenantFilter)).select('name').lean();
  return category?.name || '';
}

function normalizeProductResponse(product, req) {
  const baseUrl = String(req?.baseUrl || '');
  const isPrivateCatalog = baseUrl.startsWith('/api/admin/products') || baseUrl.startsWith('/api/seller');
  const data = normalizeProductImages(isPrivateCatalog ? product : applyEffectivePricing(product), req);
  if (data.attributeValues instanceof Map) data.attributeValues = Object.fromEntries(data.attributeValues);
  return normalizeProductSizing(data, data.category?.name || '');
}

exports.getProducts = asyncHandler(async (req, res) => {
  const baseUrl = String(req.baseUrl || '');
  const isAdminRequest = baseUrl.startsWith('/api/admin/products')
    || baseUrl.startsWith('/api/seller');
  const requestedStoreId = String(req.query.storeId || '').trim();
  if (baseUrl.startsWith('/api/admin/products') && requestedStoreId && isMasterOwner(req.user)) {
    if (!mongoose.isValidObjectId(requestedStoreId)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid store');
    req.tenantFilter = { storeId: requestedStoreId };
  }
  const archiveMode = String(req.query.archive || '').toLowerCase();
  const archiveFilter = archiveMode === 'only'
    ? { isArchived: true }
    : archiveMode === 'all' ? {} : { isArchived: { $ne: true } };
  const publicVisibility = {
    $and: [
      { isActive: true, isArchived: { $ne: true } },
      { $or: [{ publishAt: { $exists: false } }, { publishAt: null }, { publishAt: { $lte: new Date() } }] },
    ],
  };
  const query = catalogQuery(req, isAdminRequest ? archiveFilter : publicVisibility);
  const dynamicFilterKeys = Object.keys(req.query || {}).filter((key) => key.startsWith('attr_'));
  const catalogConfiguration = req.query.search || dynamicFilterKeys.length
    ? await readConfiguration(req.store?._id)
    : null;
  const configuredAttributes = collectConfiguredAttributes(catalogConfiguration?.structure);
  const searchableAttributes = configuredAttributes.filter((attribute) => attribute.searchable).map((attribute) => attribute.key);
  if (req.query.search) query.$or = [
    { name: { $regex: escapeRegex(String(req.query.search)), $options: 'i' } },
    { sku: { $regex: escapeRegex(String(req.query.search)), $options: 'i' } },
    { fabric: { $regex: escapeRegex(String(req.query.search)), $options: 'i' } },
    { occasion: { $regex: escapeRegex(String(req.query.search)), $options: 'i' } },
    ...searchableAttributes.map((key) => ({ [`attributeValues.${key}`]: { $regex: escapeRegex(String(req.query.search)), $options: 'i' } })),
  ];
  const filterableAttributes = new Set(configuredAttributes.filter((attribute) => attribute.filterable).map((attribute) => attribute.key));
  dynamicFilterKeys.forEach((queryKey) => {
    const attributeKey = queryKey.slice(5);
    if (!filterableAttributes.has(attributeKey)) return;
    const values = String(req.query[queryKey] || '').split(',').map((value) => value.trim()).filter(Boolean).slice(0, 30);
    if (values.length) query[`attributeValues.${attributeKey}`] = values.length === 1 ? values[0] : { $in: values };
  });
  if (req.query.category) {
    if (mongoose.Types.ObjectId.isValid(req.query.category)) {
      query.category = req.query.category;
    } else {
      const category = await Category.findOne(andFilter({
        $or: [
          { slug: req.query.category },
          { previousSlugs: req.query.category },
          { name: { $regex: `^${escapeRegex(req.query.category)}$`, $options: 'i' } },
        ],
      }, req.tenantFilter));
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
  if (req.query.stock === 'low') {
    query.$expr = { $and: [{ $gt: [availableStock, 0] }, stockWarning] };
  }
  if (req.query.status === 'active') query.isActive = true;
  if (req.query.status === 'inactive') query.isActive = false;
  if (req.query.featured === 'true') query.isFeatured = true;
  if (req.query.newArrival === 'true') query.isNewArrival = true;
  if (req.query.bestSeller === 'true') query.isBestSeller = true;
  if (req.query.completeness === 'missing-media') addQueryClause(query, { $or: [{ images: { $exists: false } }, { images: { $size: 0 } }] });
  if (req.query.completeness === 'missing-seo') addQueryClause(query, { $or: [{ metaTitle: { $in: ['', null] } }, { metaDescription: { $in: ['', null] } }] });

  const sortMap = {
    newest: '-createdAt',
    priceLowHigh: 'price',
    priceHighLow: '-price',
    discount: '-discountPercentage',
    rating: '-rating',
    stock: 'stock',
    updated: '-updatedAt',
  };
  const sort = sortMap[req.query.sort] || '-createdAt';
  // Admin designer choices need identifiers and labels, not every image,
  // variant, size chart and description in the catalog.
  const designerCatalogRequest = req.query.customizationOptions === 'true'
    && (String(req.baseUrl || '').startsWith('/api/admin/products') || String(req.baseUrl || '').startsWith('/api/seller'));
  if (designerCatalogRequest) {
    // The designer only needs identifiers and labels. Keep this bounded so a
    // large catalogue cannot freeze the editor or send full product payloads.
    const optionLimit = Math.max(25, Math.min(500, Number(req.query.optionLimit) || 250));
    return res.json(await Product.find(query).select('_id name slug').sort(sort).limit(optionLimit).lean());
  }
  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 24, maxLimit: 100 });
    const [items, total] = await Promise.all([
      Product.find(query).populate('category').sort(sort).skip(skip).limit(limit),
      Product.countDocuments(query),
    ]);
    const response = buildPaginatedResponse(items.map((product) => normalizeProductResponse(product, req)), { page, limit, total });
    if (req.query.includeSummary === 'true') response.summary = await getCatalogSummary(req);
    return res.json(response);
  }
  const products = await Product.find(query).populate('category').sort(sort);
  res.json(products.map((product) => normalizeProductResponse(product, req)));
});

exports.checkDuplicates = asyncHandler(async (req, res) => {
  const name = String(req.query.name || '').trim().slice(0, 160);
  const sku = String(req.query.sku || '').trim().slice(0, 100);
  const barcode = String(req.query.barcode || '').trim().slice(0, 100);
  const excludeId = mongoose.Types.ObjectId.isValid(req.query.excludeId) ? req.query.excludeId : null;
  if (!name && !sku && !barcode) return res.json({ hasConflict: false, conflicts: [] });
  const conflicts = await findProductConflicts(req, { name, sku, barcode, excludeId });
  res.json({ hasConflict: conflicts.some((item) => item.blocking), conflicts });
});

async function getCatalogSummary(req) {
  const current = catalogQuery(req, { isArchived: { $ne: true } });
  const archived = catalogQuery(req, { isArchived: true });
  const low = catalogQuery(req, {
    isArchived: { $ne: true },
    $expr: { $and: [{ $gt: [availableStock, 0] }, stockWarning] },
  });
  const out = catalogQuery(req, { isArchived: { $ne: true }, stock: { $lte: 0 } });
  const [total, active, lowStock, outOfStock, archivedCount, value] = await Promise.all([
    Product.countDocuments(current),
    Product.countDocuments(catalogQuery(req, { isArchived: { $ne: true }, isActive: true })),
    Product.countDocuments(low),
    Product.countDocuments(out),
    Product.countDocuments(archived),
    Product.aggregate([
      { $match: current },
      { $group: { _id: null, retailValue: { $sum: { $multiply: [{ $ifNull: ['$price', 0] }, { $ifNull: ['$stock', 0] }] } }, costValue: { $sum: { $multiply: [{ $ifNull: ['$costPrice', 0] }, { $ifNull: ['$stock', 0] }] } } } },
    ]),
  ]);
  return { total, active, low: lowStock, out: outOfStock, archived: archivedCount, retailValue: value[0]?.retailValue || 0, costValue: value[0]?.costValue || 0 };
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addQueryClause(query, clause) {
  query.$and = [...(Array.isArray(query.$and) ? query.$and : []), clause];
}

function collectConfiguredAttributes(structure = {}) {
  const definitions = new Map((structure.attributes || []).map((attribute) => [attribute.key, attribute]));
  (structure.categoryDefinitions || []).forEach((category) => (category.attributes || []).forEach((attribute) => {
    if (attribute && typeof attribute === 'object' && attribute.key) definitions.set(attribute.key, { ...(definitions.get(attribute.key) || {}), ...attribute });
  }));
  return Array.from(definitions.values());
}

exports.getProductBySlug = asyncHandler(async (req, res) => {
  const scoped = catalogQuery(req, {
    $and: [
      { isActive: true, isArchived: { $ne: true } },
      { $or: [{ publishAt: { $exists: false } }, { publishAt: null }, { publishAt: { $lte: new Date() } }] },
    ],
  });
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
});

exports.getProductById = asyncHandler(async (req, res) => {
  const product = await Product.findOne(catalogQuery(req, { _id: req.params.id })).populate('category');
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json(normalizeProductResponse(product, req));
});

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
  const categoryName = await getCategoryName(basePayload.category, req);
  if (basePayload.category && !categoryName) return res.status(400).json({ message: 'Choose a category from this store' });
  const variantError = validateVariantPayload(basePayload.variants);
  if (variantError) return res.status(400).json({ message: variantError });
  const identityError = await validateUniqueProductIdentity(req, basePayload);
  if (identityError) return res.status(409).json({ message: identityError });
  const payload = applyVariantPayload(normalizeProductSizing(basePayload, categoryName));
  const error = validateProduct(payload);
  if (error) return res.status(400).json({ message: error });
  const sizingError = validateProductSizing(payload, categoryName);
  if (sizingError) return res.status(400).json({ message: sizingError });
  const productData = normalizeProductPayload({ ...payload, slug: slugify(payload.slug || payload.name) });
  if (Number(productData.stock || 0) > 0) {
    productData.lastInventoryChangeAt = new Date();
    productData.lastInventoryChangedBy = req.user?._id;
  }
  const product = await runInTransaction(async (session) => {
    const created = session
      ? (await Product.create([productData], { session }))[0]
      : await Product.create(productData);
    try {
      await recordOpeningInventory(created, { userId: req.user?._id, reference: 'Product create' }, session);
    } catch (ledgerError) {
      if (!session) await Product.deleteOne({ _id: created._id }).catch(() => null);
      throw ledgerError;
    }
    return created;
  });
  logAudit({ req, action: 'PRODUCT_CREATE', entityType: 'Product', entityId: product._id, storeId: product.storeId, after: auditSnapshot(product, PRODUCT_AUDIT_FIELDS) });
  res.status(201).json(normalizeProductResponse(product, req));
});

exports.updateProduct = asyncHandler(async (req, res) => {
  const existingProduct = await Product.findOne(catalogQuery(req, { _id: req.params.id }));
  if (!existingProduct) return res.status(404).json({ message: 'Product not found' });
  assertStoreOwned(existingProduct, req);
  const expectedInventoryRevision = req.body?.inventoryRevision === undefined ? null : Number(req.body.inventoryRevision);
  if (expectedInventoryRevision !== null && (!Number.isSafeInteger(expectedInventoryRevision) || expectedInventoryRevision < 0)) return res.status(400).json({ message: 'Inventory revision must be a whole number of zero or more' });
  if (expectedInventoryRevision !== null && expectedInventoryRevision !== Number(existingProduct.inventoryRevision || 0)) {
    throw new ApiError('INVENTORY_CHANGED', 'Inventory changed after this product was opened. Reload the product before saving.');
  }
  const basePayload = await applyProductStructure(withStoreId({ ...req.body, images: sanitizeProductImages(req.body.images) }, req), existingProduct);
  delete basePayload.inventoryRevision;
  if (basePayload.price !== undefined && basePayload.originalPrice === undefined && Number(basePayload.price) > Number(existingProduct.originalPrice || 0)) {
    basePayload.originalPrice = basePayload.price;
  }
  const categoryName = await getCategoryName(basePayload.category || existingProduct.category, req);
  if ((basePayload.category || existingProduct.category) && !categoryName) return res.status(400).json({ message: 'Choose a category from this store' });
  const variantError = validateVariantPayload(basePayload.variants);
  if (variantError) return res.status(400).json({ message: variantError });
  const identityError = await validateUniqueProductIdentity(req, basePayload, existingProduct._id);
  if (identityError) return res.status(409).json({ message: identityError });
  const payload = applyVariantPayload(normalizeProductSizing(basePayload, categoryName));
  const validationPayload = { ...existingProduct.toObject(), ...payload };
  const error = validateProduct(validationPayload, false);
  if (error) return res.status(400).json({ message: error });
  const sizingError = validateProductSizing(validationPayload, categoryName);
  if (sizingError) return res.status(400).json({ message: sizingError });
  const nextImages = Array.isArray(payload.images) && payload.images.length ? payload.images : existingProduct.images || [];
  const product = await runInTransaction(async (session) => {
    const currentRevision = Number(existingProduct.inventoryRevision || 0);
    const inventoryChanged = inventoryFingerprint(existingProduct) !== inventoryFingerprint({ ...existingProduct.toObject(), ...payload });
    const update = normalizeProductPayload({
      ...payload,
      slug: slugify(payload.slug || existingProduct.slug || payload.name || existingProduct.name),
      images: nextImages,
      storeId: existingProduct.storeId,
      inventoryRevision: currentRevision + (inventoryChanged ? 1 : 0),
      ...(inventoryChanged ? { lastInventoryChangeAt: new Date(), lastInventoryChangedBy: req.user?._id } : {}),
    });
    const saved = await Product.findOneAndUpdate(
      catalogQuery(req, withInventoryRevision({ _id: req.params.id }, currentRevision)),
      update,
      { new: true, runValidators: true, session },
    );
    if (!saved) throw new ApiError('INVENTORY_CHANGED', 'Product or inventory changed while this update was being saved. Reload and try again.');
    const movements = inventoryMovementDrafts(existingProduct, saved, req);
    try {
      if (movements.length) await InventoryTransaction.insertMany(movements, session ? { session } : {});
    } catch (error) {
      if (!session) {
        await Product.updateOne(
          { _id: saved._id, inventoryRevision: currentRevision + (inventoryChanged ? 1 : 0) },
          { $set: { stock: existingProduct.stock, variants: existingProduct.variants, inventoryRevision: currentRevision } },
        ).catch(() => null);
      }
      throw error;
    }
    return saved;
  });
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

exports.deleteProduct = asyncHandler(async (req, res) => {
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
});

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

exports.updateStock = asyncHandler(async (req, res) => {
  const rawStock = req.body?.stock;
  const stock = Number(rawStock);
  if (!['number', 'string'].includes(typeof rawStock) || String(rawStock).trim() === '' || !Number.isSafeInteger(stock) || stock < 0) {
    return res.status(400).json({ message: 'Stock must be a whole number of zero or more' });
  }
  const result = await applyInventoryAdjustment({
    productId: req.params.id,
    variantId: req.body.variantId,
    mode: 'SET',
    bucket: 'SELLABLE',
    quantity: stock,
    expectedStock: req.body.expectedStock,
    expectedRevision: req.body.expectedRevision,
    reasonCode: String(req.body.reasonCode || 'CORRECTION').toUpperCase(),
    reason: req.body.reason || (req.body.variantId ? 'Manual variant stock update' : 'Manual stock update'),
    note: req.body.note,
    reference: req.body.reference,
    idempotencyKey: req.body.idempotencyKey,
    tenantFilter: req.tenantFilter,
    userId: req.user?._id,
  });
  await logAudit({
    req, action: 'STOCK_UPDATE', entityType: 'Product', entityId: result.product._id, storeId: result.product.storeId,
    before: result.movement ? { stock: result.movement.stockBefore } : {},
    after: result.movement ? { stock: result.movement.stockAfter, variantId: req.body.variantId } : {},
  });
  res.json(result.product);
});

exports.markOutOfStock = asyncHandler(async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ message: 'Confirm before marking every sellable unit out of stock', code: 'CONFIRMATION_REQUIRED' });
  const result = await markProductOutOfStock({
    productId: req.params.id,
    expectedRevision: req.body.expectedRevision,
    reasonCode: String(req.body.reasonCode || 'CORRECTION').toUpperCase(),
    reason: req.body.reason || 'Marked out of stock',
    note: req.body.note,
    reference: req.body.reference,
    idempotencyKey: req.body.idempotencyKey,
    tenantFilter: req.tenantFilter,
    userId: req.user?._id,
  });
  await logAudit({ req, action: 'STOCK_UPDATE', entityType: 'Product', entityId: result.product._id, storeId: result.product.storeId, before: { stock: result.movements.reduce((sum, item) => sum + Math.abs(item.quantity), 0) }, after: { stock: 0 } });
  res.json(result.product);
});

exports.hideProduct = (req, res, next) => {
  req.body = { ...req.body, isActive: false };
  return exports.updateStatus(req, res, next);
};

exports.restoreProduct = asyncHandler(async (req, res) => {
  const product = await Product.findOne(catalogQuery(req, { _id: req.params.id, isArchived: true }));
  if (!product) return res.status(404).json({ message: 'Archived product not found' });
  assertStoreOwned(product, req);
  const before = auditSnapshot(product, ['isActive', 'isArchived', 'deletedAt']);
  product.isArchived = false;
  product.isActive = false;
  product.deletedAt = undefined;
  await product.save();
  logAudit({ req, action: 'PRODUCT_RESTORE', entityType: 'Product', entityId: product._id, storeId: product.storeId, before, after: auditSnapshot(product, ['isActive', 'isArchived', 'deletedAt']) });
  res.json(normalizeProductResponse(product, req));
});

exports.duplicateProduct = asyncHandler(async (req, res) => {
  const source = await Product.findOne(catalogQuery(req, { _id: req.params.id, isArchived: { $ne: true } }));
  if (!source) return res.status(404).json({ message: 'Product not found' });
  assertStoreOwned(source, req);
  const data = source.toObject({ depopulate: true });
  for (const key of ['_id', '__v', 'createdAt', 'updatedAt', 'deletedAt', 'sourceDraftId']) delete data[key];
  const baseName = `${source.name} copy`;
  data.name = baseName;
  data.slug = await uniqueValue(req, 'slug', slugify(baseName));
  data.sku = await uniqueValue(req, 'sku', `${source.sku || 'PRODUCT'}-COPY`);
  if (data.barcode) data.barcode = '';
  data.isActive = false;
  data.isArchived = false;
  data.publishAt = null;
  // A catalog copy is a new SKU workflow, not a physical stock receipt.
  // Starting at zero prevents the same units being sellable twice.
  data.stock = 0;
  data.variants = (data.variants || []).map((variant) => ({ ...variant, stock: 0, nonSellableStock: { damaged: 0, quarantine: 0 } }));
  data.nonSellableStock = { damaged: 0, quarantine: 0 };
  data.inventoryRevision = 0;
  data.lastInventoryChangeAt = undefined;
  data.lastInventoryChangedBy = undefined;
  const product = await Product.create(data);
  logAudit({ req, action: 'PRODUCT_DUPLICATE', entityType: 'Product', entityId: product._id, storeId: product.storeId, after: auditSnapshot(product, PRODUCT_AUDIT_FIELDS), summary: `Duplicated from ${source.name}` });
  res.status(201).json(normalizeProductResponse(product, req));
});

exports.bulkUpdateProducts = asyncHandler(async (req, res) => {
  const ids = readProductIds(req.body?.ids);
  const action = String(req.body?.action || '').trim();
  const allowed = new Set(['activate', 'deactivate', 'archive', 'restore', 'out-of-stock', 'feature', 'unfeature', 'best-seller', 'remove-best-seller']);
  if (!allowed.has(action)) return res.status(400).json({ message: 'Choose a valid bulk action' });
  const products = await Product.find(catalogQuery(req, { _id: { $in: ids } }));
  if (products.length !== ids.length) return res.status(404).json({ message: 'One or more products are unavailable. Refresh the catalog and try again.' });
  if (action === 'activate' && products.some((product) => product.isArchived)) {
    return res.status(409).json({ message: 'Restore archived products before making them active.' });
  }
  for (const product of products) {
    assertStoreOwned(product, req);
    const before = auditSnapshot(product, ['isActive', 'isArchived', 'deletedAt', 'stock', 'variants', 'isFeatured', 'isBestSeller']);
    if (action === 'out-of-stock') {
      const result = await markProductOutOfStock({
        productId: product._id,
        reasonCode: 'CORRECTION',
        reason: 'Bulk marked out of stock',
        idempotencyKey: `catalog-bulk:${req.requestId || Date.now()}:${product._id}`,
        tenantFilter: req.tenantFilter,
        userId: req.user?._id,
      });
      await logAudit({ req, action: 'PRODUCT_BULK_OUT_OF_STOCK', entityType: 'Product', entityId: product._id, storeId: product.storeId, before, after: auditSnapshot(result.product, ['stock', 'variants']) });
      continue;
    }
    if (action === 'activate') {
      product.isActive = true;
    } else if (action === 'deactivate') product.isActive = false;
    else if (action === 'archive') {
      product.isActive = false;
      product.isArchived = true;
      product.deletedAt = product.deletedAt || new Date();
    } else if (action === 'restore') {
      product.isArchived = false;
      product.isActive = false;
      product.deletedAt = undefined;
    } else if (action === 'feature') product.isFeatured = true;
    else if (action === 'unfeature') product.isFeatured = false;
    else if (action === 'best-seller') product.isBestSeller = true;
    else if (action === 'remove-best-seller') product.isBestSeller = false;
    await product.save();
    logAudit({ req, action: `PRODUCT_BULK_${action.replaceAll('-', '_').toUpperCase()}`, entityType: 'Product', entityId: product._id, storeId: product.storeId, before, after: auditSnapshot(product, ['isActive', 'isArchived', 'deletedAt', 'stock', 'variants', 'isFeatured', 'isBestSeller']) });
  }
  res.json({ message: `${products.length} product${products.length === 1 ? '' : 's'} updated`, count: products.length });
});

exports.exportProducts = asyncHandler(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) return res.status(400).json({ message: 'Export contains an invalid product id' });
  const archiveMode = String(req.query.archive || '').toLowerCase();
  const filter = ids.length
    ? { _id: { $in: ids } }
    : archiveMode === 'only' ? { isArchived: true } : { isArchived: { $ne: true } };
  if (req.query.search) filter.$or = [
    { name: { $regex: escapeRegex(String(req.query.search)), $options: 'i' } },
    { sku: { $regex: escapeRegex(String(req.query.search)), $options: 'i' } },
    { barcode: { $regex: escapeRegex(String(req.query.search)), $options: 'i' } },
  ];
  if (req.query.category && mongoose.Types.ObjectId.isValid(req.query.category)) filter.category = req.query.category;
  if (req.query.status === 'active') filter.isActive = true;
  if (req.query.status === 'inactive') filter.isActive = false;
  if (req.query.stock === 'out') filter.stock = { $lte: 0 };
  if (req.query.stock === 'low') {
    filter.$expr = { $and: [{ $gt: [availableStock, 0] }, stockWarning] };
  }
  const products = await Product.find(catalogQuery(req, filter)).populate('category').sort('-updatedAt').limit(5000).lean();
  res.json({
    generatedAt: new Date().toISOString(),
    items: products.map((product) => ({
      id: String(product._id), name: product.name, sku: product.sku || '', barcode: product.barcode || '',
      category: product.category?.name || '', subCategory: product.subCategory || '', price: product.price || 0,
      originalPrice: product.originalPrice || 0, costPrice: product.costPrice || 0, gstRate: product.gstRate || 0,
      hsnCode: product.hsnCode || '', stock: product.stock || 0, lowStockAlert: product.lowStockAlert ?? 5,
      active: Boolean(product.isActive), archived: Boolean(product.isArchived), updatedAt: product.updatedAt,
    })),
  });
});

function readProductIds(value) {
  if (!Array.isArray(value) || !value.length) throw Object.assign(new Error('Select at least one product'), { statusCode: 400 });
  const ids = [...new Set(value.map((id) => String(id || '').trim()))];
  if (ids.length > 100) throw Object.assign(new Error('Update up to 100 products at a time'), { statusCode: 400 });
  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) throw Object.assign(new Error('One or more product ids are invalid'), { statusCode: 400 });
  return ids;
}

async function uniqueValue(req, field, baseValue) {
  const base = String(baseValue || 'product').trim();
  let candidate = base;
  let suffix = 1;
  while (await Product.exists(catalogQuery(req, { [field]: candidate }))) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

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
  if (!Number.isFinite(Number(data.originalPrice)) || Number(data.originalPrice) <= 0) return 'Original price is required';
  if (!Number.isFinite(Number(data.price)) || Number(data.price) <= 0) return 'Selling price is required';
  if (Number(data.price) > Number(data.originalPrice)) return 'Selling price cannot exceed original price';
  if (!Number.isSafeInteger(Number(data.stock)) || Number(data.stock) < 0) return 'Stock must be a whole number of zero or more';
  if (data.lowStockAlert !== undefined && (!Number.isSafeInteger(Number(data.lowStockAlert)) || Number(data.lowStockAlert) < 0)) return 'Low-stock alert must be a whole number of zero or more';
  if (data.costPrice !== undefined && (!Number.isFinite(Number(data.costPrice)) || Number(data.costPrice) < 0)) return 'Cost price must be zero or more';
  if (data.gstRate !== undefined && (!Number.isFinite(Number(data.gstRate)) || Number(data.gstRate) < 0 || Number(data.gstRate) > 100)) return 'GST rate must be between 0 and 100';
  if (data.reorderQuantity !== undefined && (!Number.isSafeInteger(Number(data.reorderQuantity)) || Number(data.reorderQuantity) < 0)) return 'Reorder quantity must be a whole number of zero or more';
  if (data.shippingWeightKg !== undefined && (!Number.isFinite(Number(data.shippingWeightKg)) || Number(data.shippingWeightKg) < 0 || Number(data.shippingWeightKg) > 1000)) return 'Packed unit weight must be between 0 and 1000 kg';
  if (data.returnWindowDays !== undefined && data.returnWindowDays !== null && data.returnWindowDays !== '' && (!Number.isSafeInteger(Number(data.returnWindowDays)) || Number(data.returnWindowDays) < 0 || Number(data.returnWindowDays) > 365)) return 'Product return window must be a whole number between 0 and 365 days';
  if (data.packageDimensions && ['lengthCm', 'widthCm', 'heightCm'].some((field) => !Number.isFinite(Number(data.packageDimensions[field] || 0)) || Number(data.packageDimensions[field] || 0) < 0 || Number(data.packageDimensions[field] || 0) > 1000)) return 'Package dimensions must be between 0 and 1000 cm';
  for (const key of ['restockAt', 'publishAt', 'saleStartAt', 'saleEndAt']) if (data[key] && Number.isNaN(new Date(data[key]).getTime())) return 'Choose valid product schedule dates';
  if (data.saleStartAt && data.saleEndAt && new Date(data.saleStartAt) >= new Date(data.saleEndAt)) return 'Sale end must be after sale start';
  const hasSaleSchedule = Number(data.salePrice) > 0;
  if (hasSaleSchedule) {
    if (!Number.isFinite(Number(data.salePrice)) || Number(data.salePrice) <= 0) return 'Scheduled sale price is required';
    if (Number(data.salePrice) >= Number(data.price)) return 'Scheduled sale price must be lower than the regular selling price';
    if (!data.saleStartAt || !data.saleEndAt) return 'Choose both sale start and sale end';
  }
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

async function validateUniqueProductIdentity(req, payload = {}, excludeId) {
  const conflicts = await findProductConflicts(req, {
    sku: String(payload.sku || '').trim(),
    barcode: String(payload.barcode || '').trim(),
    excludeId,
  });
  const skuConflict = conflicts.find((item) => item.reason === 'SKU');
  if (skuConflict) return `SKU is already used by ${skuConflict.name}`;
  const barcodeConflict = conflicts.find((item) => item.reason === 'Barcode');
  if (barcodeConflict) return `Barcode is already used by ${barcodeConflict.name}`;
  return '';
}

async function findProductConflicts(req, { name = '', sku = '', barcode = '', excludeId = null } = {}) {
  const base = { isArchived: { $ne: true }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) };
  const checks = [];
  if (sku) checks.push(['SKU', Product.findOne(catalogQuery(req, { ...base, sku: { $regex: `^${escapeRegex(sku)}$`, $options: 'i' } })).select('_id name sku barcode').lean()]);
  if (barcode) checks.push(['Barcode', Product.findOne(catalogQuery(req, { ...base, barcode })).select('_id name sku barcode').lean()]);
  if (name.length >= 3) checks.push(['Name', Product.findOne(catalogQuery(req, { ...base, name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } })).select('_id name sku barcode').lean()]);
  const resolved = await Promise.all(checks.map(async ([reason, query]) => [reason, await query]));
  const rows = new Map();
  for (const [reason, product] of resolved) {
    if (!product) continue;
    const key = String(product._id);
    const current = rows.get(key) || { id: key, name: product.name, sku: product.sku || '', barcode: product.barcode || '', reasons: [], blocking: false };
    current.reasons.push(reason);
    current.reason = current.reason || reason;
    if (reason !== 'Name') current.blocking = true;
    rows.set(key, current);
  }
  return [...rows.values()];
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
