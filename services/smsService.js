const mockSmsProvider = require('./providers/mockSmsProvider');
const msg91Provider = require('./providers/msg91Provider');
const fast2smsProvider = require('./providers/fast2smsProvider');
const twilioSmsProvider = require('./providers/twilioSmsProvider');

function getProvider() {
  if (process.env.NODE_ENV !== 'production') return 'mock';
  if ((process.env.OTP_PROVIDER || 'mock') === 'mock') return 'mock';
  return String(process.env.SMS_PROVIDER || 'mock').toLowerCase();
}

async function sendOtp(phone, otp, { requireReal = false } = {}) {
  try {
    const provider = requireReal ? String(process.env.SMS_PROVIDER || process.env.OTP_PROVIDER || '').toLowerCase() : getProvider();
    if (requireReal && !['msg91', 'fast2sms', 'twilio'].includes(provider)) return { success: false, error: 'A real SMS provider is required' };
    if (provider === 'msg91') return await sendViaMSG91(phone, otp);
    if (provider === 'fast2sms') return await sendViaFast2SMS(phone, otp);
    if (provider === 'twilio') return await sendViaTwilioSMS(phone, otp);
    return await sendViaMock(phone, otp);
  } catch (error) {
    console.warn(`SMS failed for ${phone}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function sendViaMock(phone, otp) {
  return mockSmsProvider.sendOtp(phone, otp);
}

async function sendViaMSG91(phone, otp) {
  return msg91Provider.sendOtp(phone, otp);
}

async function sendViaFast2SMS(phone, otp) {
  return fast2smsProvider.sendOtp(phone, otp);
}

async function sendViaTwilioSMS(phone, otp) {
  return twilioSmsProvider.sendOtp(phone, otp);
}

module.exports = {
  getProvider,
  sendOtp,
  sendViaMock,
  sendViaMSG91,
  sendViaFast2SMS,
  sendViaTwilioSMS,
};
