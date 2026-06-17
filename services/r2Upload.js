const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { generateImageVariants } = require('./imageProcessor');

let r2Client;

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

function buildObjectKey(baseId, variant) {
  return `${getR2Folder()}/${baseId}/${variant}.webp`;
}

function buildPublicUrl(objectKey) {
  const base = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  return `${base}/${objectKey}`;
}

function buildBaseId(originalName = 'image') {
  const safeName = String(originalName).replace(/[^a-z0-9.]+/gi, '-').toLowerCase().replace(/\.(jpe?g|png|webp)$/i, '');
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${Date.now()}-${safeName || 'image'}-${suffix}`;
}

async function deleteUploadedKeys(keys = []) {
  if (!keys.length) return;
  await Promise.all(keys.map((Key) => getR2Client().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key,
  })).catch(() => null)));
}

async function uploadVariantsToR2(baseId, variants) {
  const uploadedKeys = [];
  const urls = {};

  try {
    for (const [variant, buffer] of Object.entries(variants)) {
      const objectKey = buildObjectKey(baseId, variant);
      urls[variant] = await uploadBuffer(objectKey, buffer);
      uploadedKeys.push(objectKey);
    }
    return urls;
  } catch (error) {
    await deleteUploadedKeys(uploadedKeys);
    throw new Error(`R2 upload failed: ${error.message}`);
  }
}

async function uploadBuffer(objectKey, buffer) {
  await getR2Client().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey,
    Body: buffer,
    ContentType: 'image/webp',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return buildPublicUrl(objectKey);
}

async function uploadImageToR2(file) {
  const baseId = buildBaseId(file.originalname);
  const variants = await generateImageVariants(file.path);
  const urls = await uploadVariantsToR2(baseId, variants);

  return {
    url: urls.full,
    publicId: buildObjectKey(baseId, 'full'),
    originalName: file.originalname,
    variants: urls,
  };
}

async function uploadLocalFileToR2(filePath, originalName = path.basename(filePath)) {
  const baseId = buildBaseId(originalName);
  const variants = await generateImageVariants(filePath);
  const urls = await uploadVariantsToR2(baseId, variants);

  return {
    url: urls.full,
    publicId: buildObjectKey(baseId, 'full'),
    originalName,
    variants: urls,
  };
}

module.exports = {
  isR2Configured,
  uploadImageToR2,
  uploadLocalFileToR2,
  buildPublicUrl,
  buildObjectKey,
};
