const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const Coupon = require('../models/Coupon');
const ReturnExchange = require('../models/ReturnExchange');
const { andFilter } = require('../services/storeService');

function scope(req, extra = {}) {
  return andFilter(extra, req.tenantFilter);
}

exports.stats = async (req, res) => {
  const [products, orders, customers, coupons, returns, revenue] = await Promise.all([
    Product.countDocuments(scope(req)),
    Order.countDocuments(scope(req)),
    User.countDocuments({ role: 'customer' }),
    Coupon.countDocuments(scope(req, { isActive: true })),
    ReturnExchange.countDocuments(scope(req, { status: 'Requested' })),
    Order.aggregate([{ $match: andFilter({ paymentStatus: 'Paid' }, req.tenantFilter) }, { $group: { _id: null, total: { $sum: '$finalAmount' } } }]),
  ]);
  res.json({ products, orders, customers, coupons, returns, revenue: revenue[0]?.total || 0 });
};
exports.recentOrders = async (req, res) => res.json(await Order.find(scope(req)).populate('user', 'name email').sort('-createdAt').limit(10));
exports.lowStock = async (req, res) => res.json(await Product.find(andFilter({
  $or: [{ stock: { $lt: 5 } }, { 'variants.stock': { $lt: 5 } }],
}, req.tenantFilter)));
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
exports.salesReport = async (req, res) => {
  const { from, to, preset } = parseReportRange(req.query);
  const createdAt = { $gte: from, $lte: to };
  const liveOrders = { createdAt, orderStatus: { $ne: 'Cancelled' } };
  const paidOrders = { createdAt, paymentStatus: 'Paid' };
  const useDaily = (to.getTime() - from.getTime()) <= 14 * 24 * 60 * 60 * 1000;

  const [orderCount, paidCount, revenue, customers, byStatus, byPayment, byCoupon, series] = await Promise.all([
    Order.countDocuments(liveOrders),
    Order.countDocuments(paidOrders),
    Order.aggregate([
      { $match: paidOrders },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } },
    ]),
    User.countDocuments({ role: 'customer', createdAt }),
    Order.aggregate([
      { $match: liveOrders },
      { $group: { _id: '$orderStatus', total: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: liveOrders },
      { $group: { _id: '$paymentMethod', total: { $sum: 1 }, revenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, '$finalAmount', 0] } } } },
    ]),
    Order.aggregate([
      { $match: { ...liveOrders, 'coupon.code': { $exists: true, $nin: [null, ''] } } },
      { $group: { _id: '$coupon.code', total: { $sum: 1 }, discount: { $sum: { $ifNull: ['$couponDiscount', 0] } } } },
      { $sort: { total: -1 } },
      { $limit: 8 },
    ]),
    Order.aggregate([
      { $match: liveOrders },
      {
        $group: {
          _id: useDaily
            ? { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } }
            : { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          orders: { $sum: 1 },
          revenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, '$finalAmount', 0] } },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
    ]),
  ]);

  res.json({
    from,
    to,
    preset,
    totals: {
      orders: orderCount,
      paidOrders: paidCount,
      revenue: revenue[0]?.total || 0,
      customers,
    },
    series: series.map((item) => ({
      label: useDaily
        ? `${item._id.day}/${item._id.month}`
        : new Date(item._id.year, item._id.month - 1, 1).toLocaleDateString('en-US', { month: 'short' }),
      orders: item.orders,
      revenue: item.revenue,
      value: item.revenue,
    })),
    statusBreakdown: byStatus.map((item) => ({ label: item._id || 'Pending', value: item.total })),
    paymentBreakdown: byPayment.map((item) => ({ label: item._id || 'COD', value: item.total, revenue: item.revenue })),
    couponUsage: byCoupon.map((item) => ({ label: item._id, value: item.total, discount: item.discount })),
  });
};

exports.productReport = async (req, res) => {
  const { from, to, preset } = parseReportRange(req.query);
  const [bestSellers, lowStock] = await Promise.all([
    Order.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, orderStatus: { $ne: 'Cancelled' } } },
      { $unwind: '$orderItems' },
      {
        $group: {
          _id: { product: '$orderItems.product', name: '$orderItems.name', sku: '$orderItems.sku' },
          sold: { $sum: { $ifNull: ['$orderItems.quantity', 1] } },
          revenue: { $sum: { $multiply: [{ $ifNull: ['$orderItems.price', 0] }, { $ifNull: ['$orderItems.quantity', 1] }] } },
        },
      },
      { $sort: { sold: -1, revenue: -1 } },
      { $limit: 20 },
    ]),
    Product.find({ $or: [{ stock: { $lt: 5 } }, { 'variants.stock': { $lt: 5 } }] }).select('name sku stock lowStockAlert variants').limit(50),
  ]);

  res.json({
    from,
    to,
    preset,
    bestSellers: bestSellers.map((item) => ({
      id: String(item._id?.product || item._id?.name),
      name: item._id?.name || 'Product',
      sku: item._id?.sku || '',
      sold: item.sold,
      revenue: item.revenue,
    })),
    lowStock,
  });
};

function parseReportRange(query = {}) {
  const now = new Date();
  if (query.from && query.to) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    to.setHours(23, 59, 59, 999);
    return { from, to, preset: 'custom' };
  }
  const preset = query.range || query.preset || '30d';
  if (preset === 'today') {
    return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()), to: now, preset };
  }
  const days = { '7d': 7, '30d': 30, '90d': 90 }[preset] || 30;
  return { from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), to: now, preset: days === 30 && preset !== '30d' ? '30d' : preset };
}

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
