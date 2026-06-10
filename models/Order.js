const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderItems: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    image: String,
    size: String,
    color: String,
    quantity: Number,
    price: Number,
    originalPrice: Number,
  }],
  shippingAddress: Object,
  paymentMethod: { type: String, enum: ['COD', 'UPI', 'CARD', 'Card', 'NETBANKING', 'WALLET', 'Razorpay'], default: 'COD' },
  paymentProvider: { type: String, default: 'COD' },
  paymentStatus: { type: String, enum: ['Pending', 'Paid', 'Failed', 'Refunded'], default: 'Pending' },
  orderStatus: { type: String, enum: ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'], default: 'Pending' },
  coupon: Object,
  totalMRP: Number,
  productDiscount: Number,
  couponDiscount: Number,
  discount: Number,
  deliveryCharge: Number,
  codCharge: Number,
  finalAmount: Number,
  razorpayOrderId: String,
  razorpayPaymentId: String,
  paymentFailureReason: String,
  statusTimeline: [{ status: String, date: Date, note: String }],
  adminNotes: String,
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
