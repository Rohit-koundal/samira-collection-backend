const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { reelImportConfig } = require('../../config/reelImport');

const tempRoot = path.join(os.tmpdir(), 'samira-reel-uploads');
fs.mkdirSync(tempRoot, { recursive: true });

const supported = new Map([
  ['.mp4', new Set(['video/mp4'])],
  ['.mov', new Set(['video/quicktime'])],
  ['.webm', new Set(['video/webm'])],
]);

const reelUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      callback(null, tempRoot);
    },
    filename(req, file, callback) {
      callback(null, crypto.randomUUID() + '.upload');
    },
  }),
  fileFilter(req, file, callback) {
    try {
      validateDeclaredFile(file);
      callback(null, true);
    } catch (error) {
      callback(error);
    }
  },
  limits: {
    fileSize: reelImportConfig().maxFileSizeMb * 1024 * 1024,
    files: 1,
    fields: 5,
    parts: 8,
    fieldNameSize: 80,
    fieldSize: 8 * 1024,
    headerPairs: 100,
  },
  preservePath: false,
});

function validateDeclaredFile(file = {}) {
  const originalName = String(file.originalname || '');
  if (!originalName || originalName.length > 180 || originalName.includes('\0')) {
    throw uploadError('Video filename is invalid', 'INVALID_VIDEO_FILENAME');
  }
  const baseName = path.basename(originalName.replace(/\\/g, '/'));
  if (baseName !== originalName || baseName === '.' || baseName === '..') {
    throw uploadError('Video filename must not contain a path', 'INVALID_VIDEO_FILENAME');
  }
  const extension = path.extname(baseName).toLowerCase();
  const declaredMime = String(file.mimetype || '').toLowerCase();
  if (!supported.get(extension)?.has(declaredMime)) {
    throw uploadError('Only MP4, MOV, and WebM videos are supported', 'UNSUPPORTED_VIDEO_FORMAT');
  }
}

function safeOriginalFilename(value = '') {
  const extension = path.extname(String(value)).toLowerCase();
  const base = path.basename(String(value), extension)
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 100) || 'product-reel';
  return base + (supported.has(extension) ? extension : '');
}

function uploadError(message, code) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

module.exports = { reelUpload, safeOriginalFilename, tempRoot, validateDeclaredFile };
