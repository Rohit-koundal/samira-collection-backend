const mongoose = require('mongoose');
const Product = require('../models/Product');
const { normalizeProductImages } = require('../utils/imageUtils');

function serializeWishlistItem(product, req) {
  if (!product) return null;
  const normalized = normalizeProductImages(product, req);
  return {
    ...normalized,
    id: normalized._id || normalized.id,
  };
}

exports.getWishlist = async (req, res) => {
  if (!canPersistWishlist(req)) {
    return res.json([]);
  }

  const { products, changed } = await resolveStoredWishlistProducts(req.user.wishlist);
  if (changed) {
    req.user.wishlist = products.map((product) => product._id);
    await req.user.save();
  }

  res.json(products.map((product) => serializeWishlistItem(product, req)).filter(Boolean));
};

exports.addWishlist = async (req, res) => {
  if (!canPersistWishlist(req)) {
    return res.status(503).json({ message: 'Wishlist storage is temporarily unavailable.' });
  }

  const product = await resolveWishlistProduct(req.params.productId);
  if (!product) {
    return res.status(404).json({ message: 'Product not found' });
  }

  await reconcileWishlist(req.user);
  req.user.wishlist.addToSet(product._id);
  await req.user.save();
  await req.user.populate({ path: 'wishlist', populate: { path: 'category', select: 'name slug' } });
  res.json((req.user.wishlist || []).map((entry) => serializeWishlistItem(entry, req)).filter(Boolean));
};

exports.removeWishlist = async (req, res) => {
  if (!canPersistWishlist(req)) {
    return res.status(503).json({ message: 'Wishlist storage is temporarily unavailable.' });
  }

  const product = await resolveWishlistProduct(req.params.productId);
  if (!product) {
    return res.status(404).json({ message: 'Product not found' });
  }

  await reconcileWishlist(req.user);
  req.user.wishlist.pull(product._id);
  await req.user.save();
  await req.user.populate({ path: 'wishlist', populate: { path: 'category', select: 'name slug' } });
  res.json((req.user.wishlist || []).map((entry) => serializeWishlistItem(entry, req)).filter(Boolean));
};

function canPersistWishlist(req) {
  return Boolean(req.user && typeof req.user.populate === 'function' && Array.isArray(req.user.wishlist));
}

async function resolveWishlistProduct(productIdOrSlug) {
  const value = String(productIdOrSlug || '').trim();
  if (!value) return null;

  if (mongoose.Types.ObjectId.isValid(value)) {
    const byId = await Product.findById(value).populate('category', 'name slug');
    if (byId) return byId;
  }

  return Product.findOne({ slug: value }).populate('category', 'name slug');
}

async function resolveStoredWishlistProducts(values = []) {
  const entries = Array.isArray(values) ? values.map((value) => String(value || '').trim()).filter(Boolean) : [];
  if (!entries.length) return { products: [], changed: false };

  const validIds = entries.filter((value) => mongoose.Types.ObjectId.isValid(value));
  const slugs = entries.filter((value) => !mongoose.Types.ObjectId.isValid(value));
  const query = [];
  if (validIds.length) query.push({ _id: { $in: validIds } });
  if (slugs.length) query.push({ slug: { $in: slugs } });

  if (!query.length) return { products: [], changed: true };

  const products = await Product.find({ $or: query }).populate('category', 'name slug');
  const byId = new Map(products.map((product) => [String(product._id), product]));
  const bySlug = new Map(products.map((product) => [String(product.slug), product]));

  const ordered = [];
  let changed = false;
  for (const value of entries) {
    const product = byId.get(value) || bySlug.get(value);
    if (!product) {
      changed = true;
      continue;
    }
    ordered.push(product);
    if (!mongoose.Types.ObjectId.isValid(value) || String(product._id) !== value) {
      changed = true;
    }
  }

  return { products: ordered, changed };
}

async function reconcileWishlist(user) {
  if (!Array.isArray(user.wishlist) || !user.wishlist.length) return;
  const { products, changed } = await resolveStoredWishlistProducts(user.wishlist);
  if (!changed) return;
  user.wishlist = products.map((product) => product._id);
}
