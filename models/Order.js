const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

/**
 * Explicit payment lifecycle. `paymentStatus` is kept for the existing admin
 * and customer screens; `paymentState` is the machine-readable state used by
 * the payment flow and the Razorpay webhook.
 */
const PAYMENT_STATES = ['PENDING', 'AUTHORIZED', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'];

const PAYMENT_STATE_TO_STATUS = {
  PENDING: 'Pending',
  AUTHORIZED: 'Pending',
  PAID: 'Paid',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Paid',
};

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderItems: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    categoryName: String,
    name: String,
    productName: String,
    sku: String,
    image: String,
    size: String,
    color: String,
    variantId: String,
    quantity: Number,
    price: Number,
    originalPrice: Number,
    discount: Number,
    tax: { type: Number, default: 0 },
    shippingWeightKg: Number,
  }],
  shippingAddress: Object,
  shippingQuote: Object,
  shippingOperation: { type: String, default: '', select: false },
  shippingOperationUntil: { type: Date, select: false },
  billingAddress: Object,
  invoiceNumber: String,
  invoiceDate: Date,
  invoiceSeller: { storeName: String, legalBusinessName: String, gstin: String, contactEmail: String, contactPhone: String, whatsappNumber: String, address: String, billingAddress: String, returnPolicy: String, logoUrl: String, invoiceNote: String },
  shipment: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment' },
  deliveredAt: Date,
  paymentMethod: { type: String, enum: ['COD', 'UPI', 'CARD', 'Card', 'NETBANKING', 'WALLET', 'Razorpay'], default: 'COD' },
  paymentProvider: { type: String, default: 'COD' },
  paymentStatus: { type: String, enum: ['Pending', 'Paid', 'Failed', 'Refunded'], default: 'Pending' },
  paymentState: { type: String, enum: PAYMENT_STATES, default: 'PENDING' },
  orderStatus: { type: String, enum: ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'], default: 'Pending' },
  coupon: Object,
  totalMRP: Number,
  productDiscount: Number,
  couponDiscount: Number,
  discount: Number,
  deliveryCharge: Number,
  codCharge: Number,
  platformFee: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  taxRate: { type: Number, default: 0 },
  finalAmount: Number,
  razorpayOrderId: String,
  razorpayPaymentId: String,
  paymentFailureReason: String,
  refundedAmount: { type: Number, default: 0, min: 0 },
  refunds: [{
    providerRefundId: { type: String, maxlength: 120 },
    paymentId: { type: String, maxlength: 120 },
    provider: { type: String, maxlength: 40 },
    amount: { type: Number, min: 0 },
    currency: { type: String, default: 'INR', maxlength: 10 },
    status: { type: String, enum: ['PROCESSED', 'FAILED'], default: 'PROCESSED' },
    note: { type: String, maxlength: 500 },
    processedAt: Date,
  }],
  paymentEvents: { type: [{
    state: String,
    status: String,
    amount: Number,
    reference: String,
    note: String,
    source: String,
    actor: { id: String, name: String },
    date: { type: Date, default: Date.now },
  }], select: false },

  // Idempotency guards. Each side effect is claimed once via a conditional
  // update so retries, duplicate webhooks and double clicks are no-ops.
  inventoryDeducted: { type: Boolean, default: false },
  inventoryDeductedAt: Date,
  inventoryRestored: { type: Boolean, default: false },
  inventoryRestoredAt: Date,
  couponConsumed: { type: Boolean, default: false },
  couponReleased: { type: Boolean, default: false },

  statusTimeline: [{ status: String, date: Date, note: String }],
  adminNotes: String,
  staffNotes: { type: [{
    text: { type: String, maxlength: 1000 },
    author: { id: String, name: String },
    date: { type: Date, default: Date.now },
  }], select: false },
  attribution: {
    source: String,
    campaign: String,
    reelId: String,
  },
  prepaidDiscount: { type: Number, default: 0 },
  codConfirmationStatus: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'CANCELLED'], default: 'NOT_REQUIRED' },
  revision: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

orderSchema.plugin(storeIdPlugin);

orderSchema.index({ razorpayOrderId: 1 }, { sparse: true });
orderSchema.index({ user: 1, paymentStatus: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ storeId: 1, createdAt: -1 });
orderSchema.index({ storeId: 1, user: 1, createdAt: -1 });
orderSchema.index({ storeId: 1, orderStatus: 1, createdAt: -1 });
orderSchema.index({ storeId: 1, paymentStatus: 1, createdAt: -1 });
orderSchema.index({ invoiceNumber: 1 }, { sparse: true });

module.exports = mongoose.model('Order', orderSchema);
module.exports.PAYMENT_STATES = PAYMENT_STATES;
module.exports.PAYMENT_STATE_TO_STATUS = PAYMENT_STATE_TO_STATUS;
