const router = require('express').Router();
const category = require('../controllers/categoryController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');

router.get('/', category.getCategories);
router.post('/', protect, adminOnly, category.createCategory);
router.put('/:id', protect, adminOnly, category.updateCategory);
router.delete('/:id', protect, adminOnly, category.deleteCategory);
router.post('/admin/create', protect, adminOnly, category.createCategory);
router.put('/admin/:id', protect, adminOnly, category.updateCategory);
router.delete('/admin/:id', protect, adminOnly, category.deleteCategory);

module.exports = router;
