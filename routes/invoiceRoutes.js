const router = require('express').Router();
const invoice = require('../controllers/invoiceController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);
router.get('/:orderId.pdf', invoice.downloadInvoice);
router.get('/:orderId', invoice.getInvoice);

module.exports = router;
