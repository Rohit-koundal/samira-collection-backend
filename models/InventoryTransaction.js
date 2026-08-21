const mongoose = require('mongoose');

/**
 * Append-only ledger of every stock movement.
 *
 * Stock on the Product document is the running balance; this collection
 * explains how it got there, which is what makes oversell and
 * double-restore bugs debuggable after the fact.
 */
const INVENTORY_TRANSACTION_TYPES = [
  'SALE',
  'CANCELLATION',
  'RETURN',
  'MANUAL_ADJUSTMENT',
  'RESTOCK',
  'IMPORT',
];

const inventoryTransactionSchema = new mongoose.Schema({
  // Reserved for the multi-tenant phase; single-store data leaves it unset.
  storeId: { type: mongoose.Schema.Types.ObjectId, index: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: String, default: '' },
  sku: String,
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  type: { type: String, enum: INVENTORY_TRANSACTION_TYPES, required: true },
  // Signed: negative removes stock, positive returns it.
  quantity: { type: Number, required: true },
  stockBefore: Number,
  stockAfter: Number,
  reason: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

inventoryTransactionSchema.index({ product: 1, createdAt: -1 });
inventoryTransactionSchema.index({ order: 1, type: 1 });
inventoryTransactionSchema.index({ storeId: 1, createdAt: -1 });

module.exports = mongoose.model('InventoryTransaction', inventoryTransactionSchema);
module.exports.INVENTORY_TRANSACTION_TYPES = INVENTORY_TRANSACTION_TYPES;
