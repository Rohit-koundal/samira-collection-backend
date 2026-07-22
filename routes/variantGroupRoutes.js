const router = require('express').Router();
const variantGroups = require('../controllers/variantGroupController');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly, requirePermission } = require('../middleware/adminMiddleware');

router.get('/', variantGroups.listGroups);
router.get('/:id', variantGroups.getGroupByIdPublic);
router.post('/', protect, adminOnly, requirePermission('manage_catalog'), variantGroups.createGroup);
router.put('/:id', protect, adminOnly, requirePermission('manage_catalog'), variantGroups.updateGroup);
router.delete('/:id', protect, adminOnly, requirePermission('manage_catalog'), variantGroups.deleteGroup);
router.post('/:id/add-products', protect, adminOnly, requirePermission('manage_catalog'), variantGroups.addProducts);
router.post('/:id/remove-products', protect, adminOnly, requirePermission('manage_catalog'), variantGroups.removeProducts);

module.exports = router;
