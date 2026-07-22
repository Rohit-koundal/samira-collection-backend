const mongoose = require('mongoose');

const mediaReferenceSchema = new mongoose.Schema({
  provider: { type: String, enum: ['r2', 'cloudinary'], required: true },
  storageKey: { type: String, required: true, maxlength: 500 },
  url: { type: String, required: true, maxlength: 2000 },
  originalFilename: { type: String, maxlength: 180 },
  mimeType: { type: String, maxlength: 100 },
  sizeBytes: { type: Number, min: 0 },
  durationSeconds: { type: Number, min: 0 },
  width: { type: Number, min: 0 },
  height: { type: Number, min: 0 },
}, { _id: false });

const reelImportSchema = new mongoose.Schema({
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sourceVideo: { type: mediaReferenceSchema, required: true },
  status: {
    type: String,
    enum: ['uploading', 'uploaded', 'queued', 'processing', 'review_required', 'creating_drafts', 'completed', 'failed', 'cancelled'],
    default: 'uploaded',
    index: true,
  },
  cancellationRequested: { type: Boolean, default: false },
  progress: {
    percentage: { type: Number, min: 0, max: 100, default: 0 },
    currentStep: { type: String, maxlength: 100, default: 'Uploaded' },
    message: { type: String, maxlength: 500, default: '' },
  },
  processingConfig: {
    framesPerSecond: Number,
    sceneThreshold: Number,
    duplicateThreshold: Number,
    clusteringThreshold: Number,
  },
  statistics: {
    extractedFrames: { type: Number, min: 0, default: 0 },
    rejectedFrames: { type: Number, min: 0, default: 0 },
    duplicateFrames: { type: Number, min: 0, default: 0 },
    candidateFrames: { type: Number, min: 0, default: 0 },
    detectedProducts: { type: Number, min: 0, default: 0 },
    createdDrafts: { type: Number, min: 0, default: 0 },
  },
  error: {
    code: { type: String, maxlength: 100 },
    safeMessage: { type: String, maxlength: 500 },
  },
  queueJobId: { type: String, maxlength: 200 },
  attemptCount: { type: Number, min: 0, default: 0 },
  startedAt: Date,
  completedAt: Date,
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });

reelImportSchema.index({ createdBy: 1, createdAt: -1 });
reelImportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.models.ReelImport || mongoose.model('ReelImport', reelImportSchema);
