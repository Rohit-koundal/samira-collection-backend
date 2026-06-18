const Product = require('../models/Product');
const Category = require('../models/Category');
const slugify = require('../utils/slugify');
const mongoose = require('mongoose');
const { normalizeProductImages, normalizeProductPayload, sanitizeProductImages } = require('../utils/imageUtils');

exports.getProducts = async (req, res) => {
  const query = req.query.admin === 'true' ? {} : { isActive: true };
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
  const products = await Product.find(query).populate('category').sort(sortMap[req.query.sort] || '-createdAt');
  res.json(products.map((product) => normalizeProductImages(product, req)));
};

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

exports.getProductBySlug = async (req, res) => {
  const product = mongoose.Types.ObjectId.isValid(req.params.slug)
    ? await Product.findById(req.params.slug).populate('category')
    : await Product.findOne({ slug: req.params.slug }).populate('category');
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json(normalizeProductImages(product, req));
};

exports.getProductById = async (req, res) => {
  const product = await Product.findById(req.params.id).populate('category');
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json(normalizeProductImages(product, req));
};

exports.createProduct = async (req, res) => {
  const payload = { ...req.body, images: sanitizeProductImages(req.body.images) };
  const error = validateProduct(payload);
  if (error) return res.status(400).json({ message: error });
  const product = await Product.create(normalizeProductPayload({ ...payload, slug: payload.slug || slugify(payload.name) }));
  res.status(201).json(normalizeProductImages(product, req));
};

exports.updateProduct = async (req, res) => {
  const existingProduct = await Product.findById(req.params.id);
  if (!existingProduct) return res.status(404).json({ message: 'Product not found' });
  const payload = { ...req.body, images: sanitizeProductImages(req.body.images) };
  const error = validateProduct(payload, false);
  if (error) return res.status(400).json({ message: error });
  const nextImages = Array.isArray(payload.images) && payload.images.length ? payload.images : existingProduct.images || [];
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    normalizeProductPayload({ ...payload, images: nextImages }),
    { new: true, runValidators: true },
  );
  res.json(normalizeProductImages(product, req));
};

exports.deleteProduct = async (req, res) => {
  await Product.findByIdAndDelete(req.params.id);
  res.json({ message: 'Product deleted' });
};

exports.updateStatus = async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, { isActive: req.body.isActive }, { new: true });
  res.json(product);
};

exports.updateStock = async (req, res) => {
  if (Number(req.body.stock) < 0) return res.status(400).json({ message: 'Stock cannot be negative' });
  const product = await Product.findByIdAndUpdate(req.params.id, { stock: req.body.stock }, { new: true });
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
  if (process.env.NODE_ENV === 'production' && Array.isArray(data.images) && data.images.some((image) => isInaccessibleImageUrl(image?.url))) {
    return 'Image URLs must be publicly accessible. Please re-upload images before saving.';
  }
  return '';
}

function isInaccessibleImageUrl(url = '') {
  return /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(String(url));
}
