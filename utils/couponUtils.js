const Coupon = require('../models/Coupon');

async function incrementCouponUsage(couponCode) {
  if (!couponCode) return;
  await Coupon.findOneAndUpdate(
    { code: String(couponCode).toUpperCase() },
    { $inc: { usedCount: 1 } },
  );
}

module.exports = {
  incrementCouponUsage,
};
