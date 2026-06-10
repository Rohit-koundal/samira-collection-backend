const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const Coupon = require('../models/Coupon');
const ReturnExchange = require('../models/ReturnExchange');

exports.stats = async (req, res) => {
  const [products, orders, customers, coupons, returns, revenue] = await Promise.all([
    Product.countDocuments(),
    Order.countDocuments(),
    User.countDocuments({ role: 'customer' }),
    Coupon.countDocuments({ isActive: true }),
    ReturnExchange.countDocuments({ status: 'Requested' }),
    Order.aggregate([{ $match: { paymentStatus: 'Paid' } }, { $group: { _id: null, total: { $sum: '$finalAmount' } } }]),
  ]);
  res.json({ products, orders, customers, coupons, returns, revenue: revenue[0]?.total || 0 });
};
exports.recentOrders = async (req, res) => res.json(await Order.find().populate('user', 'name email').sort('-createdAt').limit(10));
exports.lowStock = async (req, res) => res.json(await Product.find({ stock: { $lt: 5 } }));
exports.salesReport = async (req, res) => res.json({ months: [], revenue: [] });
exports.productReport = async (req, res) => res.json({ bestSellers: [], lowStock: [] });
