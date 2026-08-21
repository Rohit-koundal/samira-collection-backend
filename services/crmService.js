const Order = require('../models/Order');
const ReturnExchange = require('../models/ReturnExchange');
const CustomerCrm = require('../models/CustomerCrm');
const { CRM_TAGS } = require('../models/CustomerCrm');

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function idOf(value) {
  return String(value?._id || value || '');
}

async function buildCustomerRows(storeId) {
  const match = storeId ? { storeId } : {};
  const orders = await Order.find({
    ...match,
    orderStatus: { $ne: 'Cancelled' },
  }).select('user finalAmount createdAt orderItems shippingAddress attribution paymentMethod orderStatus').lean();

  const returns = await ReturnExchange.find(match).select('user status').lean();
  const returnCountByUser = new Map();
  for (const item of returns) {
    const key = idOf(item.user);
    returnCountByUser.set(key, (returnCountByUser.get(key) || 0) + 1);
  }

  const byUser = new Map();
  for (const order of orders) {
    const key = idOf(order.user);
    if (!key) continue;
    const row = byUser.get(key) || {
      userId: key,
      orders: 0,
      spend: 0,
      lastOrderAt: null,
      sizes: {},
      categories: {},
      acquisition: '',
      returns: returnCountByUser.get(key) || 0,
    };
    row.orders += 1;
    row.spend += Number(order.finalAmount || 0);
    if (!row.lastOrderAt || new Date(order.createdAt) > new Date(row.lastOrderAt)) {
      row.lastOrderAt = order.createdAt;
      row.acquisition = row.acquisition || order.attribution?.source || '';
    }
    for (const line of order.orderItems || []) {
      if (line.size) row.sizes[line.size] = (row.sizes[line.size] || 0) + Number(line.quantity || 1);
      if (line.category) {
        const cat = idOf(line.category);
        row.categories[cat] = (row.categories[cat] || 0) + Number(line.quantity || 1);
      }
    }
    byUser.set(key, row);
  }

  const userIds = [...byUser.keys()];
  const profiles = await CustomerCrm.find({ storeId, user: { $in: userIds } }).lean();
  const profileByUser = new Map(profiles.map((item) => [idOf(item.user), item]));

  return [...byUser.values()].map((row) => {
    const profile = profileByUser.get(row.userId) || {};
    const tags = Array.isArray(profile.tags) ? profile.tags.slice() : [];
    if (row.orders === 1 && !tags.includes('New Customer')) tags.push('New Customer');
    if (row.orders >= 3 && !tags.includes('Repeat Customer')) tags.push('Repeat Customer');
    if (row.spend >= 10000 && !tags.includes('VIP')) tags.push('VIP');
    if (row.acquisition === 'instagram' && !tags.includes('Instagram Customer')) tags.push('Instagram Customer');
    if (row.acquisition === 'whatsapp' && !tags.includes('WhatsApp Customer')) tags.push('WhatsApp Customer');
    if (row.returns >= 2 && !tags.includes('Frequent Return')) tags.push('Frequent Return');
    if (row.orders >= 2 && row.returns / row.orders >= 0.4 && !tags.includes('High RTO')) tags.push('High RTO');
    const idleMs = row.lastOrderAt ? Date.now() - new Date(row.lastOrderAt).getTime() : 0;
    if (idleMs > 90 * 24 * 60 * 60 * 1000 && !tags.includes('Inactive')) tags.push('Inactive');
    return {
      userId: row.userId,
      orders: row.orders,
      spend: round(row.spend),
      aov: row.orders ? round(row.spend / row.orders) : 0,
      lastOrderAt: row.lastOrderAt,
      returns: row.returns,
      sizes: row.sizes,
      categories: row.categories,
      acquisition: profile.acquisition || row.acquisition || '',
      tags,
      notes: profile.notes || '',
    };
  }).sort((a, b) => b.spend - a.spend);
}

module.exports = { CRM_TAGS, buildCustomerRows };
