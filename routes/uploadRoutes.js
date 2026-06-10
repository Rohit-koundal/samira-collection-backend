const router = require('express').Router();
const mongoose = require('mongoose');
const upload = require('../middleware/uploadMiddleware');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');
const { isCloudinaryConfigured, uploadImage } = require('../services/cloudinaryUpload');
const { getPublicApiUrl } = require('../utils/imageUtils');

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

router.post('/', protectUpload, adminOnlyUpload, upload.array('images', 8), async (req, res, next) => {
  try {
    if (isCloudinaryConfigured()) {
      const files = await Promise.all((req.files || []).map(uploadImage));
      return res.status(201).json({ files });
    }

    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        message: 'Image uploads need Cloudinary on the deployed server. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.',
        code: 'IMAGE_STORAGE_NOT_CONFIGURED',
      });
    }

    const baseUrl = getPublicApiUrl(req);
    const files = (req.files || []).map((file) => ({
      url: `${baseUrl}/uploads/${file.filename}`,
      publicId: file.filename,
      originalName: file.originalname,
    }));
    return res.status(201).json({ files });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
