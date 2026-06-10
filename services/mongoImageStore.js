const fs = require('fs/promises');
const mongoose = require('mongoose');
const ImageAsset = require('../models/ImageAsset');

function isMongoImageStoreAvailable() {
  return mongoose.connection.readyState === 1;
}

async function saveUploadedFile(file) {
  const data = await fs.readFile(file.path);
  await ImageAsset.findOneAndUpdate(
    { filename: file.filename },
    {
      filename: file.filename,
      originalName: file.originalname,
      contentType: file.mimetype,
      size: file.size,
      data,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return {
    publicId: file.filename,
    originalName: file.originalname,
  };
}

async function findImage(filename) {
  if (!isMongoImageStoreAvailable()) return null;
  return ImageAsset.findOne({ filename }).lean();
}

module.exports = {
  findImage,
  isMongoImageStoreAvailable,
  saveUploadedFile,
};
