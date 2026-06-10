async function sendOtp(phone, otp) {
  const apiKey = process.env.SMS_API_KEY;
  const templateId = process.env.SMS_TEMPLATE_ID;
  if (!apiKey || !templateId) throw new Error('MSG91 SMS provider is not configured');

  const response = await fetch('https://control.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authkey: apiKey,
    },
    body: JSON.stringify({
      template_id: templateId,
      mobile: `91${phone}`,
      otp,
    }),
  });

  if (!response.ok) throw new Error('MSG91 failed to send OTP');
  return { success: true, provider: 'msg91' };
}

module.exports = { sendOtp };
