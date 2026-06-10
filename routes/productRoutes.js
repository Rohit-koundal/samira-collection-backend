const router = require('express').Router();
const product = require('../controllers/productController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');

router.get('/', product.getProducts);
router.get('/admin/:id', protect, adminOnly, product.getProductById);
router.get('/:slug', product.getProductBySlug);
router.post('/', protect, adminOnly, product.createProduct);
router.put('/:id', protect, adminOnly, product.updateProduct);
router.delete('/:id', protect, adminOnly, product.deleteProduct);
router.patch('/:id/status', protect, adminOnly, product.updateStatus);
router.patch('/:id/stock', protect, adminOnly, product.updateStock);
router.post('/admin/create', protect, adminOnly, product.createProduct);
router.put('/admin/:id', protect, adminOnly, product.updateProduct);
router.delete('/admin/:id', protect, adminOnly, product.deleteProduct);
router.patch('/admin/:id/status', protect, adminOnly, product.updateStatus);
router.patch('/admin/:id/stock', protect, adminOnly, product.updateStock);

module.exports = router;
