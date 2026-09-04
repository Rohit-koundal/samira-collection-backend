const mongoose = require('mongoose');
const Review = require('../models/Review');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, forbidden, notFound } = require('../utils/apiError');
const {
  buildPaginatedResponse,
  optionalString,
  readPagination,
  requireBoolean,
  requireObjectId,
  requireRating,
  wantsPagination,
} = require('../utils/validators');
const { andFilter } = require('../services/storeService');

const REVIEWABLE_ORDER_STATUSES = ['Delivered', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'];

async function recomputeProductRating(productId) {
  const stats = await Review.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(String(productId)), isVisible: true } },
    { $group: { _id: '$product', rating: { $avg: '$rating' }, numReviews: { $sum: 1 } } },
  ]);
  await Product.updateOne({ _id: productId }, {
    rating: stats[0] ? Math.round(Number(stats[0].rating) * 10) / 10 : 0,
    numReviews: stats[0]?.numReviews || 0,
  });
}

function purchaseFilter(userId, productId, tenantFilter = {}) {
  return andFilter({
    user: userId,
    orderStatus: { $in: REVIEWABLE_ORDER_STATUSES },
    'orderItems.product': productId,
  }, tenantFilter);
}

async function findDeliveredPurchase(userId, productId, tenantFilter) {
  return Order.findOne(purchaseFilter(userId, productId, tenantFilter)).sort('-deliveredAt -createdAt');
}

async function requireDeliveredPurchase(userId, productId, tenantFilter) {
  const order = await findDeliveredPurchase(userId, productId, tenantFilter);
  if (!order) throw forbidden('You can leave a review after you have received this product from a delivered order');
  return order;
}

async function requireProduct(productId, tenantFilter) {
  const product = await Product.findOne(andFilter({ _id: productId }, tenantFilter)).select('_id storeId');
  if (!product) throw notFound('Product not found');
  return product;
}

function reviewResponse(review) {
  if (!review) return null;
  const value = typeof review.toObject === 'function' ? review.toObject() : { ...review };
  delete value.helpfulBy;
  value.helpfulCount = Math.max(0, Number(value.helpfulCount || 0));
  return value;
}

exports.createReview = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  const rating = requireRating(req.body?.rating);
  const comment = optionalString(req.body?.comment, 'comment', { max: 2000 });
  const title = optionalString(req.body?.title, 'title', { max: 120 });
  const product = await requireProduct(productId, req.tenantFilter);
  const order = await requireDeliveredPurchase(req.user._id, productId, req.tenantFilter);

  const existing = await Review.findOne({ user: req.user._id, product: productId });
  if (existing) throw new ApiError('DUPLICATE_REQUEST', 'You have already reviewed this product. You can edit your existing review.');

  try {
    const review = await Review.create({
      user: req.user._id,
      product: productId,
      order: order._id,
      rating,
      title,
      comment,
      verifiedPurchase: true,
      storeId: order.storeId || product.storeId,
    });
    await recomputeProductRating(productId);
    res.status(201).json(reviewResponse(review));
  } catch (error) {
    if (error?.code === 11000) {
      throw new ApiError('DUPLICATE_REQUEST', 'You have already reviewed this product. You can edit your existing review.');
    }
    throw error;
  }
});

exports.updateReview = asyncHandler(async (req, res) => {
  const reviewId = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: reviewId }, req.user.role === 'admin' ? req.tenantFilter : {}));
  if (!review) throw notFound('Review not found');
  if (String(review.user) !== String(req.user._id) && req.user.role !== 'admin') {
    throw forbidden('You can only edit your own review');
  }

  if (req.body?.rating !== undefined) review.rating = requireRating(req.body.rating);
  if (req.body?.comment !== undefined) review.comment = optionalString(req.body.comment, 'comment', { max: 2000 });
  if (req.body?.title !== undefined) review.title = optionalString(req.body.title, 'title', { max: 120 });
  await review.save();
  await recomputeProductRating(review.product);
  res.json(reviewResponse(review));
});

exports.getMyReview = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  await requireProduct(productId, req.tenantFilter);
  const review = await Review.findOne(andFilter({ user: req.user._id, product: productId }, req.tenantFilter));
  res.json(reviewResponse(review));
});

exports.getReviewEligibility = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  await requireProduct(productId, req.tenantFilter);
  const [existingReview, order, helpfulReviews] = await Promise.all([
    Review.findOne(andFilter({ user: req.user._id, product: productId }, req.tenantFilter)),
    findDeliveredPurchase(req.user._id, productId, req.tenantFilter),
    Review.find(andFilter({ product: productId, helpfulBy: req.user._id }, req.tenantFilter)).select('_id'),
  ]);

  const canEdit = Boolean(existingReview);
  const hasDeliveredPurchase = Boolean(order);
  res.json({
    canReview: canEdit || hasDeliveredPurchase,
    canEdit,
    hasDeliveredPurchase,
    orderId: order?._id || existingReview?.order || null,
    existingReview: reviewResponse(existingReview),
    helpfulReviewIds: helpfulReviews.map((review) => String(review._id)),
    reason: canEdit || hasDeliveredPurchase ? null : 'DELIVERY_REQUIRED',
    message: canEdit
      ? 'You can edit your existing review.'
      : hasDeliveredPurchase
        ? 'Your delivered purchase is eligible for a verified review.'
        : 'You can review this product after it has been delivered.',
  });
});

