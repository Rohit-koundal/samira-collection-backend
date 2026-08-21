const mongoose = require('mongoose');
const Review = require('../models/Review');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, forbidden, notFound } = require('../utils/apiError');
const { optionalString, readPagination, requireBoolean, requireObjectId, requireRating } = require('../utils/validators');

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

async function requireDeliveredPurchase(userId, productId) {
  const order = await Order.findOne({
    user: userId,
    orderStatus: 'Delivered',
    'orderItems.product': productId,
  }).sort('-createdAt');
  if (!order) {
    throw forbidden('Only customers who received this product can write a review');
  }
  return order;
}

exports.createReview = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  const rating = requireRating(req.body?.rating);
  const comment = optionalString(req.body?.comment, 'comment', { max: 2000 });
  const title = optionalString(req.body?.title, 'title', { max: 120 });
  const order = await requireDeliveredPurchase(req.user._id, productId);

  const existing = await Review.findOne({ user: req.user._id, product: productId });
  if (existing) throw new ApiError('DUPLICATE_REQUEST', 'You have already reviewed this product');

    const review = await Review.create({
    user: req.user._id,
    product: productId,
    order: order._id,
    rating,
    title,
    comment,
    verifiedPurchase: true,
    storeId: order.storeId,
  });
  await recomputeProductRating(productId);
  res.status(201).json(review);
});

exports.updateReview = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'review id');
  const review = await Review.findById(req.params.id);
  if (!review) throw notFound('Review not found');
  if (String(review.user) !== String(req.user._id) && req.user.role !== 'admin') {
    throw forbidden('You can only edit your own review');
  }

  if (req.body?.rating !== undefined) review.rating = requireRating(req.body.rating);
  if (req.body?.comment !== undefined) review.comment = optionalString(req.body.comment, 'comment', { max: 2000 });
  if (req.body?.title !== undefined) review.title = optionalString(req.body.title, 'title', { max: 120 });
  await review.save();
  await recomputeProductRating(review.product);
  res.json(review);
});

exports.getMyReview = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  const review = await Review.findOne({ user: req.user._id, product: productId });
  res.json(review);
});

exports.getReviews = asyncHandler(async (req, res) => {
  const productId = requireObjectId(req.params.productId, 'product id');
  const { limit, skip } = readPagination(req.query, { defaultLimit: 50, maxLimit: 100 });
  res.json(await Review.find({ product: productId, isVisible: true })
    .populate('user', 'name')
    .sort('-createdAt')
    .skip(skip)
    .limit(limit));
});

exports.adminReviews = asyncHandler(async (req, res) => {
  const { limit, skip } = readPagination(req.query, { defaultLimit: 200, maxLimit: 500 });
  res.json(await Review.find().populate('user product').sort('-createdAt').skip(skip).limit(limit));
});

exports.toggleVisibility = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'review id');
  const isVisible = requireBoolean(req.body?.isVisible, 'isVisible');
  const review = await Review.findByIdAndUpdate(req.params.id, { isVisible }, { new: true });
  if (!review) throw notFound('Review not found');
  await recomputeProductRating(review.product);
  res.json(review);
});

exports.deleteReview = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'review id');
  const review = await Review.findByIdAndDelete(req.params.id);
  if (!review) throw notFound('Review not found');
  await recomputeProductRating(review.product);
  res.json({ success: true, message: 'Review deleted' });
});
