const router = require('express').Router();
const fs = require('fs/promises');
const path = require('path');
const multer = require('multer');
const upload = require('../middleware/uploadMiddleware');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');
const { isR2Configured, uploadFileToR2, uploadImageToR2 } = require('../services/r2Upload');
const { isLocalRequest } = require('../utils/imageUtils');

const uploadDir = path.join(__dirname, '..', 'uploads');
const videoUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      cb(null, uploadDir);
    },
    filename(req, file, cb) {
      const safeName = file.originalname.replace(/[^a-z0-9.]+/gi, '-').toLowerCase();
      cb(null, `${Date.now()}-${safeName}`);
    },
  }),
  fileFilter(req, file, cb) {
    const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
    if (!allowedTypes.includes(file.mimetype)) return cb(new Error('Only mp4, webm and mov videos are allowed'));
    cb(null, true);
  },
  limits: { fileSize: 20 * 1024 * 1024, files: 2 },
});

function canBypassUploadAuth(req) {
  return isLocalRequest(req);
}

function protectUpload(req, res, next) {
  if (canBypassUploadAuth(req)) return next();
  return protect(req, res, next);
}

function adminOnlyUpload(req, res, next) {
  if (canBypassUploadAuth(req)) return next();
  return adminOnly(req, res, next);
}

router.post('/', protectUpload, adminOnlyUpload, (req, res, next) => {
  upload.array('images', 8)(req, res, async (error) => {
    if (error) return next(error);

    try {
      if (!req.files?.length) {
        return res.status(400).json({ message: 'No images were uploaded. Please select at least one image file.' });
      }

      const uploadFolder = req.query.folder;
      if (!isR2Configured()) {
        await cleanupTempFiles(req.files);
        return res.status(503).json({
          message: 'Product image uploads must use Cloudflare R2 in this environment. Please configure R2 before uploading images.',
          code: 'PERSISTENT_UPLOAD_STORAGE_REQUIRED',
        });
      }

      const files = await Promise.all(req.files.map((file) => uploadImageToR2(file, { folder: uploadFolder })));
      await cleanupTempFiles(req.files);
      return res.status(201).json({ files });
    } catch (uploadError) {
      await cleanupTempFiles(req.files);
      return next(uploadError);
    }
  });
});

router.post('/videos', protectUpload, adminOnlyUpload, (req, res, next) => {
  videoUpload.array('videos', 2)(req, res, async (error) => {
    if (error) return next(error);

    try {
      if (!req.files?.length) {
        return res.status(400).json({ message: 'No videos were uploaded. Please select at least one video file.' });
      }

      const uploadFolder = req.query.folder || 'product-videos';
      if (!isR2Configured()) {
        await cleanupTempFiles(req.files);
        return res.status(503).json({
          message: 'Product video uploads must use Cloudflare R2 in this environment. Please configure R2 before uploading videos.',
          code: 'PERSISTENT_UPLOAD_STORAGE_REQUIRED',
        });
      }

      const files = await Promise.all(req.files.map((file) => uploadFileToR2(file, { folder: uploadFolder })));
      await cleanupTempFiles(req.files);
      return res.status(201).json({ files });
    } catch (uploadError) {
      await cleanupTempFiles(req.files);
      return next(uploadError);
    }
  });
});

async function cleanupTempFiles(files = []) {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => null)));
}

module.exports = router;
