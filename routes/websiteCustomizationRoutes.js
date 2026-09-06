const router = require('express').Router();
const { masterOnly } = require('../config/masterOwner');
router.use(masterOnly);
const customization = require('../controllers/websiteCustomizationController');

router.get('/', customization.getWorkspace);
router.get('/presets', customization.getPresets);
router.get('/themes', customization.listThemes);
router.post('/themes', customization.createTheme);
router.get('/themes/:id', customization.getTheme);
router.put('/themes/:id/draft', customization.updateDraft);
router.post('/themes/:id/discard', customization.discardDraft);
router.post('/themes/:id/duplicate', customization.duplicateTheme);
const { readConfiguration } = require('../services/masterConfigurationService');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const unlocked = asyncHandler(async (_req, _res, next) => {
  if ((await readConfiguration()).locked) throw new ApiError('FORBIDDEN', 'Unlock master configuration before publishing structural theme changes');
  next();
});
router.post('/themes/:id/publish', unlocked, customization.publishTheme);
router.post('/themes/:id/activate', unlocked, customization.activateTheme);
router.delete('/themes/:id', customization.deleteTheme);
router.get('/themes/:id/history', customization.getHistory);
router.post('/themes/:id/history/:versionId/restore', customization.restoreVersion);

module.exports = router;
