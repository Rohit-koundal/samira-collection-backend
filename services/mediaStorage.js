const fs = require('fs/promises');
const sharp = require('sharp');
const {
  deleteImageFromR2,
  isR2Configured,
  uploadBufferToR2,
  uploadFileToR2,
} = require('./r2Upload');
const cloudinary = require('./cloudinaryUpload');
const { verifyUploadSignature } = require('./uploadVerification');

function getMediaStorageState() {
  const providers = getAvailableProviders();
  return {
    configured: providers.length > 0,
    provider: providers[0] || null,
    fallbackProvider: providers[1] || null,
  };
}

function getStorageProvider() {
  return getMediaStorageState().provider;
}

function createSignedReadUrl(entry) {
  if (!entry?.url || !/^https:\/\//i.test(String(entry.url))) {
    const error = new Error('A readable media URL is not available');
    error.statusCode = 503;
    error.code = 'MEDIA_READ_URL_UNAVAILABLE';
    throw error;
  }
  return entry.url;
}

async function uploadGeneratedImage(file, options = {}) {
  return uploadImage(file, { folder: options.folder || 'reel-imports/candidates' });
}

function getAvailableProviders() {
  return [
    isR2Configured() ? 'r2' : null,
    cloudinary.isCloudinaryConfigured() ? 'cloudinary' : null,
  ].filter(Boolean);
}

function assertMediaStorageConfigured() {
  const providers = getAvailableProviders();
  if (!providers.length) {
    const error = new Error('Persistent media storage is not configured');
    error.statusCode = 503;
    error.code = 'MEDIA_STORAGE_NOT_CONFIGURED';
    throw error;
  }
  return providers;
}

async function uploadImage(file, { folder = 'products' } = {}) {
  await verifyUploadSignature(file, 'image');
  const providers = assertMediaStorageConfigured();
  const source = sharp(file.path, { failOn: 'error', limitInputPixels: 40_000_000 }).rotate();
  let mainBuffer;
  let thumbnailBuffer;
  try {
    [mainBuffer, thumbnailBuffer] = await Promise.all([
      source.clone().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer(),
      source.clone().resize({ width: 480, height: 480, fit: 'cover', position: 'attention' }).webp({ quality: 76, effort: 4 }).toBuffer(),
    ]);
  } catch (error) {
    const invalidImage = new Error('Uploaded image could not be safely processed');
    invalidImage.statusCode = 400;
    invalidImage.code = 'INVALID_IMAGE_CONTENT';
    invalidImage.cause = error;
    throw invalidImage;
  }

  const optimizedFile = {
    ...file,
    originalname: safeBaseName(file.originalname, '.webp'),
    detectedMime: 'image/webp',
    detectedExtension: 'webp',
  };
  const thumbnailFile = {
    ...optimizedFile,
    originalname: safeBaseName(file.originalname, '-thumbnail.webp'),
  };

  return uploadAcrossProviders(providers, (provider) => uploadImagePair({
    provider,
    folder,
    mainBuffer,
    thumbnailBuffer,
    optimizedFile,
    thumbnailFile,
  }));
}

async function uploadImagePair({
  provider,
  folder,
  mainBuffer,
  thumbnailBuffer,
  optimizedFile,
  thumbnailFile,
}) {
  const upload = provider === 'r2'
    ? (buffer, entry) => uploadBufferToR2(buffer, entry, {
      folder,
      extension: 'webp',
      contentType: 'image/webp',
    })
    : (buffer, entry) => cloudinary.uploadBuffer(buffer, entry, 'image', { folder });
  let main;
  let thumbnail;
  try {
    main = await upload(mainBuffer, optimizedFile);
    thumbnail = await upload(thumbnailBuffer, thumbnailFile);
  } catch (error) {
    await cleanupKnownProviderUploads(provider, [main, thumbnail], 'image');
    throw error;
  }
  return {
    ...main,
    provider,
    resourceType: 'image',
    thumbnailUrl: thumbnail.url,
    thumbnailPublicId: thumbnail.publicId,
    widthLimit: 2000,
    format: 'webp',
    mimeType: 'image/webp',
  };
}

