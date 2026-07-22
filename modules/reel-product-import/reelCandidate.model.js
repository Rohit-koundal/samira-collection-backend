const mongoose = require('mongoose');

const frameSchema = new mongoose.Schema({
  provider: { type: String, enum: ['r2', 'cloudinary'], required: true },
  storageKey: { type: String, required: true, maxlength: 500 },
  url: { type: String, required: true, maxlength: 2000 },
  timestampSeconds: { type: Number, min: 0, required: true },
  qualityScore: { type: Number, min: 0, max: 1, default: 0 },
  sharpnessScore: { type: Number, min: 0, max: 1, default: 0 },
  exposureScore: { type: Number, min: 0, max: 1, default: 0 },
  visibilityScore: { type: Number, min: 0, max: 1, default: 0 },
  selected: { type: Boolean, default: false },
}, { timestamps: false });

const reelCandidateSchema = new mongoose.Schema({
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'ReelImport', required: true, index: true },
  groupNumber: { type: Number, min: 1, required: true },
  status: {
    type: String,
    enum: ['suggested', 'approved', 'ignored', 'merged', 'draft_created'],
    default: 'suggested',
  },
  sourceRange: {
    startSeconds: { type: Number, min: 0, default: 0 },
    endSeconds: { type: Number, min: 0, default: 0 },
  },
  frames: { type: [frameSchema], validate: [(value) => value.length > 0, 'Candidate requires at least one frame'] },
  suggestions: {
    name: { type: String, maxlength: 160, default: '' },
    category: { type: String, maxlength: 160, default: '' },
    subcategory: { type: String, maxlength: 160, default: '' },
    primaryColor: { type: String, maxlength: 80, default: '' },
    secondaryColors: [{ type: String, maxlength: 80 }],
    pattern: { type: String, maxlength: 120, default: '' },
    occasion: [{ type: String, maxlength: 120 }],
    tags: [{ type: String, maxlength: 100 }],
    altText: { type: String, maxlength: 300, default: '' },
  },
  confidence: {
    category: { type: Number, min: 0, max: 1, default: 0 },
    primaryColor: { type: Number, min: 0, max: 1, default: 0 },
    pattern: { type: Number, min: 0, max: 1, default: 0 },
    occasion: { type: Number, min: 0, max: 1, default: 0 },
    overall: { type: Number, min: 0, max: 1, default: 0 },
  },
  adminOverrides: {
    name: { type: String, maxlength: 160 },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    subCategory: { type: String, maxlength: 160 },
    primaryColor: { type: String, maxlength: 80 },
    pattern: { type: String, maxlength: 120 },
    occasion: { type: String, maxlength: 120 },
    tags: [{ type: String, maxlength: 100 }],
    price: { type: Number, min: 0 },
    originalPrice: { type: Number, min: 0 },
    stock: { type: Number, min: 0 },
    sizes: [{ type: String, maxlength: 40 }],
  },
  mergedInto: { type: mongoose.Schema.Types.ObjectId, ref: 'ReelCandidate' },
  mergedFrom: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ReelCandidate' }],
  productDraft: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductDraft' },
}, { timestamps: true });

reelCandidateSchema.index({ job: 1, groupNumber: 1 }, { unique: true });
reelCandidateSchema.index({ job: 1, status: 1 });

module.exports = mongoose.models.ReelCandidate || mongoose.model('ReelCandidate', reelCandidateSchema);
