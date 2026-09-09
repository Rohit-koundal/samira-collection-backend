const mongoose = require('mongoose');
const { BILLING_CYCLES, PLAN_IDS } = require('../config/storePlans');

const subscriptionPaymentSchema = new mongoose.Schema({
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  plan: { type: String, enum: PLAN_IDS, required: true },
  billingCycle: { type: String, enum: BILLING_CYCLES.filter((item) => ['MONTHLY', 'YEARLY', 'LIFETIME'].includes(item)), required: true },
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
}, { timestamps: true });

subscriptionPaymentSchema.index({ store: 1, createdAt: -1 });

module.exports = mongoose.model('SubscriptionPayment', subscriptionPaymentSchema);
