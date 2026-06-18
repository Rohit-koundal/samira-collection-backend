const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { DeleteObjectCommand, S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

let r2Client;

const allowedFolders = new Set(['products', 'categories', 'banners']);

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
  return String(process.env.R2_FOLDER || 'products').replace(/^\/+|\/+$/g, '');
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

function buildObjectKey(file, { folder = 'products' } = {}) {
  const safeFolder = resolveUploadFolder(folder);
  const safeBaseName = String(file.originalname || 'image')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'image';
  const suffix = crypto.randomBytes(5).toString('hex');
  return `${safeFolder}/${Date.now()}-${suffix}-${safeBaseName}.webp`;
}

async function uploadImageToR2(file, options = {}) {
  const objectKey = buildObjectKey(file, options);
  const buffer = await fs.readFile(file.path);

  await getR2Client().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey,
    Body: buffer,
    ContentType: file.mimetype || 'image/webp',
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return {
    url: buildPublicUrl(objectKey),
    publicId: objectKey,
    originalName: file.originalname,
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

module.exports = {
  isR2Configured,
  uploadImageToR2,
  deleteImageFromR2,
  resolveObjectKey,
  resolveUploadFolder,
};
