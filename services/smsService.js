const mockSmsProvider = require('./providers/mockSmsProvider');
const msg91Provider = require('./providers/msg91Provider');
const fast2smsProvider = require('./providers/fast2smsProvider');
const twilioSmsProvider = require('./providers/twilioSmsProvider');

function getProvider() {
  if ((process.env.OTP_PROVIDER || 'mock') === 'mock') return 'mock';
  return String(process.env.SMS_PROVIDER || 'mock').toLowerCase();
}

async function sendOtp(phone, otp) {
  const provider = getProvider();
  if (provider === 'msg91') return sendViaMSG91(phone, otp);
  if (provider === 'fast2sms') return sendViaFast2SMS(phone, otp);
  if (provider === 'twilio') return sendViaTwilioSMS(phone, otp);
  return sendViaMock(phone, otp);
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
