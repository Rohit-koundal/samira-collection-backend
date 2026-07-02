const router = require('express').Router();
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');
const draft = require('../controllers/productDraftController');

router.post('/bulk-upload', protect, adminOnly, draft.bulkUploadMiddleware.array('images', 30), draft.bulkUpload);
router.post('/publish-selected', protect, adminOnly, draft.publishSelected);
router.get('/', protect, adminOnly, draft.listDrafts);
router.get('/:id', protect, adminOnly, draft.getDraft);
router.put('/:id', protect, adminOnly, draft.updateDraft);
router.delete('/:id', protect, adminOnly, draft.deleteDraft);

module.exports = router;
