const mongoose = require('mongoose');

const inventoryMovementSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  variantId: String,
  sku: String,
  quantity: { type: Number, required: true },
  movementType: {
    type: String,
    enum: ['RESERVATION', 'RESERVATION_RELEASE', 'SALE_COMMIT', 'CANCELLATION_RESTORE', 'RETURN_RESTORE'],
    required: true,
  },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  previousStock: { type: Number, required: true },
  newStock: { type: Number, required: true },
  previousReservedStock: { type: Number, default: 0 },
  newReservedStock: { type: Number, default: 0 },
  referenceId: { type: String, required: true, unique: true },
  metadata: {
    reason: String,
    returnRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ReturnExchange' },
  },
}, { timestamps: true });

inventoryMovementSchema.index({ product: 1, variantId: 1, createdAt: -1 });
inventoryMovementSchema.index({ order: 1, createdAt: 1 });
inventoryMovementSchema.index({ movementType: 1, createdAt: -1 });

module.exports = mongoose.model('InventoryMovement', inventoryMovementSchema);
