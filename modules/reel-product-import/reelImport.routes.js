const router = require('express').Router();
const controller = require('./reelImport.controller');
const { requireReelImportEnabled } = require('../../config/reelImport');
const { reelUpload } = require('./reelImport.upload');

router.use(requireReelImportEnabled);
router.get('/config', controller.getConfig);
router.get('/', controller.listImports);
router.post('/', reelUpload.single('video'), controller.createImport);
router.get('/:jobId/candidates', controller.listCandidates);
router.patch('/:jobId/candidates/:candidateId', controller.patchCandidate);
router.post('/:jobId/candidates/merge', controller.mergeCandidates);
router.post('/:jobId/candidates/:candidateId/split', controller.splitCandidate);
router.post('/:jobId/candidates/:candidateId/move-frame', controller.moveFrame);
router.post('/:jobId/create-drafts', controller.createDrafts);
router.post('/:jobId/retry', controller.retryImport);
router.post('/:jobId/cancel', controller.cancelImport);
router.get('/:jobId', controller.getImport);
router.delete('/:jobId', controller.deleteImport);

module.exports = router;
