const router = require('express').Router();
const upload = require('../middleware/uploadMiddleware');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');
const mediaStorage = require('../services/mediaStorage');
const { ipIdentifier, rateLimit, userIdentifier } = require('../middleware/rateLimitMiddleware');

router.use(protect, adminOnly);
router.use(rateLimit({
  scope: 'admin_upload',
  limit: 30,
  windowSeconds: 15 * 60,
  identifiers: [ipIdentifier, userIdentifier],
}));

router.post('/', (req, res, next) => {
  upload.imageUpload.array('images', 8)(req, res, async (error) => {
    if (error) return next(error);
    try {
      if (!req.files?.length) return res.status(400).json({ message: 'Select at least one image file' });
      const files = await Promise.all(req.files.map((file) => mediaStorage.uploadImage(file, {
        folder: req.query.folder,
      })));
      return res.status(201).json({ files, provider: mediaStorage.getMediaStorageState().provider });
    } catch (uploadError) {
      return next(uploadError);
    } finally {
      await mediaStorage.cleanupTempFiles(req.files);
    }
  });
});

router.post('/videos', (req, res, next) => {
  upload.videoUpload.array('videos', 2)(req, res, async (error) => {
    if (error) return next(error);
    try {
      if (!req.files?.length) return res.status(400).json({ message: 'Select at least one video file' });
      const files = await Promise.all(req.files.map((file) => mediaStorage.uploadVideo(file, {
        folder: req.query.folder || 'product-videos',
      })));
      return res.status(201).json({ files, provider: mediaStorage.getMediaStorageState().provider });
    } catch (uploadError) {
      return next(uploadError);
    } finally {
      await mediaStorage.cleanupTempFiles(req.files);
    }
  });
});

module.exports = router;
