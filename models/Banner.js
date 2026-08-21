const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const bannerSchema = new mongoose.Schema({
  title: String,
  subtitle: String,
  image: String,
  buttonText: String,
  link: String,
  type: { type: String, enum: ['Hero', 'Offer', 'Category', 'Sale'], default: 'Hero' },
  position: {
    type: String,
    enum: ['Home - Top', 'Home - Middle', 'Home - Bottom', 'Cart - Bottom', 'Category - Featured', 'Offer Strip'],
    default: 'Home - Top',
  },
  isActive: { type: Boolean, default: true },
  displayOrder: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
}, { timestamps: true });

bannerSchema.plugin(storeIdPlugin);
bannerSchema.index({ storeId: 1, isActive: 1, displayOrder: 1 });

module.exports = mongoose.model('Banner', bannerSchema);
