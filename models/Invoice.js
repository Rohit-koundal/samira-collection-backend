const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
  invoiceNumber: { type: String, required: true, unique: true, immutable: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true, immutable: true },
  issuedAt: { type: Date, default: Date.now, immutable: true },
  status: { type: String, enum: ['Issued', 'Credited', 'Voided'], default: 'Issued' },
  seller: {
    legalName: String,
    address: String,
    state: String,
    gstin: String,
  },
  customer: { name: String, email: String, phone: String },
  billingAddress: Object,
  shippingAddress: Object,
  lines: [{
    product: mongoose.Schema.Types.ObjectId,
    name: String,
    sku: String,
    hsn: String,
    size: String,
    color: String,
    quantity: Number,
    unitPrice: Number,
    originalPrice: Number,
    lineDiscount: Number,
    taxableAmount: Number,
    taxRate: Number,
    taxAmount: Number,
    total: Number,
  }],
  totals: {
    subtotal: Number,
    lineDiscount: Number,
    couponDiscount: Number,
    shippingCharge: Number,
    tax: Number,
    grandTotal: Number,
  },
  taxBreakdown: {
    cgst: Number,
    sgst: Number,
    igst: Number,
  },
  payment: {
    method: String,
    status: String,
    transactionId: String,
  },
  creditNotes: [{
    reference: String,
    amount: Number,
    reason: String,
    issuedAt: Date,
  }],
}, { timestamps: true });

invoiceSchema.index({ issuedAt: -1 });

module.exports = mongoose.model('Invoice', invoiceSchema);
