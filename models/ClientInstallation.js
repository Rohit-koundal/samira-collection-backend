const mongoose = require('mongoose');
const { BILLING_CYCLES, LIMIT_KEYS, PLAN_IDS } = require('../config/storePlans');

const limitsDefinition = Object.fromEntries(LIMIT_KEYS.map((key) => [key, { type: Number, min: 0, default: null }]));

const clientInstallationSchema = new mongoose.Schema({
  installationId: { type: String, required: true, unique: true, index: true, immutable: true, maxlength: 80 },
  companyName: { type: String, required: true, trim: true, maxlength: 100 },
  projectName: { type: String, required: true, trim: true, maxlength: 100 },
  projectSlug: { type: String, required: true, trim: true, maxlength: 80, index: true },
  industry: { type: String, required: true, trim: true, lowercase: true, maxlength: 60, index: true },
  status: { type: String, enum: ['TRIAL', 'ACTIVE', 'EXPIRED', 'SUSPENDED', 'REVOKED'], default: 'TRIAL', index: true },
  plan: { type: String, enum: PLAN_IDS, default: 'PROFESSIONAL', index: true },
  billingCycle: { type: String, enum: BILLING_CYCLES, default: 'TRIAL' },
  startsAt: { type: Date, default: Date.now },
  trialEndsAt: Date,
  endsAt: Date,
  limitOverrides: { type: new mongoose.Schema(limitsDefinition, { _id: false }), default: () => ({}) },
  featureOverrides: [{ type: String, trim: true, maxlength: 80 }],
  disabledFeatures: [{ type: String, trim: true, maxlength: 80 }],
  contact: {
    ownerName: { type: String, trim: true, maxlength: 100 },
    phone: { type: String, trim: true, maxlength: 30 },
    email: { type: String, trim: true, lowercase: true, maxlength: 160 },
    billingEmail: { type: String, trim: true, lowercase: true, maxlength: 160 },
    accountManager: { type: String, trim: true, maxlength: 100 },
  },
  tags: [{ type: String, trim: true, lowercase: true, maxlength: 40 }],
  statusReason: { type: String, trim: true, maxlength: 500 },
  statusChangedAt: Date,
  renewalMessage: { type: String, trim: true, maxlength: 500 },
  usage: {
    products: { type: Number, min: 0, default: 0 },
    ordersPerMonth: { type: Number, min: 0, default: 0 },
    reportedAt: Date,
  },
  runtime: {
    databaseStatus: { type: String, enum: ['CONNECTED', 'DISCONNECTED', 'UNKNOWN'], default: 'UNKNOWN' },
    serviceStatus: { type: String, enum: ['HEALTHY', 'DEGRADED', 'UNKNOWN'], default: 'UNKNOWN' },
    lastError: { type: String, maxlength: 300 },
    reportedAt: Date,
  },
  secretSalt: { type: String, required: true, select: false },
  secretHash: { type: String, required: true, select: false },
  appVersion: { type: String, default: '1.0.0', trim: true, maxlength: 40 },
  targetVersion: { type: String, default: '1.0.0', trim: true, maxlength: 40 },
  updateChannel: { type: String, enum: ['stable', 'beta'], default: 'stable' },
  lastValidatedVersion: { type: String, trim: true, maxlength: 40 },
  lastSeenAt: Date,
  lastIpHash: { type: String, select: false },
  deploymentUrl: { type: String, trim: true, maxlength: 300 },
  hasDeployHook: { type: Boolean, default: false },
  deployHookCiphertext: { type: String, select: false },
  deployHookIv: { type: String, select: false },
  deployHookTag: { type: String, select: false },
  lastDeployment: {
    status: { type: String, enum: ['REQUESTED', 'SUCCEEDED', 'FAILED'] },
    version: String,
    requestedAt: Date,
    completedAt: Date,
    message: { type: String, maxlength: 300 },
  },
  notes: { type: String, trim: true, maxlength: 1000 },
  lastPayment: {
    orderId: String,
    paymentId: String,
    amount: Number,
    currency: String,
    paidAt: Date,
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

clientInstallationSchema.index({ projectSlug: 1, createdAt: -1 });
clientInstallationSchema.index({ status: 1, endsAt: 1 });
clientInstallationSchema.index({ lastSeenAt: 1 });

module.exports = mongoose.model('ClientInstallation', clientInstallationSchema);
