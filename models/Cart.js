const mongoose = require('mongoose');

const cartSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  sessionId: { type: String, trim: true, maxlength: 120 },
  mergedGuestCarts: [{ type: mongoose.Schema.Types.ObjectId }],
  items: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    size: String,
    color: String,
    variantId: String,
    quantity: { type: Number, default: 1, min: 1, validate: Number.isInteger },
    selected: { type: Boolean, default: true },
    price: Number,
  }],
}, { timestamps: true, optimisticConcurrency: true });

cartSchema.index({ user: 1 }, { unique: true, sparse: true });
cartSchema.index({ sessionId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Cart', cartSchema);
