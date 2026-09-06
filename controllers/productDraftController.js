const { asyncHandler } = require('../middleware/validate');
const { applyProductStructure } = require('../services/masterConfigurationService');
const multer = require('multer');
const slugify = require('../utils/slugify');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const { isR2Configured, uploadImageToR2 } = require('../services/r2Upload');
const { isCloudinaryConfigured, uploadImage: uploadImageToCloudinary } = require('../services/cloudinaryUpload');
const { buildUploadFileResponse, isLocalRequest, normalizeProductImages, normalizeProductPayload, sanitizeProductImages } = require('../utils/imageUtils');
const { normalizeProductSizing, validateProductSizing } = require('../services/productSizingService');

exports.bulkUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      cb(null, require('path').join(__dirname, '..', 'uploads'));
    },
    filename(req, file, cb) {
      const safeName = file.originalname.replace(/[^a-z0-9.]+/gi, '-').toLowerCase();
      cb(null, `${Date.now()}-${safeName}`);
    },
  }),
  fileFilter(req, file, cb) {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) return cb(new Error('Only jpg, jpeg, png and webp images are allowed'));
    cb(null, true);
  },
  limits: { fileSize: 2 * 1024 * 1024, files: 30 },
});

exports.bulkUpload = async (req, res, next) => {
  try {
    const uploaded = await uploadDraftImages(req, req.files || []);
    if (!uploaded.length) return res.status(400).json({ success: false, message: 'Please upload at least one image' });

    const drafts = await ProductDraft.insertMany(uploaded.map((file, index) => ({
      name: '',
      slug: uniqueDraftSlug(file.originalName || `draft-${index + 1}`),
      sku: `DRAFT-${Date.now()}-${String(index + 1).padStart(2, '0')}`,
      image: file.url,
      images: [{ url: file.url, publicId: file.publicId, primary: true }],
      videos: [],
      category: undefined,
      subCategory: '',
      price: 0,
      originalPrice: 0,
      sellingPrice: 0,
      stock: 0,
      sizes: [],
      sizingMode: 'auto',
      sizeChartProfile: 'auto',
      sizeChart: { unit: 'in', columns: [], rows: [] },
      sizeFitNotes: '',
      colors: [],
      fabric: '',
      occasion: '',
      tags: [],
      description: '',
      highlights: [],
      status: 'draft',
      createdBy: req.user?._id,
    })));

    cleanupTempFiles(req.files);
    res.status(201).json({ success: true, message: 'Drafts created successfully', data: { drafts: drafts.map(formatDraft) } });
  } catch (error) {
    cleanupTempFiles(req.files);
    next(error);
  }
};

exports.listDrafts = async (req, res) => {
  const drafts = await ProductDraft.find().populate('category').sort('-updatedAt');
  res.json({ success: true, data: drafts.map(formatDraft) });
};

exports.getDraft = async (req, res) => {
  const draft = await ProductDraft.findById(req.params.id).populate('category');
  if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
  res.json({ success: true, data: formatDraft(draft) });
};

exports.updateDraft = async (req, res) => {
  const draft = await ProductDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
  const payload = normalizeDraftPayload(req.body);
  // Imported provenance and publication state are controlled by the server.
  if (['social-import', 'reel-import'].includes(draft.sourceType)) {
    for (const key of ['sourceType', 'sourceSocialImportId', 'sourceJobId', 'sourceCandidateId', 'sourceUrl', 'sourcePlatform', 'createdBy', 'storeId', 'status', 'publishedProductId', 'importContext']) delete payload[key];
  }
  if (payload.name && !payload.slug) payload.slug = uniqueDraftSlug(payload.name, draft._id);
  Object.assign(draft, payload);
  await draft.save();
  await draft.populate('category');
  res.json({ success: true, message: 'Draft updated successfully', data: formatDraft(draft) });
};

exports.deleteDraft = async (req, res) => {
  await ProductDraft.findByIdAndDelete(req.params.id);
  res.json({ success: true, message: 'Draft deleted successfully' });
};

exports.publishSelected = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ success: false, message: 'Please select at least one draft' });

  const drafts = await ProductDraft.find({ _id: { $in: ids } }).populate('category');
  const payloads = new Map();
  for (const draft of drafts) if (!(draft.status === 'published' && draft.publishedProductId)) payloads.set(String(draft._id), await applyProductStructure(buildProductPayloadFromDraft(draft)));
  const errors = drafts.filter((draft) => !(draft.status === 'published' && draft.publishedProductId)).map((draft) => validatePublishDraft(draft, payloads.get(String(draft._id)))).filter(Boolean);
  if (errors.length) {
    return res.status(400).json({ success: false, message: errors[0], data: { errors } });
  }

  const published = [];
  for (const draft of drafts) {
    published.push(await publishPreparedDraft(draft, payloads.get(String(draft._id))));
  }

  res.json({ success: true, message: 'Selected drafts published successfully', data: { products: published.filter(Boolean) } });
});

