const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { DeleteObjectCommand, S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

let r2Client;

const allowedFolders = new Set(['products', 'categories', 'banners', 'product-videos', 'product-models']);
const allowedExtensions = new Set(['jpg', 'png', 'webp', 'mp4', 'webm', 'mov', 'glb', 'usdz']);
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

function isR2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID
    && process.env.R2_ACCESS_KEY_ID
    && process.env.R2_SECRET_ACCESS_KEY
    && process.env.R2_BUCKET_NAME
    && process.env.R2_PUBLIC_URL,
  );
}

function getR2Client() {
  if (!r2Client) {
    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return r2Client;
}

function getR2Folder() {
  const folder = String(process.env.R2_FOLDER || 'products').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!folder || folder.length > 100 || folder.includes('..') || !/^[a-z0-9][a-z0-9/_-]*$/.test(folder)) {
    return 'products';
  }
  return folder;
}

function buildPublicUrl(objectKey) {
  const base = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  return `${base}/${objectKey}`;
}

function resolveUploadFolder(folder = '') {
  const normalized = String(folder || '').trim().toLowerCase();
  if (allowedFolders.has(normalized)) return normalized;
  return getR2Folder();
}

function buildObjectKey(file, { folder = 'products', extension = 'webp' } = {}) {
  const safeFolder = resolveUploadFolder(folder);
  const safeBaseName = String(file.originalname || 'image')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80) || 'image';
  const suffix = crypto.randomBytes(5).toString('hex');
  const requestedExtension = String(extension || 'webp').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const safeExtension = allowedExtensions.has(requestedExtension) ? requestedExtension : 'bin';
  return `${safeFolder}/${Date.now()}-${suffix}-${safeBaseName}.${safeExtension}`;
}

async function uploadImageToR2(file, options = {}) {
  const objectKey = buildObjectKey(file, { ...options, extension: 'webp' });
  const buffer = await fs.readFile(file.path);

  await getR2Client().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey,
    Body: buffer,
    ContentType: resolveContentType(file, 'image/webp'),
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return {
    url: buildPublicUrl(objectKey),
    publicId: objectKey,
    originalName: file.originalname,
  };
}

async function uploadBufferToR2(buffer, file, options = {}) {
  const extension = options.extension || file.detectedExtension || 'webp';
  const objectKey = buildObjectKey(file, { ...options, extension });
  await getR2Client().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey,
    Body: buffer,
    ContentType: options.contentType || file.detectedMime || file.mimetype || 'application/octet-stream',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return {
    url: buildPublicUrl(objectKey),
    publicId: objectKey,
    originalName: file.originalname,
    provider: 'r2',
  };
}

async function uploadFileToR2(file, options = {}) {
  const extension = resolveFileExtension(file);
  const objectKey = buildObjectKey(file, { ...options, extension });
  const buffer = await fs.readFile(file.path);

  await getR2Client().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey,
    Body: buffer,
    ContentType: resolveContentType(file),
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return {
    url: buildPublicUrl(objectKey),
    publicId: objectKey,
    originalName: file.originalname,
    provider: 'r2',
    resourceType: ['glb', 'usdz'].includes(extension) ? 'raw' : 'video',
    format: extension,
    mimeType: resolveContentType(file),
  };
}

async function deleteImageFromR2(identifier) {
  const objectKey = resolveObjectKey(identifier);
  if (!objectKey || !isR2Configured()) return false;

  await getR2Client().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey,
  }));
  return true;
}

function resolveObjectKey(identifier) {
  if (!identifier) return '';
  if (typeof identifier === 'object') {
    return resolveObjectKey(identifier.publicId || identifier.url);
  }

  const value = String(identifier || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) return value;

  const publicBase = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  if (publicBase && value.startsWith(publicBase)) {
    return value.slice(publicBase.length + 1);
  }

  try {
    const pathname = new URL(value).pathname.replace(/^\/+/, '');
    return pathname;
  } catch {
    return '';
  }
}

function resolveFileExtension(file = {}) {
  const detected = String(file.detectedExtension || '').toLowerCase();
  if (allowedExtensions.has(detected)) return detected;
  const mime = String(file.detectedMime || file.mimetype || '').toLowerCase();
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime') || mime.includes('mov')) return 'mov';
  if (mime.includes('mp4')) return 'mp4';
  if (mime === 'model/gltf-binary') return 'glb';
  if (mime === 'model/vnd.usdz+zip') return 'usdz';
  const original = String(file.originalname || '').split('.').pop().toLowerCase();
  if (allowedExtensions.has(original)) return original;
  return 'bin';
}

function resolveContentType(file = {}, fallback = 'application/octet-stream') {
  const detected = String(file.detectedMime || '').toLowerCase();
  if (safeContentTypes.has(detected)) return detected;
  const declared = String(file.mimetype || '').toLowerCase();
  if (safeContentTypes.has(declared)) return declared;
  return fallback;
}

module.exports = {
  isR2Configured,
  uploadImageToR2,
  uploadBufferToR2,
  uploadFileToR2,
  deleteImageFromR2,
  resolveObjectKey,
  resolveUploadFolder,
  _private: { buildObjectKey, resolveContentType, resolveFileExtension },
};
