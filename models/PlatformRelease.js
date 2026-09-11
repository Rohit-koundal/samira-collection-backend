const mongoose = require('mongoose');

const platformReleaseSchema = new mongoose.Schema({
  revision: { type: Number, min: 0, default: 0 },
  version: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
  channel: { type: String, enum: ['stable', 'beta'], default: 'stable', index: true },
  status: { type: String, enum: ['DRAFT', 'PUBLISHED', 'RETIRED'], default: 'PUBLISHED', index: true },
  notes: { type: String, trim: true, maxlength: 5000 },
  eligibleIndustries: [{ type: String, trim: true, lowercase: true, maxlength: 60 }],
  mandatory: { type: Boolean, default: false },
  rolloutStatus: { type: String, enum: ['READY', 'ACTIVE', 'PAUSED', 'COMPLETED'], default: 'READY', index: true },
  rolloutPercent: { type: Number, min: 0, max: 100, default: 100 },
  artifact: {
    url: { type: String, trim: true, maxlength: 500 },
    checksumSha256: { type: String, trim: true, lowercase: true, maxlength: 64 },
    commitSha: { type: String, trim: true, maxlength: 64 },
    repository: { type: String, trim: true, maxlength: 300 },
    migrationVersion: { type: String, trim: true, maxlength: 80 },
    minimumProtocol: { type: Number, min: 1, default: 1 },
  },
  publishedAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

platformReleaseSchema.index({ channel: 1, status: 1, publishedAt: -1 });

module.exports = mongoose.model('PlatformRelease', platformReleaseSchema);
