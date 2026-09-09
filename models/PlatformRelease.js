const mongoose = require('mongoose');

const platformReleaseSchema = new mongoose.Schema({
  version: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
  channel: { type: String, enum: ['stable', 'beta'], default: 'stable', index: true },
  status: { type: String, enum: ['DRAFT', 'PUBLISHED', 'RETIRED'], default: 'PUBLISHED', index: true },
  notes: { type: String, trim: true, maxlength: 5000 },
  eligibleIndustries: [{ type: String, trim: true, lowercase: true, maxlength: 60 }],
  mandatory: { type: Boolean, default: false },
  publishedAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

platformReleaseSchema.index({ channel: 1, status: 1, publishedAt: -1 });

module.exports = mongoose.model('PlatformRelease', platformReleaseSchema);
