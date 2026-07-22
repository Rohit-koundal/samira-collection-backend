const mongoose = require('mongoose');

const supportAuditSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: String,
  fromStatus: String,
  toStatus: String,
  note: String,
  at: { type: Date, default: Date.now },
}, { _id: false });

const supportRequestSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 120 },
  email: { type: String, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  subject: { type: String, maxlength: 160 },
  message: { type: String, required: true, maxlength: 5000 },
  status: { type: String, enum: ['New', 'In Progress', 'Resolved', 'Closed'], default: 'New' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  adminNote: { type: String, maxlength: 2000, select: false },
  requestFingerprint: { type: String, required: true, index: true },
  requestIpHash: { type: String, index: true },
  requestId: String,
  auditTrail: [supportAuditSchema],
}, { timestamps: true });

supportRequestSchema.index({ status: 1, createdAt: -1 });
supportRequestSchema.index({ email: 1, createdAt: -1 });

module.exports = mongoose.model('SupportRequest', supportRequestSchema);
