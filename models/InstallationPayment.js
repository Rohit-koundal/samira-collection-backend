const mongoose = require('mongoose');
const { PLAN_IDS } = require('../config/storePlans');

const installationPaymentSchema = new mongoose.Schema({
  installation: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientInstallation', required: true, index: true },
  installationId: { type: String, required: true, index: true },
  plan: { type: String, enum: PLAN_IDS, required: true },
  billingCycle: { type: String, enum: ['MONTHLY', 'YEARLY', 'LIFETIME'], required: true },
  amount: { type: Number, required: true, min: 1 },
  currency: { type: String, default: 'INR', maxlength: 8 },
  status: { type: String, enum: ['CREATED', 'PAID', 'FAILED', 'REFUNDED'], default: 'CREATED', index: true },
  receipt: { type: String, required: true, maxlength: 40 },
  razorpayOrderId: { type: String, unique: true, sparse: true, index: true },
  razorpayPaymentId: { type: String, unique: true, sparse: true, index: true },
  signatureVerified: { type: Boolean, default: false },
  paidAt: Date,
  periodStart: Date,
  periodEnd: Date,
  failureReason: { type: String, maxlength: 300 },
  refundId: { type: String, maxlength: 100 },
  refundedAmount: { type: Number, min: 0 },
  refundedAt: Date,
}, { timestamps: true });

installationPaymentSchema.index({ installation: 1, createdAt: -1 });

module.exports = mongoose.model('InstallationPayment', installationPaymentSchema);
