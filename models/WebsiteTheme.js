const mongoose = require('mongoose');

const websiteThemeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  slug: { type: String, required: true, trim: true, lowercase: true },
  preset: { type: String, default: 'default' },
  draftConfig: { type: mongoose.Schema.Types.Mixed, required: true },
  publishedConfig: { type: mongoose.Schema.Types.Mixed },
  isActive: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  publishedAt: Date,
}, { timestamps: true, optimisticConcurrency: true });

websiteThemeSchema.index({ slug: 1 }, { unique: true });
websiteThemeSchema.index({ isActive: 1 }, { unique: true, partialFilterExpression: { isActive: true } });

module.exports = mongoose.model('WebsiteTheme', websiteThemeSchema);
