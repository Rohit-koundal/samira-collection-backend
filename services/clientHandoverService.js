const { isDemoOtpMode } = require('../config/env');
const { getProvider } = require('./smsService');
const { readConfiguration } = require('./masterConfigurationService');
const { ApiError } = require('../utils/apiError');

async function assertClientHandoverReady() {
  if (isDemoOtpMode() || process.env.NODE_ENV !== 'production' || !['twilio', 'msg91', 'fast2sms'].includes(getProvider())) {
    throw new ApiError('FORBIDDEN', 'Client handover requires production OTP mode and a real SMS provider. Demo or offline logins must not be used for clients.');
  }
  if (!(await readConfiguration()).locked) throw new ApiError('FORBIDDEN', 'Lock the configuration before handing over client admin access');
}

module.exports = { assertClientHandoverReady };
