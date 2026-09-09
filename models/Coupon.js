const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, uppercase: true, trim: true },
  title: { type: String, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 500 },
  terms: { type: String, trim: true, maxlength: 1200 },
  activationMode: { type: String, enum: ['CODE', 'AUTOMATIC'], default: 'CODE' },
  benefitType: { type: String, enum: ['DISCOUNT', 'FREE_SHIPPING', 'BUY_X_GET_Y'], default: 'DISCOUNT' },
  type: { type: String, enum: ['Percentage', 'Flat'], required: true },
  discountValue: { type: Number, required: true, default: 0, min: 0 },
  buyQuantity: { type: Number, default: 1, min: 1 },
  getQuantity: { type: Number, default: 1, min: 1 },
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
  isPublic: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

couponSchema.plugin(storeIdPlugin);
couponSchema.index({ storeId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Coupon', couponSchema);
