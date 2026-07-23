function getProvider() {
  return String(process.env.EMAIL_OTP_PROVIDER || 'mock').toLowerCase();
}

async function sendOtpEmail(email, otp) {
  const provider = getProvider();
  if (provider === 'mock') return sendViaMock(email, otp);
  if (provider === 'brevo') return sendViaBrevo(email, otp);

  const error = new Error('Email OTP provider is not configured');
  error.statusCode = 503;
  throw error;
}

async function sendViaMock(email, otp) {
  return {
    success: true,
    provider: 'mock',
    messageId: `mock-email-${Date.now()}`,
    devOtp: otp,
    recipient: email,
  };
}

async function sendViaBrevo(email, otp) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) {
    const error = new Error('Brevo email OTP is not configured');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: {
        email: senderEmail,
        name: process.env.BREVO_SENDER_NAME || 'Samira Collection',
      },
      to: [{ email }],
      subject: 'Verify your Samira Collection email',
      htmlContent: `<div style="font-family:Arial,sans-serif;color:#1f2a44"><h2>Samira Collection</h2><p>Your email verification OTP is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${otp}</p><p>This OTP expires in ${Number(process.env.OTP_EXPIRY_MINUTES || 5)} minutes.</p></div>`,
    }),
  });

  if (!response.ok) {
    const details = await safeJson(response);
    const error = new Error(details?.message || 'Unable to send email OTP');
    error.statusCode = response.status || 500;
    throw error;
  }

  const data = await response.json();
  return {
    success: true,
    provider: 'brevo',
    messageId: data?.messageId,
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

module.exports = { sendOtpEmail };
