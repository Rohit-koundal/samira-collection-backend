const Category = require('../models/Category');
const slugify = require('../utils/slugify');
const { assertObjectId, cleanMultilineText, cleanString, pick } = require('../utils/requestValidation');

const CATEGORY_FIELDS = ['name', 'slug', 'image', 'description', 'isActive', 'displayOrder'];

exports.getCategories = async (req, res) => {
  const isAdmin = ['admin', 'owner'].includes(req.user?.role)
    && String(req.baseUrl || '').startsWith('/api/admin/categories');
  return res.json(await Category.find(isAdmin ? {} : { isActive: true }).sort('displayOrder name'));
};

exports.getCategoryById = async (req, res) => {
  assertObjectId(req.params.id, 'category id');
  const category = await Category.findById(req.params.id);
  if (!category) return res.status(404).json({ message: 'Category not found' });
  return res.json(category);
};

exports.createCategory = async (req, res) => {
  const payload = normalizeCategoryPayload(pick(req.body, CATEGORY_FIELDS), true);
  return res.status(201).json(await Category.create(payload));
};

exports.updateCategory = async (req, res) => {
  assertObjectId(req.params.id, 'category id');
  const existing = await Category.findById(req.params.id);
  if (!existing) return res.status(404).json({ message: 'Category not found' });
  const payload = normalizeCategoryPayload(pick(req.body, CATEGORY_FIELDS), false);
  if (payload.image === undefined || payload.image === '') payload.image = existing.image || '';
  const updated = await Category.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
  return res.json(updated);
};

exports.deleteCategory = async (req, res) => {
  assertObjectId(req.params.id, 'category id');
  const category = await Category.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!category) return res.status(404).json({ message: 'Category not found' });
  return res.json({ message: 'Category archived', category });
};

function normalizeCategoryPayload(data, creating) {
  const payload = { ...data };
  if (creating || payload.name !== undefined) {
    payload.name = cleanString(payload.name, { field: 'name', min: 2, max: 100, required: true });
  }
  if (payload.slug !== undefined || creating) {
    payload.slug = slugify(cleanString(payload.slug || payload.name, { field: 'slug', min: 2, max: 120, required: true }));
  }
  if (payload.description !== undefined) payload.description = cleanMultilineText(payload.description, { field: 'description', max: 2000 });
  if (payload.image !== undefined) {
    payload.image = String(payload.image || '').trim();
    if (payload.image && !isSafeMediaUrl(payload.image)) throw validationError('Category image must be a secure uploaded file URL');
  }
  if (payload.displayOrder !== undefined) {
    const order = Number(payload.displayOrder);
    if (!Number.isSafeInteger(order) || order < 0 || order > 10000) throw validationError('Invalid display order');
    payload.displayOrder = order;
  }
  if (payload.isActive !== undefined && typeof payload.isActive !== 'boolean') throw validationError('isActive must be a boolean');
  return payload;
}

function isSafeMediaUrl(value) {
  return /^https:\/\//i.test(value) || /^\/uploads\/[a-z0-9._-]+$/i.test(value);
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}
