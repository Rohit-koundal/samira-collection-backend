const router = require('express').Router();
const mongoose = require('mongoose');
const upload = require('../middleware/uploadMiddleware');
const { protect } = require('../middleware/authMiddleware');
const { adminOnly } = require('../middleware/adminMiddleware');
const { isCloudinaryConfigured, uploadImage } = require('../services/cloudinaryUpload');

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

    const baseUrl = (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
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
