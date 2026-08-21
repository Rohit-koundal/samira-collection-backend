const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  image: String,
  description: String,
  isActive: { type: Boolean, default: true },
  displayOrder: { type: Number, default: 0 },
}, { timestamps: true });

categorySchema.plugin(storeIdPlugin);
categorySchema.index({ storeId: 1, slug: 1 });

module.exports = mongoose.model('Category', categorySchema);
