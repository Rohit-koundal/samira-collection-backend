const mockSmsProvider = require('./providers/mockSmsProvider');
const msg91Provider = require('./providers/msg91Provider');
const fast2smsProvider = require('./providers/fast2smsProvider');
const twilioSmsProvider = require('./providers/twilioSmsProvider');

function getProvider() {
  return String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
}

async function sendOtp(phone, otp) {
  try {
    const provider = getProvider();
    if (provider === 'mock') return await sendViaMock(phone, otp);
    if (provider === 'msg91') return await sendViaMSG91(phone, otp);
    if (provider === 'fast2sms') return await sendViaFast2SMS(phone, otp);
    if (provider === 'twilio') return await sendViaTwilioSMS(phone, otp);
    throw new Error('SMS provider is not configured');
  } catch {
    const error = new Error('Unable to deliver OTP. Please try again later.');
    error.statusCode = 503;
    error.code = 'OTP_DELIVERY_FAILED';
    throw error;
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
  sendOtp,
  sendViaMock,
  sendViaMSG91,
  sendViaFast2SMS,
  sendViaTwilioSMS,
};
