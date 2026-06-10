const Order = require('../models/Order');
const Product = require('../models/Product');
const Settings = require('../models/Settings');
const Coupon = require('../models/Coupon');

exports.createOrder = async (req, res) => {
  try {
    if (!req.user?.isPhoneVerified) {
      return res.status(403).json({ message: 'Please verify your mobile number to continue checkout.' });
    }
    const { items, totals } = await prepareOrder(req.body.orderItems, req.body.coupon?.code);
    const order = await Order.create({
      ...req.body,
      orderItems: items,
      user: req.user._id,
      paymentMethod: req.body.paymentMethod || 'COD',
      paymentProvider: req.body.paymentProvider || (req.body.paymentMethod === 'COD' ? 'COD' : 'Razorpay'),
      paymentStatus: req.body.paymentMethod === 'COD' ? 'Pending' : (req.body.paymentStatus || 'Pending'),
      ...totals,
      statusTimeline: [{ status: 'Pending', date: new Date(), note: 'Order placed' }],
    });
    await reduceStock(items);
    res.status(201).json(order);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
exports.createCodOrder = async (req, res) => {
  req.body.paymentMethod = 'COD';
  req.body.paymentProvider = 'COD';
  return exports.createOrder(req, res);
};
exports.myOrders = async (req, res) => res.json(await Order.find({ user: req.user._id }).sort('-createdAt'));
exports.getOrder = async (req, res) => {
  const order = await Order.findById(req.params.id).populate('user', 'name email phone');
  if (!order) return res.status(404).json({ message: 'Order not found' });
  if (req.user.role !== 'admin' && String(order.user._id || order.user) !== String(req.user._id)) {
    return res.status(403).json({ message: 'Not allowed to view this order' });
  }
  res.json(order);
};
exports.adminOrders = async (req, res) => res.json(await Order.find().populate('user', 'name email phone').sort('-createdAt'));
exports.updateOrderStatus = async (req, res) => {
  const order = await Order.findById(req.params.id);
  order.orderStatus = req.body.orderStatus;
  order.statusTimeline.push({ status: req.body.orderStatus, date: new Date(), note: req.body.note });
  await order.save();
  res.json(order);
};
exports.updatePaymentStatus = async (req, res) => res.json(await Order.findByIdAndUpdate(req.params.id, { paymentStatus: req.body.paymentStatus }, { new: true }));
exports.cancelOrder = async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: 'Order not found' });
  if (req.user.role !== 'admin' && String(order.user) !== String(req.user._id)) return res.status(403).json({ message: 'Not allowed' });
  if (['Delivered', 'Cancelled'].includes(order.orderStatus)) return res.status(400).json({ message: 'Order cannot be cancelled' });
  order.orderStatus = 'Cancelled';
  order.statusTimeline.push({ status: 'Cancelled', date: new Date(), note: 'Order cancelled' });
  await order.save();
  res.json(order);
};
exports.receipt = async (req, res) => {
  const order = await Order.findById(req.params.id).populate('user', 'name email phone').lean();
  if (!order) return res.status(404).json({ message: 'Order not found' });
  if (req.user.role !== 'admin' && String(order.user._id || order.user) !== String(req.user._id)) return res.status(403).json({ message: 'Not allowed to view this receipt' });
  res.json(await buildReceipt(order));
};

async function prepareOrder(orderItems = [], couponCode) {
  if (!Array.isArray(orderItems) || !orderItems.length) throw new Error('Order items are required');
  const settings = await Settings.findOne();
  const items = [];
  let totalMRP = 0;
  let sellingTotal = 0;

  for (const item of orderItems) {
    const product = await Product.findById(item.product);
    if (!product) throw new Error(`${item.name || 'Product'} not found`);
    if (product.stock < item.quantity) throw new Error(`${product.name} has only ${product.stock} in stock`);
    const quantity = Number(item.quantity || 1);
    totalMRP += Number(product.originalPrice || product.price) * quantity;
    sellingTotal += Number(product.price) * quantity;
    items.push({
      product: product._id,
      name: product.name,
      image: product.images?.[0]?.url,
      size: item.size,
      color: item.color,
      quantity,
      price: product.price,
      originalPrice: product.originalPrice || product.price,
    });
  }

  let couponDiscount = 0;
  let coupon = null;
  if (couponCode) {
    coupon = await Coupon.findOne({ code: String(couponCode).toUpperCase(), isActive: true });
    if (!coupon || coupon.expiryDate < new Date()) throw new Error('Invalid or expired coupon');
    if (sellingTotal < coupon.minOrderAmount) throw new Error('Minimum order amount not met');
    const raw = coupon.type === 'Percentage' ? (sellingTotal * coupon.discountValue) / 100 : coupon.discountValue;
    couponDiscount = Math.min(raw, coupon.maxDiscountAmount || raw, sellingTotal);
  }

  const productDiscount = Math.max(0, totalMRP - sellingTotal);
  const deliveryCharge = sellingTotal >= Number(settings?.freeShippingMinAmount || 999) ? 0 : Number(settings?.deliveryCharge || 99);
  const codCharge = 0;
  const finalAmount = Math.max(0, sellingTotal - couponDiscount + deliveryCharge + codCharge);
  return {
    items,
    totals: {
      totalMRP,
      productDiscount,
      couponDiscount,
      discount: productDiscount + couponDiscount,
      deliveryCharge,
      codCharge,
      finalAmount,
      coupon: coupon ? { code: coupon.code, discountAmount: couponDiscount } : undefined,
    },
  };
}

async function reduceStock(items) {
  await Promise.all(items.map((item) => Product.findByIdAndUpdate(item.product, { $inc: { stock: -Number(item.quantity || 1) } })));
}

async function buildReceipt(order) {
  const settings = await Settings.findOne().lean();
  return {
    orderId: order._id,
    orderDate: order.createdAt,
    customer: order.user,
    shippingAddress: order.shippingAddress,
    items: order.orderItems,
    paymentMethod: order.paymentMethod,
    paymentProvider: order.paymentProvider,
    paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus,
    statusTimeline: order.statusTimeline,
    totalMRP: order.totalMRP,
    productDiscount: order.productDiscount || Math.max(0, (order.totalMRP || 0) - ((order.totalMRP || 0) - (order.discount || 0))),
    couponDiscount: order.couponDiscount || order.coupon?.discountAmount || 0,
    deliveryCharge: order.deliveryCharge || 0,
    codCharge: order.codCharge || 0,
    finalAmount: order.finalAmount,
    coupon: order.coupon,
    razorpayOrderId: order.razorpayOrderId,
    razorpayPaymentId: order.razorpayPaymentId,
    paymentFailureReason: order.paymentFailureReason,
    storeDetails: {
      storeName: settings?.storeName || 'Samira Collection',
      contactEmail: settings?.contactEmail,
      contactPhone: settings?.contactPhone,
      whatsappNumber: settings?.whatsappNumber,
      address: settings?.address,
    },
    policies: {
      returnPolicy: settings?.returnPolicy || 'Return/exchange as per store policy.',
    },
  };
}

exports.prepareOrder = prepareOrder;
exports.reduceStock = reduceStock;
