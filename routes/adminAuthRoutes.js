const router = require('express').Router();
const auth = require('../controllers/authController');
const dashboard = require('../controllers/dashboardController');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');

router.post('/login', auth.login);
router.get('/profile', protect, adminOnly, auth.profile);
router.get('/dashboard/stats', protect, adminOnly, dashboard.stats);
router.get('/dashboard/recent-orders', protect, adminOnly, dashboard.recentOrders);
router.get('/dashboard/low-stock', protect, adminOnly, dashboard.lowStock);
router.get('/reports/sales', protect, adminOnly, dashboard.salesReport);
router.get('/reports/products', protect, adminOnly, dashboard.productReport);
router.get('/customers', protect, adminOnly, async (req, res) => {
  res.json(await User.find({ role: 'customer' }).select('-password').sort('-createdAt'));
});
router.patch('/customers/:id/block', protect, adminOnly, async (req, res) => {
  res.json(await User.findByIdAndUpdate(req.params.id, { isBlocked: req.body.isBlocked }, { new: true }).select('-password'));
});

module.exports = router;