async function publishPreparedDraft(draft, prepared) {
    if (draft.status === 'published' && draft.publishedProductId) {
      return Product.findById(draft.publishedProductId);
    }
    const productPayload = prepared || await prepareImportedDraft(draft);
    if (draft.sourceType && !productPayload.sku) productPayload.sku = `IMPORT-${String(draft._id).slice(-10).toUpperCase()}`;
    productPayload.slug = await ensureUniqueProductSlug(productPayload.slug || productPayload.name, draft._id);
    if (productPayload.sku) {
      productPayload.sku = await ensureUniqueSku(productPayload.sku, draft._id);
    }
    let product;
    if (['social-import', 'reel-import'].includes(draft.sourceType)) {
      product = await Product.findOne({ sourceDraftId: draft._id });
      if (!product) {
        try { product = await Product.create({ ...normalizeProductPayload(productPayload), sourceDraftId: draft._id }); }
        catch (error) { if (error.code !== 11000) throw error; product = await Product.findOne({ sourceDraftId: draft._id }); if (!product) throw error; }
      }
    } else product = await Product.create(normalizeProductPayload(productPayload));
    draft.status = 'published';
    draft.publishedProductId = product._id;
    await draft.save();
    return product;
}

async function prepareImportedDraft(draft) {
  if (draft.category && !draft.category.name) await draft.populate('category');
  const payload = await applyProductStructure(buildProductPayloadFromDraft(draft));
  const message = validatePublishDraft(draft, payload);
  if (message) throw Object.assign(new Error(message), { statusCode: 400 });
  return payload;
}

exports.prepareImportedDraft = prepareImportedDraft;
exports.publishPreparedDraft = publishPreparedDraft;

function formatDraft(draft) {
  const data = typeof draft.toObject === 'function' ? draft.toObject() : { ...draft };
  data.id = String(data._id || data.id);
  if (data.attributeValues instanceof Map) data.attributeValues = Object.fromEntries(data.attributeValues);
  return data;
}

function normalizeDraftPayload(body = {}) {
  const payload = { ...body };
  if (typeof payload.images === 'string') {
    try {
      payload.images = JSON.parse(payload.images);
    } catch {
      payload.images = [];
    }
  }
  if (typeof payload.videos === 'string') {
    try {
      payload.videos = JSON.parse(payload.videos);
    } catch {
      payload.videos = [];
    }
  }
  if (typeof payload.tags === 'string') payload.tags = splitList(payload.tags);
  if (typeof payload.sizes === 'string') payload.sizes = splitList(payload.sizes);
  if (typeof payload.colors === 'string') payload.colors = splitList(payload.colors);
  if (typeof payload.highlights === 'string') payload.highlights = splitList(payload.highlights);
  if (payload.images) payload.images = sanitizeProductImages(payload.images);
  if (payload.price !== undefined) payload.price = Number(payload.price);
  if (payload.originalPrice !== undefined) payload.originalPrice = Number(payload.originalPrice);
  if (payload.sellingPrice !== undefined) payload.sellingPrice = Number(payload.sellingPrice);
  if (payload.stock !== undefined) payload.stock = Number(payload.stock);
  if (payload.sizeChart) payload.sizeChart = normalizeSizeChart(payload.sizeChart);
  return payload;
}

function buildProductPayloadFromDraft(draft) {
  const data = typeof draft.toObject === 'function' ? draft.toObject() : { ...draft };
  const sellingPrice = Number(data.sellingPrice ?? data.price ?? 0);
  const originalPrice = Number(data.originalPrice ?? sellingPrice);
  return normalizeProductSizing({
    ...(data.storeId ? { storeId: data.storeId } : {}),
    name: data.name,
    attributeValues: data.attributeValues,
    slug: data.slug || slugify(data.name || 'product'),
    sku: data.sku,
    brand: data.brand || '',
    shortDescription: data.shortDescription || '',
    description: data.description || '',
    category: data.category?._id || data.category || undefined,
    subCategory: data.subCategory || '',
    price: sellingPrice,
    originalPrice,
    discountPercentage: originalPrice > sellingPrice ? Math.round(((originalPrice - sellingPrice) / originalPrice) * 100) : 0,
    images: data.images || (data.image ? [{ url: data.image, primary: true }] : []),
    videos: data.videos || [],
    sizes: data.sizes || [],
    sizingMode: data.sizingMode || 'auto',
    sizeChartProfile: data.sizeChartProfile || 'auto',
    sizeChart: normalizeSizeChart(data.sizeChart),
    sizeFitNotes: data.sizeFitNotes || '',
    colors: data.colors || [],
    fabric: data.fabric || '',
    occasion: data.occasion || '',
    stock: Number(data.stock || 0),
    tags: data.tags || [],
    highlights: data.highlights || [],
    careInstructions: data.careInstructions || '',
    returnPolicy: data.returnPolicy || '',
    metaTitle: data.metaTitle || '',
    metaDescription: data.metaDescription || '',
    metaKeywords: data.metaKeywords || '',
    isFeatured: Boolean(data.isFeatured),
    isNewArrival: Boolean(data.isNewArrival),
    isBestSeller: Boolean(data.isBestSeller),
    showOnHomepage: Boolean(data.showOnHomepage),
    showInTrending: Boolean(data.showInTrending),
    showInFestive: Boolean(data.showInFestive),
    isActive: true,
  }, data.category?.name || '');
}

