async function sendOtp(phone, otp) {
  const config = getTwilioConfig(phone);
  if (!config.accountSid || !config.authToken || !config.from) {
    throw new Error(config.errorMessage || 'Twilio SMS provider is not configured');
  }

  const body = new URLSearchParams({
    To: String(phone).startsWith('+') ? String(phone) : `+91${phone}`,
    From: config.from,
    Body: `Your Samira Collection OTP is ${otp}. It is valid for ${process.env.OTP_EXPIRY_MINUTES || 5} minutes. Do not share this OTP with anyone.`,
  });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || 'Twilio SMS failed to send OTP';
    const error = new Error(message);
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }
  return { success: true, provider: 'twilio', messageSid: data.sid };
}

function getTwilioConfig() {
  return {
    accountSid: process.env.SMS_ACCOUNT_SID,
    authToken: process.env.SMS_AUTH_TOKEN,
    from: process.env.SMS_SENDER_ID,
  };
}

module.exports = { sendOtp };
