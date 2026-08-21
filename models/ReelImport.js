const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const reelImportSchema = new mongoose.Schema({
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sourceVideo: {
    provider: { type: String, enum: ['r2', 'cloudinary'], required: true },
    storageKey: { type: String, required: true },
    url: { type: String, select: false },
    originalFilename: { type: String, required: true, maxlength: 255 },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    durationSeconds: { type: Number, required: true },
    width: Number,
    height: Number,
    codec: String,
  },
  status: {
    type: String,
    enum: ['uploading', 'uploaded', 'queued', 'processing', 'review_required', 'creating_drafts', 'completed', 'failed', 'cancelled'],
    default: 'uploaded',
    index: true,
  },
  progress: {
    percentage: { type: Number, default: 0, min: 0, max: 100 },
    currentStep: { type: String, default: 'Uploading video' },
    message: { type: String, default: '' },
  },
  processingConfig: {
    framesPerSecond: Number,
    sceneThreshold: Number,
    duplicateThreshold: Number,
    clusteringThreshold: Number,
  },
  statistics: {
    extractedFrames: { type: Number, default: 0 },
    rejectedFrames: { type: Number, default: 0 },
    duplicateFrames: { type: Number, default: 0 },
    candidateFrames: { type: Number, default: 0 },
    detectedProducts: { type: Number, default: 0 },
    createdDrafts: { type: Number, default: 0 },
  },
  error: {
    code: String,
    safeMessage: String,
  },
  cancellationRequested: { type: Boolean, default: false },
  attemptCount: { type: Number, default: 0 },
  startedAt: Date,
  completedAt: Date,
  retentionExpiresAt: { type: Date, index: true },
}, { timestamps: true });

reelImportSchema.plugin(storeIdPlugin);
reelImportSchema.index({ createdBy: 1, createdAt: -1 });
reelImportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('ReelImport', reelImportSchema);
