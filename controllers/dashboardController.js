const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const Coupon = require('../models/Coupon');
const ReturnExchange = require('../models/ReturnExchange');
const { andFilter } = require('../services/storeService');
const { asyncHandler } = require('../middleware/validate');
const { dashboardOverview, stockWarning } = require('../services/dashboardAnalytics');

function scope(req, extra = {}) {
  return andFilter(extra, req.tenantFilter);
}

exports.stats = async (req, res) => {
  const scopedCustomers = req.tenantFilter && Object.keys(req.tenantFilter).length
    ? Order.distinct('user', scope(req, { user: { $ne: null } })).then((ids) => ids.length)
    : User.countDocuments({ role: 'customer' });
  const [products, orders, customers, coupons, returns, revenue] = await Promise.all([
    Product.countDocuments(scope(req)),
    Order.countDocuments(scope(req)),
    scopedCustomers,
    Coupon.countDocuments(scope(req, { isActive: true })),
    ReturnExchange.countDocuments(scope(req, { status: 'Requested' })),
    Order.aggregate([{ $match: andFilter({ paymentStatus: 'Paid' }, req.tenantFilter) }, { $group: { _id: null, total: { $sum: '$finalAmount' } } }]),
  ]);
  res.json({ products, orders, customers, coupons, returns, revenue: revenue[0]?.total || 0 });
};
exports.recentOrders = async (req, res) => res.json(await Order.find(scope(req)).populate('user', 'name email').sort('-createdAt').limit(10));
exports.lowStock = asyncHandler(async (req, res) => res.json(await Product.find(scope(req, {
  isActive: true, isArchived: { $ne: true }, $expr: stockWarning,
}))));
exports.overview = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json(await dashboardOverview(req.query, req.tenantFilter));
});
exports.salesReport = async (req, res) => {
  const { from, to, preset } = parseReportRange(req.query);
  const createdAt = { $gte: from, $lte: to };
  const liveOrders = scope(req, { createdAt, orderStatus: { $ne: 'Cancelled' } });
  const paidOrders = scope(req, { createdAt, paymentStatus: 'Paid' });
  const useDaily = (to.getTime() - from.getTime()) <= 14 * 24 * 60 * 60 * 1000;

  const [orderCount, paidCount, revenue, customers, byStatus, byPayment, byCoupon, series] = await Promise.all([
    Order.countDocuments(liveOrders),
    Order.countDocuments(paidOrders),
    Order.aggregate([
      { $match: paidOrders },
      { $group: { _id: null, total: { $sum: '$finalAmount' } } },
    ]),
    Order.distinct('user', scope(req, { createdAt, user: { $ne: null } })).then((ids) => ids.length),
    Order.aggregate([
      { $match: liveOrders },
      { $group: { _id: '$orderStatus', total: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: liveOrders },
      { $group: { _id: '$paymentMethod', total: { $sum: 1 }, revenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, '$finalAmount', 0] } } } },
    ]),
    Order.aggregate([
      { $match: scope(req, { createdAt, orderStatus: { $ne: 'Cancelled' }, 'coupon.code': { $exists: true, $nin: [null, ''] } }) },
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
      { $match: scope(req, { createdAt: { $gte: from, $lte: to }, orderStatus: { $ne: 'Cancelled' } }) },
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
    Product.find(scope(req, { $or: [{ stock: { $lt: 5 } }, { 'variants.stock': { $lt: 5 } }] })).select('name sku stock lowStockAlert variants').limit(50),
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
