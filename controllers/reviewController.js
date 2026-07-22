const Order = require('../models/Order');
const Product = require('../models/Product');
const Review = require('../models/Review');
const {
  assertObjectId,
  cleanMultilineText,
  paginationEnvelope,
  parsePagination,
} = require('../utils/requestValidation');

exports.createReview = async (req, res) => {
  const productId = assertObjectId(req.params.productId, 'product id');
  const product = await Product.findById(productId).select('_id');
  if (!product) return res.status(404).json({ message: 'Product not found' });
  const purchase = await findDeliveredPurchase(req.user._id, productId, req.body.orderId);
  if (!purchase) {
    return res.status(403).json({ message: 'A delivered purchase is required to review this product', code: 'VERIFIED_PURCHASE_REQUIRED' });
  }
  const existing = await Review.findOne({ user: req.user._id, product: productId });
  if (existing) return res.status(409).json({ message: 'You have already reviewed this product', code: 'REVIEW_ALREADY_EXISTS' });
  const payload = normalizeReviewPayload(req.body);
  const review = await Review.create({
    ...payload,
    user: req.user._id,
    product: productId,
    order: purchase._id,
    verifiedPurchase: true,
  });
  await recalculateProductRating(productId);
  return res.status(201).json(review);
};

exports.updateReview = async (req, res) => {
  const productId = assertObjectId(req.params.productId, 'product id');
  const review = await Review.findOne({ user: req.user._id, product: productId });
  if (!review) return res.status(404).json({ message: 'Review not found' });
  Object.assign(review, normalizeReviewPayload(req.body));
  await review.save();
  await recalculateProductRating(productId);
  return res.json(review);
};

exports.deleteOwnReview = async (req, res) => {
  const productId = assertObjectId(req.params.productId, 'product id');
  const review = await Review.findOneAndDelete({ user: req.user._id, product: productId });
  if (!review) return res.status(404).json({ message: 'Review not found' });
  await recalculateProductRating(productId);
  return res.json({ message: 'Review deleted' });
};

exports.getReviews = async (req, res) => {
  const productId = assertObjectId(req.params.productId, 'product id');
  const { page, limit, skip, sort } = parsePagination(req.query, {
    defaultLimit: 10,
    maxLimit: 50,
    allowedSorts: ['createdAt', 'rating'],
  });
  const filter = { product: productId, isVisible: true };
  const [items, total] = await Promise.all([
    Review.find(filter).populate('user', 'name').sort(sort).skip(skip).limit(limit).lean(),
    Review.countDocuments(filter),
  ]);
  return res.json(paginationEnvelope(items, total, page, limit));
};

exports.adminReviews = async (req, res) => {
  const { page, limit, skip, sort } = parsePagination(req.query, {
    allowedSorts: ['createdAt', 'rating', 'isVisible'],
  });
  const filter = {};
  if (req.query.visible === 'true') filter.isVisible = true;
  if (req.query.visible === 'false') filter.isVisible = false;
  const [items, total] = await Promise.all([
    Review.find(filter).populate('user product').sort(sort).skip(skip).limit(limit),
    Review.countDocuments(filter),
  ]);
  return res.json(paginationEnvelope(items, total, page, limit));
};

exports.toggleVisibility = async (req, res) => {
  assertObjectId(req.params.id, 'review id');
  if (typeof req.body.isVisible !== 'boolean') return res.status(400).json({ message: 'isVisible must be a boolean' });
  const review = await Review.findByIdAndUpdate(req.params.id, {
    isVisible: req.body.isVisible,
    moderationNote: cleanMultilineText(req.body.moderationNote, { field: 'moderationNote', max: 500 }),
  }, { new: true, runValidators: true });
  if (!review) return res.status(404).json({ message: 'Review not found' });
  await recalculateProductRating(review.product);
  return res.json(review);
};

exports.deleteReview = async (req, res) => {
  assertObjectId(req.params.id, 'review id');
  const review = await Review.findByIdAndDelete(req.params.id);
  if (!review) return res.status(404).json({ message: 'Review not found' });
  await recalculateProductRating(review.product);
  return res.json({ message: 'Review deleted' });
};

async function findDeliveredPurchase(userId, productId, requestedOrderId) {
  const filter = {
    user: userId,
    'orderItems.product': productId,
    $or: [
      { orderStatus: 'Delivered' },
      { statusTimeline: { $elemMatch: { status: 'Delivered' } } },
    ],
  };
  if (requestedOrderId) filter._id = assertObjectId(requestedOrderId, 'order id');
  return Order.findOne(filter).sort('-createdAt').select('_id');
}

function normalizeReviewPayload(body = {}) {
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    const error = new Error('Rating must be an integer from 1 to 5');
    error.statusCode = 400;
    throw error;
  }
  const images = body.images === undefined ? [] : normalizeImages(body.images);
  return {
    rating,
    comment: cleanMultilineText(body.comment, { field: 'comment', max: 2000 }),
    images,
    isVisible: true,
  };
}

function normalizeImages(value) {
  if (!Array.isArray(value) || value.length > 5) {
    const error = new Error('Review images must contain at most 5 uploaded images');
    error.statusCode = 400;
    throw error;
  }
  return value.map((entry) => {
    const url = String(typeof entry === 'string' ? entry : entry?.url || '').trim();
    if (!/^https:\/\//i.test(url) && !/^\/uploads\/[a-z0-9._-]+$/i.test(url)) {
      const error = new Error('Review image must reference a secure uploaded image');
      error.statusCode = 400;
      throw error;
    }
    return { url, publicId: typeof entry === 'object' ? String(entry.publicId || '').slice(0, 300) : undefined };
  });
}

async function recalculateProductRating(productId) {
  const summary = await Review.aggregate([
    { $match: { product: Product.db.base.Types.ObjectId.createFromHexString(String(productId)), isVisible: true } },
    { $group: { _id: '$product', rating: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Product.updateOne({ _id: productId }, {
    $set: {
      rating: Math.round(Number(summary[0]?.rating || 0) * 10) / 10,
      numReviews: Number(summary[0]?.count || 0),
    },
  });
}

exports.recalculateProductRating = recalculateProductRating;
