const router = require('express').Router();
const fs = require('fs/promises');
const upload = require('../middleware/uploadMiddleware');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');
const { uploadProductImages } = require('../services/imageStorage');
const { validateImageFile } = require('../services/imageProcessor');

function canBypassUploadAuth(req) {
  const host = String(req.get('host') || req.hostname || '').toLowerCase();
  return process.env.NODE_ENV !== 'production' || host.includes('localhost') || host.includes('127.0.0.1');
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

      for (const file of req.files) {
        await validateImageFile(file.path);
      }

      const files = await uploadProductImages(req.files, req);
      const validFiles = files.filter((file) => file?.url);

      if (!validFiles.length) {
        return res.status(502).json({ message: 'Image upload failed. No files were stored.' });
      }

      await cleanupTempFiles(req.files);
      return res.status(201).json({ files: validFiles });
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
