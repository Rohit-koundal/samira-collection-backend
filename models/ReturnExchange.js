const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const RETURN_STATUSES = [
  'Requested',
  'Approved',
  'Rejected',
  'Pickup Scheduled',
  'Received',
  'Exchanged',
  'Refunded',
  'Closed',
];

const returnExchangeSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderItemId: String,
  variantId: String,
  size: String,
  color: String,
  sku: String,
  quantity: { type: Number, default: 1, min: 1 },
  type: { type: String, enum: ['return', 'exchange'], required: true },
  reason: String,
  comment: String,
  photos: [String],
  exchangeVariantId: String,
  exchangeSize: String,
  exchangeColor: String,
  adminComment: String,
  status: { type: String, enum: RETURN_STATUSES, default: 'Requested' },
  inventoryRestored: { type: Boolean, default: false },
  inventoryRestoredAt: Date,
  exchangeDeducted: { type: Boolean, default: false },
  pickupScheduledAt: Date,
}, { timestamps: true });

returnExchangeSchema.plugin(storeIdPlugin);
returnExchangeSchema.index({ order: 1, product: 1, createdAt: -1 });
returnExchangeSchema.index({ user: 1, createdAt: -1 });
returnExchangeSchema.index({ storeId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ReturnExchange', returnExchangeSchema);
module.exports.RETURN_STATUSES = RETURN_STATUSES;
