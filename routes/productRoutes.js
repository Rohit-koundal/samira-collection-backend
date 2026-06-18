const router = require('express').Router();
const product = require('../controllers/productController');

router.get('/', product.getProducts);
router.get('/:slug', product.getProductBySlug);
router.post('/', product.createProduct);
router.put('/:id', product.updateProduct);
router.delete('/:id', product.deleteProduct);
router.patch('/:id/status', product.updateStatus);
router.patch('/:id/stock', product.updateStock);

module.exports = router;
