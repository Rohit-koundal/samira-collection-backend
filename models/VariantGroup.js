const mongoose = require('mongoose');

const variantGroupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true },
  baseProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  colors: [String],
  sizes: [String],
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('VariantGroup', variantGroupSchema);
