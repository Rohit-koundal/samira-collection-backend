const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderItems: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    variantId: String,
    sku: String,
    name: String,
    image: String,
    size: String,
    color: String,
    quantity: { type: Number, min: 1, required: true },
    price: { type: Number, min: 0, required: true },
    originalPrice: { type: Number, min: 0 },
  }],
  shippingAddress: Object,
  paymentMethod: { type: String, enum: ['COD', 'UPI', 'CARD', 'Card', 'NETBANKING', 'WALLET', 'Razorpay'], default: 'COD' },
  paymentProvider: { type: String, default: 'COD' },
  paymentStatus: { type: String, enum: ['Pending', 'Processing', 'Paid', 'Failed', 'Refund Pending', 'Partially Refunded', 'Refunded'], default: 'Pending' },
  orderStatus: { type: String, enum: ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivery Failed', 'Delivered', 'Cancelled', 'Return Requested', 'Exchange Requested', 'Return Approved', 'Return Rejected', 'Returned', 'Refunded'], default: 'Pending' },
  coupon: Object,
  totalMRP: Number,
  productDiscount: Number,
  couponDiscount: Number,
  discount: Number,
  deliveryCharge: Number,
  codCharge: Number,
  taxAmount: { type: Number, default: 0 },
  finalAmount: Number,
  currency: { type: String, default: 'INR', uppercase: true },
  expectedAmount: Number,
  razorpayOrderId: { type: String, trim: true },
  razorpayPaymentId: { type: String, trim: true },
  paymentFailureReason: String,
  paymentProcessedAt: Date,
  checkoutSnapshotHash: String,
  checkoutVersion: { type: Number, default: 1 },
  idempotencyKey: String,
  inventoryStatus: {
    type: String,
    enum: ['Not Reserved', 'Reserving', 'Reserved', 'Committing', 'Committed', 'Releasing', 'Released', 'Restoring', 'Restored'],
    default: 'Not Reserved',
  },
  reservationExpiresAt: Date,
  refunds: [{
    idempotencyKey: { type: String, required: true },
    razorpayRefundId: String,
    amount: { type: Number, min: 1, required: true },
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['Initiating', 'Pending', 'Processed', 'Failed'], default: 'Initiating' },
    reason: String,
    initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
    processedAt: Date,
    failureReason: String,
  }],
  paymentAudit: [{
    action: String,
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    referenceId: String,
    amount: Number,
    status: String,
    at: { type: Date, default: Date.now },
    note: String,
  }],
  statusTimeline: [{ status: String, date: Date, note: String }],
  adminNotes: String,
}, { timestamps: true });

orderSchema.index({ razorpayOrderId: 1 }, { unique: true, sparse: true });
orderSchema.index({ razorpayPaymentId: 1 }, { unique: true, sparse: true });
orderSchema.index({ user: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
orderSchema.index({ user: 1, paymentStatus: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1, createdAt: -1 });
orderSchema.index({ paymentStatus: 1, createdAt: -1 });
orderSchema.index({ inventoryStatus: 1, reservationExpiresAt: 1 });

module.exports = mongoose.model('Order', orderSchema);
