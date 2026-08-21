const Category = require('../models/Category');
const slugify = require('../utils/slugify');
const { deleteImageFromR2, isR2Configured } = require('../services/r2Upload');
const { andFilter } = require('../services/storeService');

function withStoreId(payload, req) {
  const next = { ...payload };
  delete next.storeId;
  if (req.store?._id) next.storeId = req.store._id;
  return next;
}

exports.getCategories = async (req, res) => {
  const query = andFilter(req.query.admin === 'true' || String(req.baseUrl || '').includes('/seller') ? {} : { isActive: true }, req.tenantFilter);
  res.json(await Category.find(query).sort('displayOrder name'));
};
exports.getCategoryById = async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) return res.status(404).json({ message: 'Category not found' });
  res.json(category);
};
exports.createCategory = async (req, res) => {
  if (!req.body.name || req.body.name.trim().length < 2) return res.status(400).json({ message: 'Category name is required' });
  if (req.body.image?.startsWith('data:')) return res.status(400).json({ message: 'Category image must be an uploaded file URL' });
  const slug = req.body.slug?.trim() || slugify(req.body.name);
  res.status(201).json(await Category.create(withStoreId({ ...req.body, name: req.body.name.trim(), slug }, req)));
};
exports.updateCategory = async (req, res) => {
  const existingCategory = await Category.findById(req.params.id);
  if (!existingCategory) return res.status(404).json({ message: 'Category not found' });
  if (req.body.image?.startsWith('data:')) return res.status(400).json({ message: 'Category image must be an uploaded file URL' });
  const payload = { ...req.body };
  if (payload.name) payload.name = payload.name.trim();
  if (payload.slug) payload.slug = payload.slug.trim() || slugify(payload.name);
  if (payload.image === undefined || payload.image === '') {
    payload.image = existingCategory.image || '';
  }
  const updatedCategory = await Category.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
  if (existingCategory.image && existingCategory.image !== updatedCategory.image) {
    await safeDeleteCategoryImage(existingCategory.image);
  }
  res.json(updatedCategory);
};
exports.deleteCategory = async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (category?.image) await safeDeleteCategoryImage(category.image);
  await Category.findByIdAndDelete(req.params.id);
  res.json({ message: 'Category deleted' });
};

async function safeDeleteCategoryImage(image) {
  if (!isR2Configured()) return;
  try {
    await deleteImageFromR2(image);
  } catch {
    // Ignore cleanup failures so category updates stay safe.
  }
}
