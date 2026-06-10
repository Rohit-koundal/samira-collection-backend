const mongoose = require('mongoose');

const imageAssetSchema = new mongoose.Schema({
  filename: { type: String, required: true, unique: true },
  originalName: String,
  contentType: { type: String, required: true },
  size: Number,
  data: { type: Buffer, required: true },
}, { timestamps: true });

module.exports = mongoose.model('ImageAsset', imageAssetSchema);
