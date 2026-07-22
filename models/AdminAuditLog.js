const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true, index: true },
  resource: { type: String, required: true, index: true },
  resourceId: String,
  before: Object,
  after: Object,
  ip: String,
  requestId: String,
  metadata: Object,
}, { timestamps: true });

adminAuditLogSchema.index({ actor: 1, createdAt: -1 });
adminAuditLogSchema.index({ resource: 1, resourceId: 1, createdAt: -1 });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
