async function sendOtp(phone, otp) {
  const apiKey = process.env.SMS_API_KEY;
  const senderId = process.env.SMS_SENDER_ID;
  if (!apiKey) throw new Error('Fast2SMS provider is not configured');

  const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      route: 'otp',
      variables_values: otp,
      numbers: phone,
      sender_id: senderId || undefined,
    }),
  });

  if (!response.ok) throw new Error('Fast2SMS failed to send OTP');
  return { success: true, provider: 'fast2sms' };
}

module.exports = { sendOtp };
