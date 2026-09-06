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
  }],
  shippingAddress: Object,
  billingAddress: Object,
  invoiceNumber: String,
  invoiceDate: Date,
  invoiceSeller: { storeName: String, legalBusinessName: String, gstin: String, contactEmail: String, contactPhone: String, whatsappNumber: String, address: String, billingAddress: String, returnPolicy: String },
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
  attribution: {
    source: String,
    campaign: String,
    reelId: String,
  },
  prepaidDiscount: { type: Number, default: 0 },
  codConfirmationStatus: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'CANCELLED'], default: 'NOT_REQUIRED' },
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
