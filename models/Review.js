const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const reviewSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  rating: { type: Number, min: 1, max: 5, required: true },
  title: String,
  comment: String,
  photos: [String],
  verifiedPurchase: { type: Boolean, default: false },
  isVisible: { type: Boolean, default: true },
}, { timestamps: true });

reviewSchema.plugin(storeIdPlugin);
reviewSchema.index({ user: 1, product: 1 }, { unique: true });
reviewSchema.index({ product: 1, isVisible: 1, createdAt: -1 });
reviewSchema.index({ storeId: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);