exports.getReviewSummary = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  await requireProduct(productId, req.tenantFilter);
  const rows = await Review.aggregate([
    { $match: andFilter({ product: new mongoose.Types.ObjectId(productId), isVisible: true }, req.tenantFilter) },
    { $group: { _id: '$rating', count: { $sum: 1 } } },
  ]);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  rows.forEach((row) => { distribution[row._id] = Number(row.count || 0); });
  const total = Object.values(distribution).reduce((sum, count) => sum + count, 0);
  const weightedTotal = Object.entries(distribution).reduce((sum, [rating, count]) => sum + Number(rating) * count, 0);
  const recommended = distribution[4] + distribution[5];
  res.json({
    average: total ? Math.round((weightedTotal / total) * 10) / 10 : 0,
    total,
    distribution,
    recommendationPercentage: total ? Math.round((recommended / total) * 100) : 0,
  });
});

exports.getReviews = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  await requireProduct(productId, req.tenantFilter);
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: 50, maxLimit: 100 });
  const filter = andFilter({ product: productId, isVisible: true }, req.tenantFilter);
  if (req.query.rating !== undefined && String(req.query.rating).trim()) filter.rating = requireRating(req.query.rating);
  const sort = req.query.sort === 'highest'
    ? { rating: -1, createdAt: -1 }
    : req.query.sort === 'lowest'
      ? { rating: 1, createdAt: -1 }
      : req.query.sort === 'helpful'
        ? { helpfulCount: -1, createdAt: -1 }
        : { createdAt: -1 };
  const finder = () => Review.find(filter)
    .select('-helpfulBy')
    .populate('user', 'name')
    .sort(sort);
  const items = await finder().skip(skip).limit(limit);
  if (!wantsPagination(req.query)) return res.json(items.map(reviewResponse));
  const total = await Review.countDocuments(filter);
  return res.json(buildPaginatedResponse(items.map(reviewResponse), { page, limit, total }));
});

exports.toggleHelpful = asyncHandler(async (req, res) => {
  const reviewId = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOne(andFilter({ _id: reviewId, isVisible: true }, req.tenantFilter)).select('+helpfulBy');
  if (!review) throw notFound('Review not found');
  if (String(review.user) === String(req.user._id)) throw forbidden('You cannot mark your own review as helpful');

  const alreadyHelpful = (review.helpfulBy || []).some((userId) => String(userId) === String(req.user._id));
  if (alreadyHelpful) review.helpfulBy.pull(req.user._id);
  else review.helpfulBy.addToSet(req.user._id);
  review.helpfulCount = review.helpfulBy.length;
  await review.save();
  res.json({ reviewId: review._id, helpful: !alreadyHelpful, helpfulCount: review.helpfulCount });
});

exports.featuredReviews = asyncHandler(async (req, res) => {
  const { limit, skip } = readPagination(req.query, { defaultLimit: 3, maxLimit: 12 });
  const reviews = await Review.find(andFilter({
    isVisible: true,
    comment: { $exists: true, $nin: ['', null] },
  }, req.tenantFilter))
    .select('-helpfulBy')
    .populate('user', 'name')
    .populate('product', 'name slug')
    .sort({ rating: -1, helpfulCount: -1, createdAt: -1 })
    .skip(skip)
    .limit(limit);
  res.json(reviews.map(reviewResponse));
});

exports.adminReviews = asyncHandler(async (req, res) => {
  const { limit, skip } = readPagination(req.query, { defaultLimit: 200, maxLimit: 500 });
  const reviews = await Review.find(req.tenantFilter || {})
    .select('-helpfulBy')
    .populate('user product')
    .sort('-createdAt')
    .skip(skip)
    .limit(limit);
  res.json(reviews.map(reviewResponse));
});

exports.toggleVisibility = asyncHandler(async (req, res) => {
  const reviewId = requireObjectId(req.params.id, 'review id');
  const isVisible = requireBoolean(req.body?.isVisible, 'isVisible');
  const review = await Review.findOneAndUpdate(andFilter({ _id: reviewId }, req.tenantFilter), { isVisible }, { new: true });
  if (!review) throw notFound('Review not found');
  await recomputeProductRating(review.product);
  res.json(reviewResponse(review));
});

exports.deleteReview = asyncHandler(async (req, res) => {
  const reviewId = requireObjectId(req.params.id, 'review id');
  const review = await Review.findOneAndDelete(andFilter({ _id: reviewId }, req.tenantFilter));
  if (!review) throw notFound('Review not found');
  await recomputeProductRating(review.product);
  res.json({ success: true, message: 'Review deleted' });
});

exports.recomputeProductRating = recomputeProductRating;
