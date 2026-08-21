const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  type: { type: String, enum: ['Percentage', 'Flat'], required: true },
  discountValue: { type: Number, required: true },
  minOrderAmount: { type: Number, default: 0 },
  maxDiscountAmount: Number,
  // Optional start date; when unset the coupon is live as soon as it is active.
  validFrom: Date,
  expiryDate: { type: Date, required: true },
  usageLimit: Number,
  usedCount: { type: Number, default: 0 },
  // Empty means "usable with any payment method".
  applicablePaymentMethods: [{ type: String }],
  applicableProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  applicableCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category' }],
  customerLimit: Number,
  firstOrderOnly: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

couponSchema.plugin(storeIdPlugin);
couponSchema.index({ storeId: 1, code: 1 });

module.exports = mongoose.model('Coupon', couponSchema);
