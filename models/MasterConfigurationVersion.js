const mongoose = require('mongoose');

const changeSchema = new mongoose.Schema({
  path: { type: String, required: true, maxlength: 240 },
  kind: { type: String, enum: ['ADDED', 'REMOVED', 'CHANGED'], required: true },
  before: { type: String, maxlength: 2000, default: '' },
  after: { type: String, maxlength: 2000, default: '' },
  risk: { type: String, enum: ['SAFE', 'REVIEW', 'BREAKING'], default: 'SAFE' },
}, { _id: false });

const schema = new mongoose.Schema({
  scopeKey: { type: String, default: 'store', immutable: true, index: true },
  revision: { type: Number, required: true, min: 0 },
  structure: { type: mongoose.Schema.Types.Mixed, required: true },
  locked: { type: Boolean, default: false },
  kind: { type: String, enum: ['BASELINE', 'PUBLISH', 'IMPORT', 'LOCK', 'UNLOCK', 'ROLLBACK'], default: 'PUBLISH', index: true },
  note: { type: String, trim: true, maxlength: 240 },
  changes: { type: [changeSchema], default: [] },
  impact: { type: mongoose.Schema.Types.Mixed, default: undefined },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

schema.index({ scopeKey: 1, revision: -1 }, { unique: true });
schema.index({ scopeKey: 1, createdAt: -1 });

module.exports = mongoose.model('MasterConfigurationVersion', schema);