async function uploadVideo(file, { folder = 'product-videos' } = {}) {
  await verifyUploadSignature(file, 'video');
  const providers = assertMediaStorageConfigured();
  return uploadAcrossProviders(providers, async (provider) => {
    const result = provider === 'r2'
      ? await uploadFileToR2(file, { folder })
      : await cloudinary.uploadVideo(file, { folder });
    return { ...result, provider, resourceType: 'video' };
  });
}

async function uploadModel(file) {
  await verifyUploadSignature(file, 'model');
  const providers = assertMediaStorageConfigured();
  return uploadAcrossProviders(providers, async (provider) => {
    const result = provider === 'r2'
      ? await uploadFileToR2(file, { folder: 'product-models' })
      : await cloudinary.uploadModel(file, { folder: 'product-models' });
    return {
      ...result,
      provider,
      resourceType: 'raw',
      format: file.detectedExtension,
      mimeType: file.detectedMime,
    };
  });
}

async function uploadBatch(files, uploader) {
  const uploaded = [];
  try {
    for (const file of files) uploaded.push(await uploader(file));
    return uploaded;
  } catch (error) {
    await Promise.allSettled(uploaded.map((entry) => deleteMedia(entry)));
    throw error;
  }
}

async function uploadAcrossProviders(providers, operation) {
  let lastError;
  for (const provider of providers) {
    try {
      return await operation(provider);
    } catch (error) {
      lastError = error;
    }
  }
  throw mediaStorageError(lastError);
}

async function deleteMedia(entry) {
  if (!entry) return false;
  const provider = entry.provider || getMediaStorageState().provider;
  if (!provider) return false;
  const targets = [{
    publicId: entry.publicId,
    url: entry.url,
    resourceType: entry.resourceType || 'image',
  }];
  if (entry.thumbnailPublicId || entry.thumbnailUrl) {
    targets.push({
      publicId: entry.thumbnailPublicId,
      url: entry.thumbnailUrl,
      resourceType: 'image',
    });
  }
  const results = await Promise.allSettled(targets.map((target) => deleteProviderUpload(provider, target)));
  const rejection = results.find((result) => result.status === 'rejected');
  if (rejection) throw mediaStorageError(rejection.reason);
  return results.some((result) => result.value === true);
}

async function deleteProviderUpload(provider, entry) {
  if (!entry?.publicId && !entry?.url) return false;
  if (provider === 'r2') return deleteImageFromR2(entry);
  if (provider === 'cloudinary') return cloudinary.deleteMedia(entry, entry.resourceType || 'image');
  return false;
}

async function cleanupKnownProviderUploads(provider, entries, resourceType) {
  await Promise.allSettled((entries || []).filter(Boolean).map((entry) => deleteProviderUpload(provider, {
    ...entry,
    resourceType: entry.resourceType || resourceType,
  })));
}

function mediaStorageError(cause) {
  const error = new Error('Media storage operation failed');
  error.statusCode = 502;
  error.code = 'MEDIA_STORAGE_ERROR';
  error.cause = cause;
  return error;
}

function safeBaseName(originalName, suffix) {
  const base = String(originalName || 'image')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80) || 'image';
  return `${base}${suffix}`;
}

async function cleanupTempFiles(files = []) {
  await Promise.allSettled((files || []).map((file) => (
    file?.path ? fs.unlink(file.path).catch(() => null) : Promise.resolve()
  )));
}

module.exports = {
  cleanupTempFiles,
  createSignedReadUrl,
  deleteMedia,
  getMediaStorageState,
  getStorageProvider,
  uploadBatch,
  uploadGeneratedImage,
  uploadImage,
  uploadModel,
  uploadVideo,
  _private: {
    cleanupKnownProviderUploads,
    getAvailableProviders,
    uploadAcrossProviders,
    uploadImagePair,
  },
};
