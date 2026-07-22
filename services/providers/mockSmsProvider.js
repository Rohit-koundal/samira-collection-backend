async function sendOtp(phone, otp) {
  if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEV_OTP !== 'true') {
    const error = new Error('Mock SMS provider is disabled');
    error.statusCode = 503;
    throw error;
  }
  return { success: true, provider: 'mock', devOtp: otp };
}

module.exports = { sendOtp };
