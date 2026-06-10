const Coupon = require('../models/Coupon');

exports.getCoupons = async (req, res) => {
  const query = req.query.admin === 'true' ? {} : { isActive: true };
  res.json(await Coupon.find(query).sort('-createdAt'));
};
exports.createCoupon = async (req, res) => {
  const error = validateCoupon(req.body);
  if (error) return res.status(400).json({ message: error });
  res.status(201).json(await Coupon.create(req.body));
};
exports.updateCoupon = async (req, res) => res.json(await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true }));
exports.deleteCoupon = async (req, res) => { await Coupon.findByIdAndDelete(req.params.id); res.json({ message: 'Coupon deleted' }); };
exports.applyCoupon = async (req, res) => {
  const coupon = await Coupon.findOne({ code: req.body.code?.toUpperCase(), isActive: true });
  if (!coupon || coupon.expiryDate < new Date()) return res.status(400).json({ message: 'Invalid or expired coupon' });
  const amount = Number(req.body.cartTotal || req.body.amount || 0);
  if (amount < coupon.minOrderAmount) return res.status(400).json({ message: 'Minimum order amount not met' });
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) return res.status(400).json({ message: 'Coupon usage limit reached' });
  const raw = coupon.type === 'Percentage' ? (amount * coupon.discountValue) / 100 : coupon.discountValue;
  const discountAmount = Math.min(raw, coupon.maxDiscountAmount || raw, amount);
  res.json({ success: true, couponCode: coupon.code, discountAmount, message: `${coupon.code} applied`, coupon, discount: discountAmount });
};

function validateCoupon(data) {
  if (!data.code) return 'Coupon code is required';
  if (Number(data.discountValue) <= 0) return 'Discount value must be positive';
  if (data.type === 'Percentage' && Number(data.discountValue) > 100) return 'Percentage discount cannot exceed 100';
  if (Number(data.minOrderAmount) < 0) return 'Minimum order amount cannot be negative';
  if (!data.expiryDate) return 'Expiry date is required';
  return '';
}
