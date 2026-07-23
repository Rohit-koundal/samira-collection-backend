const router = require('express').Router();
const variantGroups = require('../controllers/variantGroupController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');

router.get('/', variantGroups.listGroups);
router.get('/:id', variantGroups.getGroupByIdPublic);
router.post('/', protect, adminOnly, variantGroups.createGroup);
router.put('/:id', protect, adminOnly, variantGroups.updateGroup);
router.delete('/:id', protect, adminOnly, variantGroups.deleteGroup);
router.post('/:id/add-products', protect, adminOnly, variantGroups.addProducts);
router.post('/:id/remove-products', protect, adminOnly, variantGroups.removeProducts);

module.exports = router;
