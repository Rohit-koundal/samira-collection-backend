const router = require('express').Router();
const mongoose = require('mongoose');
const auth = require('../controllers/authController');
const dashboard = require('../controllers/dashboardController');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly, ownerOnly, requirePermission } = require('../middleware/adminMiddleware');
const { revokeAllUserSessions } = require('../services/refreshSessionService');
const { validateRoleUpdate } = require('../utils/authValidation');

router.post('/login', auth.login);
router.get('/profile', protect, adminOnly, auth.profile);
router.get('/dashboard/stats', protect, adminOnly, requirePermission('view_financial_reports'), dashboard.stats);
router.get('/dashboard/overview', protect, adminOnly, requirePermission('view_financial_reports'), dashboard.overview);
router.get('/dashboard/recent-orders', protect, adminOnly, requirePermission('manage_orders'), dashboard.recentOrders);
router.get('/dashboard/low-stock', protect, adminOnly, requirePermission('manage_inventory'), dashboard.lowStock);
router.get('/inventory/low-stock', protect, adminOnly, requirePermission('manage_inventory'), dashboard.lowStock);
router.get('/reports/sales', protect, adminOnly, requirePermission('view_financial_reports'), dashboard.salesReport);
router.get('/reports/products', protect, adminOnly, requirePermission('view_financial_reports'), dashboard.productReport);
router.get('/reports/summary.csv', protect, adminOnly, requirePermission('view_financial_reports'), dashboard.reportCsv);
router.get('/reports/summary', protect, adminOnly, requirePermission('view_financial_reports'), dashboard.reportSummary);
router.get('/customers', protect, adminOnly, requirePermission('manage_customers'), async (req, res) => {
  res.json(await User.find({ role: 'customer' }).select('-password').sort('-createdAt'));
});
router.patch('/customers/:id/block', protect, adminOnly, requirePermission('manage_customers'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid user ID' });
  if (
    !req.body
    || Object.keys(req.body).some((key) => key !== 'isBlocked')
    || typeof req.body.isBlocked !== 'boolean'
  ) {
    return res.status(400).json({ message: 'isBlocked must be a boolean' });
  }
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'Customer not found' });
  if (user.role !== 'customer') return res.status(403).json({ message: 'Only customer accounts can be blocked here' });
  user.isBlocked = req.body.isBlocked;
  await user.save();
  if (user.isBlocked) await revokeAllUserSessions(user._id, 'account_blocked');
  return res.json(user);
});

router.patch('/users/:id/role', protect, adminOnly, ownerOnly, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid user ID' });
    const { role } = validateRoleUpdate(req.body);
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role === 'owner') return res.status(403).json({ message: 'Owner accounts cannot be changed here' });
    user.role = role;
    user.availableModes = role === 'admin' ? ['customer', 'admin'] : ['customer'];
    user.activeMode = role === 'admin' ? 'admin' : 'customer';
    await user.save();
    await revokeAllUserSessions(user._id, 'role_changed');
    return res.json(user);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: error.message || 'Unable to update role' });
  }
});

module.exports = router;
