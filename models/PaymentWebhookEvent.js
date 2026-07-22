const mongoose = require('mongoose');

const paymentWebhookEventSchema = new mongoose.Schema({
  provider: { type: String, enum: ['Razorpay'], default: 'Razorpay' },
  eventId: { type: String, required: true, unique: true },
  eventType: { type: String, required: true },
  status: { type: String, enum: ['Processing', 'Processed', 'Failed'], default: 'Processing' },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  providerOrderId: String,
  providerPaymentId: String,
  providerRefundId: String,
  attempts: { type: Number, default: 1 },
  processedAt: Date,
  lastErrorCode: String,
}, { timestamps: true });

paymentWebhookEventSchema.index({ status: 1, updatedAt: 1 });

module.exports = mongoose.model('PaymentWebhookEvent', paymentWebhookEventSchema);