function validatePublishDraft(draft, prepared) {
  if (['social-import', 'reel-import'].includes(draft.sourceType) && (!Number.isFinite(draft.stock) || !Number.isInteger(draft.stock) || draft.stock < 0)) return `Draft "${draft.name}" needs a whole-number stock quantity`;
  if (draft.sourceType === 'social-import' && (!Number.isFinite(draft.sellingPrice ?? draft.price) || (draft.sellingPrice ?? draft.price) <= 0)) return `Draft "${draft.name}" needs a valid selling price`;
  if (!draft?.name || String(draft.name).trim().length < 3) return `Draft "${draft?.slug || draft?._id}" needs a product name`;
  if (!draft.category) return `Draft "${draft.name}" needs a category`;
  const sellingPrice = Number(draft.sellingPrice ?? draft.price);
  const originalPrice = Number(draft.originalPrice ?? sellingPrice);
  if (!sellingPrice) return `Draft "${draft.name}" needs a selling price`;
  if (Number(draft.stock) < 0) return `Draft "${draft.name}" has invalid stock`;
  if (!Array.isArray(draft.images) || !draft.images.length) return `Draft "${draft.name}" needs at least one image`;
  if (sellingPrice > originalPrice) return `Draft "${draft.name}" selling price cannot exceed original price`;
  const sizingError = validateProductSizing(prepared || buildProductPayloadFromDraft(draft), draft.category?.name || '');
  if (sizingError) return `Draft "${draft.name}": ${sizingError}`;
  return '';
}

async function ensureUniqueProductSlug(baseSlug, draftId) {
  const cleanBase = slugify(baseSlug || `draft-${draftId}`);
  let candidate = cleanBase;
  let suffix = 1;
  while (await Product.exists({ slug: candidate })) {
    suffix += 1;
    candidate = `${cleanBase}-${suffix}`;
  }
  return candidate;
}

async function ensureUniqueSku(baseSku, draftId) {
  const cleanBase = String(baseSku || `DRAFT-${draftId}`).trim();
  let candidate = cleanBase;
  let suffix = 1;
  while (await Product.exists({ sku: candidate })) {
    suffix += 1;
    candidate = `${cleanBase}-${suffix}`;
  }
  return candidate;
}

function uniqueDraftSlug(value, draftId) {
  return `${slugify(value || 'draft')}-${String(draftId || Date.now()).slice(-6)}`;
}

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeSizeChart(value = {}) {
  const allowedFields = ['acrossShoulder', 'sleeveLength', 'bust', 'chest', 'waist', 'frontLength', 'bottomLength', 'hips', 'outseamLength', 'inseamLength'];
  const columns = (Array.isArray(value?.columns) ? value.columns : []).filter((field) => allowedFields.includes(field));
  const rows = (Array.isArray(value?.rows) ? value.rows : []).map((row) => {
    const next = { size: String(row?.size || '').trim() };
    columns.forEach((field) => {
      const measurement = Number(row?.[field]);
      if (Number.isFinite(measurement) && measurement > 0) next[field] = measurement;
    });
    return next;
  }).filter((row) => row.size);
  return { unit: value?.unit === 'cm' ? 'cm' : 'in', columns, rows };
}

async function uploadDraftImages(req, files) {
  if (!Array.isArray(files) || !files.length) return [];
  const responses = [];
  if (isR2Configured()) {
    for (const file of files) responses.push(await uploadImageToR2(file, { folder: 'products' }));
  } else if (isCloudinaryConfigured()) {
    for (const file of files) responses.push(await uploadImageToCloudinary(file));
  } else {
    for (const file of files) responses.push(buildUploadFileResponse(file, req));
  }
  return responses;
}

async function cleanupTempFiles(files = []) {
  const fs = require('fs/promises');
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => null)));
}
