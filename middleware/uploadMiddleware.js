const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const uploadDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

function createStorage() {
  return multer.diskStorage({
    destination(req, file, cb) {
      cb(null, uploadDir);
    },
    filename(req, file, cb) {
      cb(null, `${Date.now()}-${crypto.randomBytes(16).toString('hex')}.upload`);
    },
  });
}

function createUpload({ allowedTypes, fileSize, files, validateMetadata }) {
  return multer({
    storage: createStorage(),
    fileFilter(req, file, cb) {
      const declaredType = normalizeMime(file.mimetype);
      if (!allowedTypes.has(declaredType)) {
        const error = new Error('Unsupported upload content type');
        error.statusCode = 400;
        error.code = 'UNSUPPORTED_UPLOAD_TYPE';
        return cb(error);
      }
      try {
        validateMetadata?.(file, declaredType);
      } catch (error) {
        return cb(error);
      }
      return cb(null, true);
    },
    limits: {
      fileSize,
      files,
      fields: 10,
      parts: files + 10,
      fieldNameSize: 100,
      fieldSize: 16 * 1024,
      headerPairs: 100,
    },
    preservePath: false,
  });
}

const MODEL_LIMITS = Object.freeze({
  files: 2,
  glbBytes: 25 * 1024 * 1024,
  usdzBytes: 50 * 1024 * 1024,
  totalBytes: 60 * 1024 * 1024,
});

const MODEL_MIME_TYPES = Object.freeze({
  '.glb': new Set(['model/gltf-binary', 'application/octet-stream']),
  '.usdz': new Set([
    'model/vnd.usdz+zip',
    'model/vnd.usd+zip',
    'application/zip',
    'application/octet-stream',
  ]),
});

function validateModelMetadata(file, declaredType = normalizeMime(file?.mimetype)) {
  const originalName = String(file?.originalname || '');
  if (!originalName || originalName.includes('\0') || originalName.length > 180) {
    throw uploadMetadataError('Model filename is invalid');
  }
  const baseName = path.basename(originalName.replace(/\\/g, '/'));
  if (baseName !== originalName || ['.', '..'].includes(baseName)) {
    throw uploadMetadataError('Model filename must not contain a path');
  }
  const extension = path.extname(baseName).toLowerCase();
  const allowedForExtension = MODEL_MIME_TYPES[extension];
  if (!allowedForExtension || !allowedForExtension.has(declaredType)) {
    throw uploadMetadataError('Only GLB and USDZ model files are supported');
  }
  file.requestedModelExtension = extension.slice(1);
}

function validateModelBatch(files = []) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MODEL_LIMITS.files) {
    throw uploadMetadataError(`Upload between 1 and ${MODEL_LIMITS.files} model files`);
  }
  const seen = new Set();
  let totalBytes = 0;
  for (const file of files) {
    validateModelMetadata(file);
    const extension = file.requestedModelExtension;
    if (seen.has(extension)) {
      throw uploadMetadataError(`Upload at most one .${extension} model`);
    }
    seen.add(extension);
    const size = Number(file.size || 0);
    const formatLimit = extension === 'glb' ? MODEL_LIMITS.glbBytes : MODEL_LIMITS.usdzBytes;
    if (!Number.isSafeInteger(size) || size < 1 || size > formatLimit) {
      const error = uploadMetadataError(`The .${extension} model exceeds its size limit`);
      error.statusCode = 413;
      error.code = 'UPLOAD_TOO_LARGE';
      throw error;
    }
    totalBytes += size;
  }
  if (totalBytes > MODEL_LIMITS.totalBytes) {
    const error = uploadMetadataError('Combined model uploads exceed the size limit');
    error.statusCode = 413;
    error.code = 'UPLOAD_TOO_LARGE';
    throw error;
  }
  return true;
}

function normalizeMime(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function uploadMetadataError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'UNSUPPORTED_UPLOAD_TYPE';
  return error;
}

const imageUpload = createUpload({
  allowedTypes: new Set(['image/jpeg', 'image/png', 'image/webp']),
  fileSize: 5 * 1024 * 1024,
  files: 8,
});

const videoUpload = createUpload({
  allowedTypes: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
  fileSize: 30 * 1024 * 1024,
  files: 2,
});

const modelUpload = createUpload({
  allowedTypes: new Set(Object.values(MODEL_MIME_TYPES).flatMap((types) => [...types])),
  fileSize: MODEL_LIMITS.usdzBytes,
  files: MODEL_LIMITS.files,
  validateMetadata: validateModelMetadata,
});

module.exports = imageUpload;
module.exports.imageUpload = imageUpload;
module.exports.modelUpload = modelUpload;
module.exports.videoUpload = videoUpload;
module.exports.MODEL_LIMITS = MODEL_LIMITS;
module.exports.validateModelBatch = validateModelBatch;
module.exports._private = { normalizeMime, validateModelMetadata };
