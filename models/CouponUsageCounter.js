const mongoose = require('mongoose');

const couponUsageCounterSchema = new mongoose.Schema({
  coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reservedCount: { type: Number, default: 0, min: 0 },
  redeemedCount: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

couponUsageCounterSchema.index({ coupon: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('CouponUsageCounter', couponUsageCounterSchema);
