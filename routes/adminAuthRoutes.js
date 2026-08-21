const router = require('express').Router();
const auth = require('../controllers/authController');
const dashboard = require('../controllers/dashboardController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');

router.post('/login', auth.login);
router.get('/profile', protect, adminOnly, auth.profile);
router.get('/dashboard/stats', protect, adminOnly, dashboard.stats);
router.get('/dashboard/overview', protect, adminOnly, dashboard.overview);
router.get('/dashboard/recent-orders', protect, adminOnly, dashboard.recentOrders);
router.get('/dashboard/low-stock', protect, adminOnly, dashboard.lowStock);
router.get('/inventory/low-stock', protect, adminOnly, dashboard.lowStock);
router.get('/reports/sales', protect, adminOnly, dashboard.salesReport);
router.get('/reports/products', protect, adminOnly, dashboard.productReport);
// Customer listing, blocking and role changes live in customerAdminRoutes,
// which is mounted earlier on /api/admin/customers and carries the
// self-lockout and id validation guards.

module.exports = router;
