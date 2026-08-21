const Notification = require('../models/Notification');

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
} = {}) {
  if (!event) return [];
  const docs = [];

  for (const channel of channels) {
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
      metadata,
    });
  }

  if (!docs.length) return [];
  return Notification.insertMany(docs);
}

function notifyLater(payload) {
  setImmediate(() => {
    notify(payload).catch(() => null);
  });
}

module.exports = { channelAvailable, notify, notifyLater };
