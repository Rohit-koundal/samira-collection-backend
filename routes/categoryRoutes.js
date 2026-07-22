const router = require('express').Router();
const category = require('../controllers/categoryController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly, requirePermission } = require('../middleware/adminMiddleware');

router.get('/', category.getCategories);
router.post('/admin/create', protect, adminOnly, requirePermission('manage_catalog'), category.createCategory);
router.put('/admin/:id', protect, adminOnly, requirePermission('manage_catalog'), category.updateCategory);
router.delete('/admin/:id', protect, adminOnly, requirePermission('manage_catalog'), category.deleteCategory);
router.get('/:id', protect, adminOnly, requirePermission('manage_catalog'), category.getCategoryById);
router.post('/', protect, adminOnly, requirePermission('manage_catalog'), category.createCategory);
router.put('/:id', protect, adminOnly, requirePermission('manage_catalog'), category.updateCategory);
router.delete('/:id', protect, adminOnly, requirePermission('manage_catalog'), category.deleteCategory);

module.exports = router;
