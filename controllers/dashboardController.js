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
exports.overview = async (req, res) => {
  const now = new Date();
  const currentMonthStart = startOfMonth(now);
  const previousMonthStart = startOfMonth(addMonths(now, -1));
  const sixMonthsAgo = startOfMonth(addMonths(now, -5));
  const orderStatuses = ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled', 'Return Requested', 'Exchange Requested', 'Returned', 'Refunded'];

  const [
    totalProducts,
    totalCustomers,
    totalCoupons,
    totalOrders,
    lifetimeRevenue,
    currentMonthRevenue,
    previousMonthRevenue,
    currentMonthOrders,
    previousMonthOrders,
    currentMonthCustomers,
    previousMonthCustomers,
    currentMonthProducts,
    previousMonthProducts,
    monthlyRevenue,
    statusBreakdown,
    recentOrders,
    topProducts,
  ] = await Promise.all([
    Product.countDocuments(),
    User.countDocuments({ role: 'customer' }),
    Coupon.countDocuments({ isActive: true }),
    Order.countDocuments(),
    Order.aggregate([
      { $match: { paymentStatus: 'Paid' } },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } },
    ]),
    Order.aggregate([
      { $match: { paymentStatus: 'Paid', createdAt: { $gte: currentMonthStart } } },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } },
    ]),
    Order.aggregate([
      { $match: { paymentStatus: 'Paid', createdAt: { $gte: previousMonthStart, $lt: currentMonthStart } } },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } },
    ]),
    Order.countDocuments({ createdAt: { $gte: currentMonthStart } }),
    Order.countDocuments({ createdAt: { $gte: previousMonthStart, $lt: currentMonthStart } }),
    User.countDocuments({ role: 'customer', createdAt: { $gte: currentMonthStart } }),
    User.countDocuments({ role: 'customer', createdAt: { $gte: previousMonthStart, $lt: currentMonthStart } }),
    Product.countDocuments({ createdAt: { $gte: currentMonthStart } }),
    Product.countDocuments({ createdAt: { $gte: previousMonthStart, $lt: currentMonthStart } }),
    Order.aggregate([
      { $match: { createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          revenue: {
            $sum: {
              $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, '$finalAmount', 0],
            },
          },
          orders: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]),
    Order.aggregate([
      {
        $group: {
          _id: '$orderStatus',
          total: { $sum: 1 },
        },
      },
    ]),
    Order.find().populate('user', 'name email').sort('-createdAt').limit(5).lean(),
    Order.aggregate([
      { $unwind: '$orderItems' },
      {
        $group: {
          _id: {
            product: '$orderItems.product',
            name: '$orderItems.name',
            image: '$orderItems.image',
          },
          sold: { $sum: { $ifNull: ['$orderItems.quantity', 1] } },
          revenue: {
            $sum: {
              $multiply: [
                { $ifNull: ['$orderItems.price', 0] },
                { $ifNull: ['$orderItems.quantity', 1] },
              ],
            },
          },
          price: { $first: '$orderItems.price' },
          originalPrice: { $first: '$orderItems.originalPrice' },
          image: { $first: '$orderItems.image' },
        },
      },
      { $sort: { sold: -1, revenue: -1 } },
      { $limit: 5 },
    ]),
  ]);

  const revenueMap = new Map(monthlyRevenue.map((item) => [monthKey(item._id.year, item._id.month), Number(item.revenue || 0)]));
  const salesOverview = buildMonthSeries(sixMonthsAgo, 6).map((entry) => ({
    label: entry.label,
    value: revenueMap.get(entry.key) || 0,
  }));

  const statusMap = new Map(statusBreakdown.map((item) => [String(item._id || 'Pending'), Number(item.total || 0)]));
  const orderOverview = orderStatuses
    .map((status) => ({ label: status, value: statusMap.get(status) || 0 }))
    .filter((item) => item.value > 0);

  const stats = {
    sales: metricSummaryWithValue(currentMonthRevenue[0]?.total || 0, currentMonthRevenue[0]?.total || 0, previousMonthRevenue[0]?.total || 0, 'vs last month'),
    orders: metricSummaryWithValue(totalOrders, currentMonthOrders, previousMonthOrders, 'vs last month'),
    customers: metricSummaryWithValue(totalCustomers, currentMonthCustomers, previousMonthCustomers, 'vs last month'),
    products: metricSummaryWithValue(totalProducts, currentMonthProducts, previousMonthProducts, 'vs last month'),
    revenue: metricSummaryWithValue(lifetimeRevenue[0]?.total || 0, currentMonthRevenue[0]?.total || 0, previousMonthRevenue[0]?.total || 0, 'vs last month'),
    coupons: totalCoupons,
    totalOrders,
  };

  res.json({
    stats,
    salesOverview,
    orderOverview,
    recentOrders: recentOrders.map((order) => ({
      ...order,
      itemsCount: Array.isArray(order.orderItems) ? order.orderItems.reduce((sum, item) => sum + Number(item.quantity || 1), 0) : 0,
    })),
    topProducts: topProducts.map((product) => ({
      id: String(product._id?.product || product._id?.name || product._id),
      name: product._id?.name || 'Product',
      image: product.image || product._id?.image || '',
      sold: Number(product.sold || 0),
      revenue: Number(product.revenue || 0),
      price: Number(product.price || 0),
      originalPrice: Number(product.originalPrice || 0),
    })),
  });
};
exports.salesReport = async (req, res) => res.json({ months: [], revenue: [] });
exports.productReport = async (req, res) => res.json({ bestSellers: [], lowStock: [] });

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function buildMonthSeries(startDate, months) {
  return Array.from({ length: months }, (_, index) => {
    const date = new Date(startDate.getFullYear(), startDate.getMonth() + index, 1);
    return {
      key: monthKey(date.getFullYear(), date.getMonth() + 1),
      label: date.toLocaleDateString('en-US', { month: 'short' }),
    };
  });
}

function metricSummaryWithValue(value, current, previous, note) {
  const delta = previous > 0 ? Math.round((((current - previous) / previous) * 100) * 10) / 10 : (current > 0 ? 100 : 0);
  return { value, delta, note };
}
