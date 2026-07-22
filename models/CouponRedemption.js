const mongoose = require('mongoose');

const couponRedemptionSchema = new mongoose.Schema({
  coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  code: { type: String, required: true },
  discountAmount: { type: Number, required: true, min: 0 },
  subtotal: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['Reserved', 'Redeemed', 'Released', 'Reversed'], default: 'Reserved' },
  reservedUntil: Date,
  redeemedAt: Date,
  releasedAt: Date,
  releaseReason: String,
}, { timestamps: true });

couponRedemptionSchema.index({ coupon: 1, order: 1 }, { unique: true });
couponRedemptionSchema.index({ coupon: 1, user: 1, status: 1 });
couponRedemptionSchema.index({ status: 1, reservedUntil: 1 });

module.exports = mongoose.model('CouponRedemption', couponRedemptionSchema);
