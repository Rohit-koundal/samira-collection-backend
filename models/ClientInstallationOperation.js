const mongoose = require('mongoose');

const clientInstallationOperationSchema = new mongoose.Schema({
  installation: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientInstallation', required: true, index: true },
  installationId: { type: String, required: true, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: {
    type: String,
    enum: [
      'PROFILE_UPDATE', 'SUBSCRIPTION_UPDATE', 'ACCESS_GRANT', 'LIFECYCLE_CHANGE',
      'ENTITLEMENTS_UPDATE', 'DEPLOYMENT_SETTINGS_UPDATE', 'DEPLOYMENT_REQUEST',
      'KEY_ROTATION_START', 'KEY_ROTATION_CONFIRM', 'KEY_ROTATION_CANCEL',
      'REFUND_RECONCILIATION',
    ],
    required: true,
    index: true,
  },
  idempotencyKey: { type: String, trim: true, maxlength: 120 },
  reason: { type: String, trim: true, maxlength: 500 },
  source: { type: String, enum: ['MASTER', 'PAYMENT', 'CLIENT', 'SYSTEM'], default: 'MASTER' },
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed,
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

clientInstallationOperationSchema.index({ installation: 1, createdAt: -1 });
clientInstallationOperationSchema.index(
  { installation: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

module.exports = mongoose.model('ClientInstallationOperation', clientInstallationOperationSchema);
