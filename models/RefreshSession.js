const mongoose = require('mongoose');

const refreshSessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  csrfHash: { type: String, required: true },
  jti: { type: String, required: true, unique: true },
  familyId: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  revokeReason: String,
  replacedBy: String,
  reuseDetectedAt: Date,
  lastUsedAt: Date,
  ipAddress: String,
  userAgent: String,
}, { timestamps: true });

refreshSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshSessionSchema.index({ familyId: 1, revokedAt: 1 });

module.exports = mongoose.model('RefreshSession', refreshSessionSchema);
