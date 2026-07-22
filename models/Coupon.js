const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  type: { type: String, enum: ['Percentage', 'Flat'], required: true },
  discountValue: { type: Number, required: true, min: 0 },
  minOrderAmount: { type: Number, default: 0, min: 0 },
  maxDiscountAmount: { type: Number, min: 0 },
  startDate: { type: Date, default: Date.now },
  expiryDate: { type: Date, required: true },
  usageLimit: { type: Number, min: 1 },
  perCustomerUsageLimit: { type: Number, min: 1, default: 1 },
  usedCount: { type: Number, default: 0, min: 0 },
  reservedCount: { type: Number, default: 0, min: 0, select: false },
  applicableProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  applicableCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category' }],
  excludedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  firstOrderOnly: { type: Boolean, default: false },
  allowedPaymentMethods: [{ type: String, enum: ['COD', 'Razorpay', 'UPI', 'CARD', 'NETBANKING', 'WALLET'] }],
  customers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isPrivate: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

couponSchema.index({ isActive: 1, isPrivate: 1, startDate: 1, expiryDate: 1 });

module.exports = mongoose.model('Coupon', couponSchema);
