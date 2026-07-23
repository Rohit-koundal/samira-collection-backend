const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const {
  buildPublicUrl,
  getR2Client,
  isR2Configured,
  uploadFileToR2,
} = require('./r2Upload');
const {
  isCloudinaryConfigured,
  uploadImage,
  uploadVideo,
} = require('./cloudinaryUpload');

function getStorageProvider() {
  if (isR2Configured()) return 'r2';
  if (isCloudinaryConfigured()) return 'cloudinary';
  return null;
}

function assertStorageConfigured() {
  const provider = getStorageProvider();
  if (!provider) {
    const error = new Error('Reel import storage is not configured. Connect R2 or Cloudinary.');
    error.code = 'REEL_STORAGE_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  return provider;
}

async function uploadOriginalVideo(file) {
  const provider = assertStorageConfigured();
  const uploaded = provider === 'r2'
    ? await uploadFileToR2(file, { folder: 'reel-imports/original' })
    : await uploadVideo(file, { folder: 'reel-imports/original' });
  return {
    provider,
    storageKey: uploaded.publicId,
    url: uploaded.url,
  };
}

async function uploadGeneratedImage(file) {
  const provider = assertStorageConfigured();
  const uploaded = provider === 'r2'
    ? await uploadFileToR2(file, { folder: 'reel-imports/candidates' })
    : await uploadImage(file, { folder: 'reel-imports/candidates' });
  return { provider, storageKey: uploaded.publicId, url: uploaded.url };
}

async function objectExists({ provider, storageKey, url }) {
  if (provider === 'r2') {
    try {
      await getR2Client().send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: storageKey }));
      return true;
    } catch {
      return false;
    }
  }
  if (provider === 'cloudinary' && url) {
    const response = await fetch(url, { method: 'HEAD' }).catch(() => null);
    return Boolean(response?.ok);
  }
  return false;
}

async function downloadObject({ provider, storageKey, url }, destinationPath) {
  if (provider === 'r2') {
    const response = await getR2Client().send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: storageKey,
    }));
    await pipeline(response.Body, fs.createWriteStream(destinationPath, { flags: 'wx' }));
    return destinationPath;
  }
  const readUrl = await createSignedReadUrl({ provider, storageKey, url });
  const response = await fetch(readUrl);
  if (!response.ok || !response.body) throw new Error('Unable to download stored reel.');
  await pipeline(response.body, fs.createWriteStream(destinationPath, { flags: 'wx' }));
  return destinationPath;
}

async function deleteObject({ provider, storageKey }) {
  if (!storageKey) return false;
  if (provider === 'r2') {
    await getR2Client().send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: storageKey }));
    return true;
  }
  // Cloudinary originals are retained unless deletion credentials and an explicit cleanup job are configured.
  return false;
}

async function createSignedReadUrl({ provider, storageKey, url }) {
  if (url) return url;
  if (provider === 'r2') return buildPublicUrl(storageKey);
  throw new Error('A private read URL is unavailable for this storage object.');
}

async function putBufferToR2(buffer, storageKey, contentType = 'application/octet-stream') {
  await getR2Client().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: storageKey,
    Body: buffer,
    ContentType: contentType,
  }));
  return { provider: 'r2', storageKey, url: buildPublicUrl(storageKey) };
}

async function cleanupLocalFile(filePath) {
  if (filePath) await fsp.unlink(filePath).catch(() => null);
}

module.exports = {
  assertStorageConfigured,
  cleanupLocalFile,
  createSignedReadUrl,
  deleteObject,
  downloadObject,
  getStorageProvider,
  objectExists,
  putBufferToR2,
  uploadGeneratedImage,
  uploadOriginalVideo,
};
