const router = require('express').Router();
const wishlist = require('../controllers/wishlistController');
const { protect } = require('../middleware/authMiddleware');
router.use(protect);
router.get('/', wishlist.getWishlist);
router.post('/:productId', wishlist.addWishlist);
router.delete('/:productId', wishlist.removeWishlist);
module.exports = router;
