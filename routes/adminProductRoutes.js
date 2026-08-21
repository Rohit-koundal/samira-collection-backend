const router = require('express').Router();
const product = require('../controllers/productController');

router.get('/', product.getProducts);
router.get('/quick-analyze/status', product.getQuickAddVisionStatus);
router.post('/quick-analyze', product.analyzeQuickAdd);
router.get('/:id', product.getProductById);
router.post('/', product.createProduct);
router.put('/:id', product.updateProduct);
router.delete('/:id', product.deleteProduct);
router.patch('/:id/status', product.updateStatus);
router.patch('/:id/stock', product.updateStock);
router.patch('/:id/mark-out-of-stock', product.markOutOfStock);
router.patch('/:id/hide', product.hideProduct);

module.exports = router;
