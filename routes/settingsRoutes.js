const router = require('express').Router();
const settings = require('../controllers/settingsController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly, requirePermission } = require('../middleware/adminMiddleware');
router.get('/', settings.getSettings);
router.put('/', protect, adminOnly, requirePermission('manage_settings'), settings.updateSettings);
router.put('/admin/update', protect, adminOnly, requirePermission('manage_settings'), settings.updateSettings);
module.exports = router;
