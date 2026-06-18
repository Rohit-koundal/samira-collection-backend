const router = require('express').Router();
const fs = require('fs/promises');
const upload = require('../middleware/uploadMiddleware');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');
const { isR2Configured, uploadImageToR2 } = require('../services/r2Upload');
const { isCloudinaryConfigured, uploadImage: uploadImageToCloudinary } = require('../services/cloudinaryUpload');
const { buildUploadFileResponse, isLocalRequest } = require('../utils/imageUtils');

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

      if (isR2Configured()) {
        const files = await Promise.all(req.files.map((file) => uploadImageToR2(file)));
        await cleanupTempFiles(req.files);
        return res.status(201).json({ files });
      }

      if (isCloudinaryConfigured()) {
        const files = await Promise.all(req.files.map((file) => uploadImageToCloudinary(file)));
        await cleanupTempFiles(req.files);
        return res.status(201).json({ files });
      }

      const files = req.files.map((file) => buildUploadFileResponse(file, req));
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
