const router = require('express').Router();
const coupon = require('../controllers/couponController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly, requirePermission } = require('../middleware/adminMiddleware');
const { ipIdentifier, rateLimit, userIdentifier } = require('../middleware/rateLimitMiddleware');
router.get('/', coupon.getCoupons);
router.post('/apply', protect, rateLimit({
  scope: 'coupon_apply',
  limit: 30,
  windowSeconds: 10 * 60,
  identifiers: [ipIdentifier, userIdentifier],
}), coupon.applyCoupon);
router.post('/', protect, adminOnly, requirePermission('manage_marketing'), coupon.createCoupon);
router.put('/:id', protect, adminOnly, requirePermission('manage_marketing'), coupon.updateCoupon);
router.delete('/:id', protect, adminOnly, requirePermission('manage_marketing'), coupon.deleteCoupon);
router.post('/admin/create', protect, adminOnly, requirePermission('manage_marketing'), coupon.createCoupon);
router.put('/admin/:id', protect, adminOnly, requirePermission('manage_marketing'), coupon.updateCoupon);
router.delete('/admin/:id', protect, adminOnly, requirePermission('manage_marketing'), coupon.deleteCoupon);
module.exports = router;
