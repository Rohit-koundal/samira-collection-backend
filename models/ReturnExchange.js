const mongoose = require('mongoose');

const auditEntrySchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: String,
  fromStatus: String,
  toStatus: String,
  note: String,
  ip: String,
  at: { type: Date, default: Date.now },
}, { _id: false });

const returnExchangeSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  orderItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['return', 'exchange'], required: true },
  quantity: { type: Number, required: true, min: 1 },
  variantId: String,
  purchasedVariant: {
    sku: String,
    size: String,
    color: String,
  },
  exchangeVariantId: String,
  exchangeVariant: {
    sku: String,
    size: String,
    color: String,
  },
  reason: { type: String, required: true },
  comment: String,
  evidenceImages: [{ url: String, publicId: String }],
  adminComment: String,
  status: {
    type: String,
    enum: ['Requested', 'Approved', 'Rejected', 'Pickup Scheduled', 'Received', 'Exchanged', 'Refunded', 'Closed'],
    default: 'Requested',
  },
  requestKey: String,
  inventoryRestoreStatus: {
    type: String,
    enum: ['Not Started', 'Processing', 'Restored', 'Failed'],
    default: 'Not Started',
  },
  inventoryRestoredAt: Date,
  refund: {
    method: { type: String, enum: ['Razorpay', 'Bank Transfer', 'UPI', 'Store Credit'] },
    status: { type: String, enum: ['Not Started', 'Pending', 'Processed', 'Failed'], default: 'Not Started' },
    amount: Number,
    providerRefundId: String,
    reference: String,
    initiatedAt: Date,
    processedAt: Date,
    failureReason: String,
  },
  auditTrail: [auditEntrySchema],
}, { timestamps: true });

returnExchangeSchema.index({ user: 1, createdAt: -1 });
returnExchangeSchema.index({ order: 1, orderItemId: 1, status: 1 });
returnExchangeSchema.index({ user: 1, requestKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('ReturnExchange', returnExchangeSchema);
