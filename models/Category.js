const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true },
  definitionKey: { type: String, trim: true, maxlength: 50, default: '' },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
  parentDefinitionKey: { type: String, trim: true, maxlength: 50, default: '' },
  level: { type: Number, default: 0, min: 0, max: 5 },
  attributeOverrides: { type: [mongoose.Schema.Types.Mixed], default: [] },
  variantAttributes: { type: [String], default: [] },
  configuredFilters: { type: [String], default: [] },
  image: String,
  description: String,
  metaTitle: { type: String, trim: true, maxlength: 100 },
  metaDescription: { type: String, trim: true, maxlength: 300 },
  socialImage: String,
  isActive: { type: Boolean, default: true },
  displayOrder: { type: Number, default: 0 },
}, { timestamps: true });

categorySchema.plugin(storeIdPlugin);
categorySchema.index({ storeId: 1, slug: 1 }, { unique: true });
categorySchema.index({ storeId: 1, definitionKey: 1 });

module.exports = mongoose.model('Category', categorySchema);
