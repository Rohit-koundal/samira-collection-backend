const mongoose = require('mongoose');

const returnExchangeSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['return', 'exchange'], required: true },
  reason: String,
  comment: String,
  adminComment: String,
  status: { type: String, enum: ['Requested', 'Approved', 'Rejected', 'Pickup Scheduled', 'Received', 'Exchanged', 'Refunded', 'Closed'], default: 'Requested' },
}, { timestamps: true });

module.exports = mongoose.model('ReturnExchange', returnExchangeSchema);
