const Notification = require('../models/Notification');
const User = require('../models/User');
const StoreMember = require('../models/StoreMember');
const mongoose = require('mongoose');

const ADMIN_EVENTS = {
  ORDER_PLACED: ['New order received', 'A new order is ready to review.'],
  ORDER_CONFIRMED: ['Online order confirmed', 'Payment was confirmed for a new order.'],
  ORDER_CANCELLED: ['Order cancelled', 'An order has been cancelled.'],
  RETURN_REQUESTED: ['New return or exchange request', 'A customer request needs your review.'],
  CONTACT_RECEIVED: ['New support message', 'A customer has contacted the store.'],
  PAYMENT_FAILED: ['Payment failed', 'A customer payment attempt needs attention.'],
  LOW_STOCK: ['Low stock alert', 'A product has reached its low-stock threshold.'],
  ORDER_SHIPPED: ['Shipment updated', 'An order shipment is now moving.'],
  ORDER_OUT_FOR_DELIVERY: ['Out for delivery', 'An order is out for delivery.'],
  ORDER_DELIVERED: ['Order delivered', 'An order was delivered successfully.'],
};

/**
 * In-app notifications are stored. Other channels are recorded as SKIPPED
 * unless a real provider is configured. Success is never invented.
 */
function channelAvailable(channel) {
  if (channel === 'IN_APP') return true;
  if (channel === 'EMAIL') return Boolean(process.env.BREVO_API_KEY);
  if (channel === 'SMS') return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  if (channel === 'WHATSAPP') return Boolean(process.env.WHATSAPP_TOKEN);
  if (channel === 'PUSH') return Boolean(process.env.PUSH_PROVIDER_KEY);
  return false;
}

async function notify({
  userId,
  event,
  title,
  message,
  channels = ['IN_APP'],
  metadata,
  storeId,
} = {}) {
  if (!event) return [];
  const docs = [];

  for (const channel of channels) {
    if (channel === 'IN_APP' && !userId) continue;
    const available = channelAvailable(channel);
    if (channel === 'IN_APP' && userId && available) {
      docs.push({
        user: userId,
        event,
        title,
        message,
        channel,
        status: 'SENT',
        metadata,
        audience: 'CUSTOMER',
        storeId,
      });
      continue;
    }

    docs.push({
      user: userId || undefined,
      event,
      title,
      message,
      channel,
      status: 'SKIPPED',
      reason: available ? 'Provider is configured but this channel is not wired yet' : `${channel} is not configured`,
      metadata, storeId,
    });
  }

  if (channels.includes('IN_APP') && ADMIN_EVENTS[event]) {
    const [admins, members] = await Promise.all([
      User.find({ role: 'admin', isBlocked: { $ne: true } }).select('_id'),
      storeId && mongoose.Types.ObjectId.isValid(storeId)
        ? StoreMember.find({ store: storeId, status: 'ACTIVE' }).select('user')
        : [],
    ]);
    const adminIds = [...new Set([...admins.map((admin) => String(admin._id)), ...members.map((member) => String(member.user))])];
    adminIds.forEach((adminId) => docs.push({
      user: adminId, event, title: ADMIN_EVENTS[event][0], message: ADMIN_EVENTS[event][1],
      audience: 'ADMIN', channel: 'IN_APP', status: 'SENT', metadata, storeId,
    }));
  }

  if (!docs.length) return [];
  const entity = metadata?.subscriptionId || metadata?.refundId || metadata?.returnId || metadata?.contactId || metadata?.orderId || metadata?.productId;
  const once = ['ORDER_PLACED', 'ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_OUT_FOR_DELIVERY', 'ORDER_DELIVERED', 'ORDER_CANCELLED', 'PAYMENT_FAILED', 'REFUND_PROCESSED', 'RETURN_REQUESTED', 'CONTACT_RECEIVED', 'SUBSCRIPTION_EXPIRING', 'SUBSCRIPTION_EXPIRED', 'SUBSCRIPTION_ACTIVATED'].includes(event);
  if (!once || !entity) return Notification.insertMany(docs);
  await Notification.bulkWrite(docs.map((doc) => {
    if (!doc.user || doc.channel !== 'IN_APP') return { insertOne: { document: doc } };
    const dedupeKey = `${doc.user}:${doc.audience}:${event}:${entity}`;
    return { updateOne: { filter: { dedupeKey }, update: { $setOnInsert: { ...doc, dedupeKey } }, upsert: true, timestamps: false } };
  }).map((operation) => {
    if (operation.updateOne) Object.assign(operation.updateOne.update.$setOnInsert, { createdAt: new Date(), updatedAt: new Date() });
    return operation;
  }));
  return docs;
}

function notifyLater(payload) {
  setImmediate(() => {
    notify(payload).catch(() => null);
  });
}

module.exports = { channelAvailable, notify, notifyLater };
