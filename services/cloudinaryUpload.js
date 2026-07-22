const crypto = require('crypto');
const fs = require('fs/promises');

const allowedSubfolders = new Set([
  'products', 'categories', 'banners', 'product-videos', 'product-models',
  'reel-imports/original', 'reel-imports/normalized', 'reel-imports/frames', 'reel-imports/candidates',
]);
const safeContentTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'model/gltf-binary',
  'model/vnd.usdz+zip',
]);

function isCloudinaryConfigured() {
  return Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

async function uploadImage(file, options = {}) {
  return uploadFile(file, 'image', options);
}

async function uploadFile(file, resourceType = 'image', options = {}) {
  if (!isCloudinaryConfigured()) return null;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const folder = resolveCloudinaryFolder(options.folder);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHash('sha1')
    .update(`folder=${folder}&timestamp=${timestamp}${apiSecret}`)
    .digest('hex');

  const buffer = await fs.readFile(file.path);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: resolveContentType(file) }), safeUploadName(file));
  form.append('api_key', apiKey);
  form.append('timestamp', String(timestamp));
  form.append('folder', folder);
  form.append('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw providerError();

  return {
    url: data.secure_url,
    publicId: data.public_id,
    originalName: file.originalname,
    provider: 'cloudinary',
    resourceType,
    format: file.detectedExtension || data.format,
    mimeType: resolveContentType(file),
  };
}

async function uploadBuffer(buffer, file, resourceType = 'image', options = {}) {
  if (!isCloudinaryConfigured()) return null;
  return uploadContent(buffer, file, resourceType, options);
}

async function uploadContent(buffer, file, resourceType, options = {}) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const folder = resolveCloudinaryFolder(options.folder);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${apiSecret}`).digest('hex');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: resolveContentType(file) }), safeUploadName(file));
  form.append('api_key', apiKey);
  form.append('timestamp', String(timestamp));
  form.append('folder', folder);
  form.append('signature', signature);
  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw providerError();
  }
  return {
    url: data.secure_url,
    publicId: data.public_id,
    originalName: file.originalname,
    provider: 'cloudinary',
    resourceType,
    format: file.detectedExtension || data.format,
    mimeType: resolveContentType(file),
  };
}

async function deleteMedia(identifier, resourceType = 'image') {
  if (!isCloudinaryConfigured()) return false;
  const publicId = typeof identifier === 'object' ? identifier.publicId : identifier;
  if (!publicId || /^https?:\/\//i.test(String(publicId))) return false;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha1')
    .update(`public_id=${publicId}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`)
    .digest('hex');
  const form = new FormData();
  form.append('public_id', String(publicId));
  form.append('timestamp', String(timestamp));
  form.append('api_key', process.env.CLOUDINARY_API_KEY);
  form.append('signature', signature);
  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${resourceType}/destroy`,
    { method: 'POST', body: form },
  );
  if (!response.ok) throw Object.assign(new Error('Media provider deletion failed'), { statusCode: 502, code: 'MEDIA_PROVIDER_ERROR' });
  const data = await response.json().catch(() => ({}));
  return ['ok', 'not found'].includes(data.result);
}

async function uploadVideo(file, options = {}) {
  return uploadFile(file, 'video', options);
}

async function uploadModel(file, options = {}) {
  return uploadFile(file, 'raw', { ...options, folder: 'product-models' });
}

function resolveCloudinaryFolder(subfolder = '') {
  const configured = String(process.env.CLOUDINARY_FOLDER || 'samira-products')
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '');
  const base = configured && configured.length <= 100 && !configured.includes('..')
    && /^[a-z0-9][a-z0-9/_-]*$/.test(configured)
    ? configured
    : 'samira-products';
  const normalized = String(subfolder || '').trim().toLowerCase();
  return allowedSubfolders.has(normalized) ? `${base}/${normalized}` : base;
}

function resolveContentType(file = {}) {
  const detected = String(file.detectedMime || '').toLowerCase();
  if (safeContentTypes.has(detected)) return detected;
  const declared = String(file.mimetype || '').toLowerCase();
  if (safeContentTypes.has(declared)) return declared;
  return 'application/octet-stream';
}

function safeUploadName(file = {}) {
  const extension = String(file.detectedExtension || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const base = String(file.originalname || 'media')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80) || 'media';
  return extension ? `${base}.${extension}` : base;
}

function providerError() {
  const error = new Error('Media provider rejected the upload');
  error.statusCode = 502;
  error.code = 'MEDIA_PROVIDER_ERROR';
  return error;
}

module.exports = {
  deleteMedia,
  isCloudinaryConfigured,
  uploadBuffer,
  uploadImage,
  uploadModel,
  uploadVideo,
  _private: { resolveCloudinaryFolder, resolveContentType, safeUploadName },
};
