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
exports.reportSummary = async (req, res) => {
  const report = await buildReport(req.query);
  return res.json(report);
};

exports.salesReport = async (req, res) => {
  const report = await buildReport(req.query);
  return res.json({
    ...report,
    months: report.timeSeries.map((entry) => entry.period),
    revenue: report.timeSeries.map((entry) => entry.netRevenue),
    orders: report.timeSeries.map((entry) => entry.orders),
  });
};

exports.productReport = async (req, res) => {
  const report = await buildReport(req.query);
  return res.json({
    bestSellers: report.topProducts,
    topCategories: report.topCategories,
    topVariants: report.topVariants,
    lowStock: report.inventory.lowStock,
    outOfStock: report.inventory.outOfStock,
  });
};

exports.reportCsv = async (req, res) => {
  const report = await buildReport(req.query);
  const rows = [
    ['period', 'gross_revenue', 'net_revenue', 'refunds', 'orders'],
    ...report.timeSeries.map((entry) => [
      entry.period, entry.grossRevenue, entry.netRevenue, entry.refunds, entry.orders,
    ]),
  ];
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="samira-report-${report.range.from.slice(0, 10)}-${report.range.to.slice(0, 10)}.csv"`);
  return res.send(`\ufeff${csv}`);
};

async function buildReport(query = {}) {
  const { from, to } = parseDateRange(query);
  const dateMatch = { createdAt: { $gte: from, $lt: to } };
  const completedPaymentStatuses = ['Paid', 'Refunded', 'Partially Refunded'];
  const periodFormat = to.getTime() - from.getTime() <= 93 * 24 * 60 * 60 * 1000 ? '%Y-%m-%d' : '%Y-%m';
  const orderFilter = { ...dateMatch, orderStatus: { $ne: 'Cancelled' } };

  const [
    financialRows,
    timeSeries,
    statusRows,
    topProducts,
    topCategories,
    topVariants,
    couponPerformance,
    paymentMethods,
    newCustomers,
    repeatCustomers,
    deliveredOrders,
    returnCount,
    inventoryProducts,
  ] = await Promise.all([
    Order.aggregate([
      { $match: dateMatch },
      { $set: { processedRefundAmount: processedRefundAmountExpression() } },
      {
        $group: {
          _id: null,
          grossRevenue: {
            $sum: {
              $cond: [
                { $in: ['$paymentStatus', completedPaymentStatuses] },
                { $ifNull: ['$totalMRP', '$finalAmount'] },
                0,
              ],
            },
          },
          collectedRevenue: {
            $sum: {
              $cond: [
                { $in: ['$paymentStatus', completedPaymentStatuses] },
                { $ifNull: ['$finalAmount', 0] },
                0,
              ],
            },
          },
          discounts: {
            $sum: {
              $cond: [
                { $in: ['$paymentStatus', completedPaymentStatuses] },
                {
                  $add: [
                    { $ifNull: ['$productDiscount', 0] },
                    { $ifNull: ['$couponDiscount', 0] },
                  ],
                },
                0,
              ],
            },
          },
          refunds: { $sum: '$processedRefundAmount' },
          orderCount: { $sum: 1 },
        },
      },
    ]),
    Order.aggregate([
      { $match: dateMatch },
      { $set: { processedRefundAmount: processedRefundAmountExpression() } },
      {
        $group: {
          _id: { $dateToString: { format: periodFormat, date: '$createdAt', timezone: 'UTC' } },
          grossRevenue: {
            $sum: {
              $cond: [
                { $in: ['$paymentStatus', completedPaymentStatuses] },
                { $ifNull: ['$totalMRP', '$finalAmount'] },
                0,
              ],
            },
          },
          collectedRevenue: {
            $sum: {
              $cond: [
                { $in: ['$paymentStatus', completedPaymentStatuses] },
                { $ifNull: ['$finalAmount', 0] },
                0,
              ],
            },
          },
          refunds: { $sum: '$processedRefundAmount' },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([
      { $match: dateMatch },
      { $group: { _id: '$orderStatus', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ]),
    Order.aggregate([
      { $match: orderFilter },
      { $unwind: '$orderItems' },
      {
        $group: {
          _id: '$orderItems.product',
          name: { $first: '$orderItems.name' },
          quantity: { $sum: { $ifNull: ['$orderItems.quantity', 1] } },
          revenue: {
            $sum: {
              $multiply: [
                { $ifNull: ['$orderItems.price', 0] },
                { $ifNull: ['$orderItems.quantity', 1] },
              ],
            },
          },
        },
      },
      { $sort: { quantity: -1, revenue: -1 } },
      { $limit: 20 },
    ]),
    Order.aggregate([
      { $match: orderFilter },
      { $unwind: '$orderItems' },
      { $lookup: { from: 'products', localField: 'orderItems.product', foreignField: '_id', as: 'product' } },
      { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { $ifNull: ['$product.category', '$orderItems.category'] },
          name: { $first: { $ifNull: ['$orderItems.categoryName', 'Uncategorised'] } },
          quantity: { $sum: { $ifNull: ['$orderItems.quantity', 1] } },
          revenue: {
            $sum: {
              $multiply: [
                { $ifNull: ['$orderItems.price', 0] },
                { $ifNull: ['$orderItems.quantity', 1] },
              ],
            },
          },
        },
      },
      { $sort: { revenue: -1, quantity: -1 } },
      { $limit: 20 },
    ]),
    Order.aggregate([
      { $match: orderFilter },
      { $unwind: '$orderItems' },
      {
        $group: {
          _id: {
            product: '$orderItems.product',
            variantId: { $ifNull: ['$orderItems.variantId', 'legacy'] },
            sku: { $ifNull: ['$orderItems.sku', ''] },
            size: { $ifNull: ['$orderItems.size', ''] },
            color: { $ifNull: ['$orderItems.color', ''] },
          },
          name: { $first: '$orderItems.name' },
          quantity: { $sum: { $ifNull: ['$orderItems.quantity', 1] } },
          revenue: {
            $sum: {
              $multiply: [
                { $ifNull: ['$orderItems.price', 0] },
                { $ifNull: ['$orderItems.quantity', 1] },
              ],
            },
          },
        },
      },
      { $sort: { quantity: -1, revenue: -1 } },
      { $limit: 20 },
    ]),
    Order.aggregate([
      { $match: { ...dateMatch, 'coupon.code': { $exists: true, $ne: null } } },
      {
        $group: {
          _id: '$coupon.code',
          orders: { $sum: 1 },
          discounts: { $sum: { $ifNull: ['$couponDiscount', 0] } },
          revenue: {
            $sum: {
              $cond: [
                { $in: ['$paymentStatus', completedPaymentStatuses] },
                { $ifNull: ['$finalAmount', 0] },
                0,
              ],
            },
          },
        },
      },
      { $sort: { revenue: -1 } },
    ]),
    Order.aggregate([
      { $match: dateMatch },
      {
        $group: {
          _id: { $cond: [{ $eq: ['$paymentMethod', 'COD'] }, 'COD', 'Online'] },
          orders: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $in: ['$paymentStatus', completedPaymentStatuses] },
                { $ifNull: ['$finalAmount', 0] },
                0,
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    User.countDocuments({ role: 'customer', createdAt: { $gte: from, $lt: to } }),
    Order.aggregate([
      { $match: dateMatch },
      { $group: { _id: '$user', orders: { $sum: 1 } } },
      { $match: { orders: { $gte: 2 } } },
      { $count: 'count' },
    ]),
    Order.countDocuments({ ...dateMatch, orderStatus: 'Delivered' }),
    ReturnExchange.countDocuments({ createdAt: { $gte: from, $lt: to } }),
    Product.find({ isActive: true }).select('name sku stock lowStockAlert variants').lean(),
  ]);

  const financial = financialRows[0] || {};
  const refunds = money(financial.refunds);
  const collectedRevenue = money(financial.collectedRevenue);
  const orderCount = Number(financial.orderCount || 0);
  const inventory = buildInventorySummary(inventoryProducts);
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    metrics: {
      grossRevenue: money(financial.grossRevenue),
      netRevenue: money(collectedRevenue - refunds),
      discounts: money(financial.discounts),
      refunds,
      orderCount,
      averageOrderValue: orderCount ? money((collectedRevenue - refunds) / orderCount) : 0,
      returnRate: deliveredOrders ? Math.round((returnCount / deliveredOrders) * 10000) / 100 : 0,
      newCustomers,
      repeatCustomers: Number(repeatCustomers[0]?.count || 0),
    },
    timeSeries: timeSeries.map((entry) => ({
      period: entry._id,
      grossRevenue: money(entry.grossRevenue),
      refunds: money(entry.refunds),
      netRevenue: money(Number(entry.collectedRevenue || 0) - Number(entry.refunds || 0)),
      orders: Number(entry.orders || 0),
    })),
    ordersByStatus: statusRows.map((entry) => ({ status: entry._id || 'Unknown', count: entry.count })),
    topProducts: topProducts.map((entry) => ({
      productId: entry._id,
      name: entry.name || 'Product',
      quantity: entry.quantity,
      revenue: money(entry.revenue),
    })),
    topCategories: topCategories.map((entry) => ({
      categoryId: entry._id,
      name: entry.name || 'Category',
      quantity: entry.quantity,
      revenue: money(entry.revenue),
    })),
    topVariants: topVariants.map((entry) => ({
      productId: entry._id.product,
      variantId: entry._id.variantId,
      sku: entry._id.sku,
      size: entry._id.size,
      color: entry._id.color,
      name: entry.name || 'Variant',
      quantity: entry.quantity,
      revenue: money(entry.revenue),
    })),
    inventory,
    couponPerformance: couponPerformance.map((entry) => ({
      code: entry._id,
      orders: entry.orders,
      discounts: money(entry.discounts),
      revenue: money(entry.revenue),
    })),
    payments: paymentMethods.map((entry) => ({
      method: entry._id,
      orders: entry.orders,
      revenue: money(entry.revenue),
    })),
  };
}

function buildInventorySummary(products) {
  const lowStock = [];
  const outOfStock = [];
  for (const product of products) {
    const variants = Array.isArray(product.variants) && product.variants.length
      ? product.variants.map((variant) => ({
        productId: product._id,
        variantId: variant._id,
        name: product.name,
        sku: variant.sku || product.sku,
        stock: Math.max(0, Number(variant.stock || 0)),
        reservedStock: Math.max(0, Number(variant.reservedStock || 0)),
        threshold: Number(product.lowStockAlert || 5),
      }))
      : [{
        productId: product._id,
        name: product.name,
        sku: product.sku,
        stock: Math.max(0, Number(product.stock || 0)),
        reservedStock: Math.max(0, Number(product.reservedStock || 0)),
        threshold: Number(product.lowStockAlert || 5),
      }];
    for (const item of variants) {
      if (item.stock <= 0) outOfStock.push(item);
      else if (item.stock <= item.threshold) lowStock.push(item);
    }
  }
  return {
    lowStock: lowStock.sort((a, b) => a.stock - b.stock).slice(0, 100),
    outOfStock: outOfStock.slice(0, 100),
  };
}

function parseDateRange(query) {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const from = query.from ? new Date(query.from) : defaultFrom;
  const requestedTo = query.to ? new Date(query.to) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(requestedTo.getTime())) throw reportValidationError('Invalid report date range');
  const to = query.to ? new Date(requestedTo.getTime() + 24 * 60 * 60 * 1000) : requestedTo;
  if (from >= to) throw reportValidationError('Report start date must be before end date');
  if (to.getTime() - from.getTime() > 2 * 366 * 24 * 60 * 60 * 1000) throw reportValidationError('Report range cannot exceed two years');
  return { from, to };
}

function reportValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}

function processedRefundAmountExpression() {
  return {
    $divide: [
      {
        $sum: {
          $map: {
            input: { $ifNull: ['$refunds', []] },
            as: 'refund',
            in: {
              $cond: [
                { $eq: ['$$refund.status', 'Processed'] },
                { $ifNull: ['$$refund.amount', 0] },
                0,
              ],
            },
          },
        },
      },
      100,
    ],
  };
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
