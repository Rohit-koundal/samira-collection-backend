const { isR2Configured, uploadImageToR2 } = require('./r2Upload');
const { isCloudinaryConfigured, uploadImage: uploadImageToCloudinary } = require('./cloudinaryUpload');
const { getPublicApiUrl } = require('../utils/imageUtils');

function getStorageProvider() {
  if (isR2Configured()) return 'r2';
  if (isCloudinaryConfigured()) return 'cloudinary';
  return 'local';
}

async function uploadProductImages(files = [], req) {
  if (isR2Configured()) {
    return Promise.all(files.map((file) => uploadImageToR2(file)));
  }

  if (isCloudinaryConfigured()) {
    return Promise.all(files.map((file) => uploadImageToCloudinary(file)));
  }

  const baseUrl = getPublicApiUrl(req);
  return files.map((file) => ({
    url: `${baseUrl}/uploads/${file.filename}`,
    publicId: file.filename,
    originalName: file.originalname,
  }));
}

module.exports = {
  getStorageProvider,
  uploadProductImages,
  isR2Configured,
  isCloudinaryConfigured,
};
