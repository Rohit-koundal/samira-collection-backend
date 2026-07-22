function isSupportNotificationConfigured() {
  return Boolean(
    process.env.SUPPORT_NOTIFICATION_EMAIL
    && process.env.BREVO_API_KEY
    && process.env.BREVO_SENDER_EMAIL,
  );
}

async function sendSupportNotification(ticket) {
  if (!isSupportNotificationConfigured()) return { enabled: false };
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: {
        email: process.env.BREVO_SENDER_EMAIL,
        name: process.env.BREVO_SENDER_NAME || 'Samira Collection',
      },
      to: [{ email: process.env.SUPPORT_NOTIFICATION_EMAIL }],
      subject: `New Samira Collection support request: ${ticket.subject || ticket._id}`,
      htmlContent: [
        '<div style="font-family:Arial,sans-serif">',
        '<h2>New support request</h2>',
        `<p><strong>Ticket:</strong> ${escapeHtml(ticket._id)}</p>`,
        `<p><strong>Name:</strong> ${escapeHtml(ticket.name)}</p>`,
        `<p><strong>Reply contact:</strong> ${escapeHtml(ticket.email || ticket.phone)}</p>`,
        `<p><strong>Message:</strong><br>${escapeHtml(ticket.message).replace(/\n/g, '<br>')}</p>`,
        '</div>',
      ].join(''),
    }),
  });
  if (!response.ok) {
    const error = new Error('Support notification provider failed');
    error.code = 'SUPPORT_NOTIFICATION_FAILED';
    throw error;
  }
  return { enabled: true };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { isSupportNotificationConfigured, sendSupportNotification };
