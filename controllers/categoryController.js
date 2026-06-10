const Category = require('../models/Category');
const slugify = require('../utils/slugify');

exports.getCategories = async (req, res) => {
  const query = req.query.admin === 'true' ? {} : { isActive: true };
  res.json(await Category.find(query).sort('displayOrder name'));
};
exports.createCategory = async (req, res) => {
  if (!req.body.name || req.body.name.trim().length < 2) return res.status(400).json({ message: 'Category name is required' });
  if (req.body.image?.startsWith('data:')) return res.status(400).json({ message: 'Category image must be an uploaded file URL' });
  const slug = req.body.slug?.trim() || slugify(req.body.name);
  res.status(201).json(await Category.create({ ...req.body, name: req.body.name.trim(), slug }));
};
exports.updateCategory = async (req, res) => {
  if (req.body.image?.startsWith('data:')) return res.status(400).json({ message: 'Category image must be an uploaded file URL' });
  const payload = { ...req.body };
  if (payload.name) payload.name = payload.name.trim();
  if (payload.slug) payload.slug = payload.slug.trim() || slugify(payload.name);
  res.json(await Category.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true }));
};
exports.deleteCategory = async (req, res) => { await Category.findByIdAndDelete(req.params.id); res.json({ message: 'Category deleted' }); };
