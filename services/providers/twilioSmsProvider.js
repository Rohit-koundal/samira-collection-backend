async function sendOtp(phone, otp) {
  const config = getTwilioConfig(phone);
  if (!config.accountSid || !config.authToken || !config.from) {
    const error = new Error('Twilio SMS provider is not configured. Check the backend SMS account, token and sender settings.');
    error.errorCode = 'OTP_PROVIDER_NOT_CONFIGURED';
    throw error;
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
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const rejectedCredentials = response.status === 401 || response.status === 403 || Number(data.code) === 20003;
    // Provider messages can contain account identifiers or other request data.
    // Keep diagnostics actionable without logging or returning that raw text.
    const error = new Error(rejectedCredentials
      ? 'Twilio rejected the SMS credentials or permissions. Check SMS_ACCOUNT_SID and SMS_AUTH_TOKEN on the backend.'
      : 'Twilio could not accept the OTP message. Check the SMS delivery error in the Twilio console.');
    error.errorCode = rejectedCredentials ? 'OTP_PROVIDER_AUTH_FAILED' : 'OTP_DELIVERY_UNAVAILABLE';
    error.providerCode = Number.isSafeInteger(Number(data.code)) ? Number(data.code) : undefined;
    error.statusCode = 503;
    throw error;
  }
  return { success: true, provider: 'twilio', accountSid: config.accountSid, messageSid: data.sid };
}

function getTwilioConfig(phone) {
  const value = (key) => String(process.env[key] || '').trim();
  if (String(phone) === '9999133567') {
    return {
      accountSid: value('SMS_9999133567_ACCOUNT_SID'),
      authToken: value('SMS_9999133567_AUTH_TOKEN'),
      from: value('SMS_9999133567_SENDER_ID'),
    };
  }

  return {
    accountSid: value('SMS_ACCOUNT_SID'),
    authToken: value('SMS_AUTH_TOKEN') || value('SMS_API_KEY'),
    from: value('SMS_SENDER_ID'),
  };
}

module.exports = { sendOtp };
