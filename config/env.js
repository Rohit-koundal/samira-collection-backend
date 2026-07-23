const MIN_SECRET_LENGTH = 32;

function validateEnvironment(env = process.env) {
  const errors = [];
  const isProduction = env.NODE_ENV === 'production';

  if (!isProduction) return { valid: true, errors: [] };

  requireValue(env, 'MONGO_URI', errors);
  requireStrongSecret(env, 'JWT_SECRET', errors);
  requireStrongSecret(env, 'JWT_REFRESH_SECRET', errors);
  requireStrongSecret(env, 'OTP_HASH_SECRET', errors);
  requireValue(env, 'REDIS_REST_URL', errors);
  requireValue(env, 'REDIS_REST_TOKEN', errors);
  if (env.REQUIRE_DATABASE !== 'true') errors.push('REQUIRE_DATABASE must be true in production');
  if (env.REDIS_REST_URL && !String(env.REDIS_REST_URL).startsWith('https://')) {
    errors.push('REDIS_REST_URL must use HTTPS in production');
  }
  if (String(env.PAYMENTS_ENABLED || '').toLowerCase() === 'true') {
    requireValue(env, 'RAZORPAY_KEY_ID', errors);
    requireValue(env, 'RAZORPAY_KEY_SECRET', errors);
    requireStrongSecret(env, 'RAZORPAY_WEBHOOK_SECRET', errors);
  }

  if (env.JWT_SECRET && env.JWT_REFRESH_SECRET && env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    errors.push('JWT_SECRET and JWT_REFRESH_SECRET must be different');
  }
  if (
    env.OTP_HASH_SECRET
    && [env.JWT_SECRET, env.JWT_REFRESH_SECRET].includes(env.OTP_HASH_SECRET)
  ) {
    errors.push('OTP_HASH_SECRET must be different from JWT secrets');
  }

  if (String(env.ALLOW_DEV_OTP || '').toLowerCase() === 'true') {
    errors.push('ALLOW_DEV_OTP must not be enabled in production');
  }
  if (String(env.ALLOW_OFFLINE_AUTH || '').toLowerCase() === 'true') {
    errors.push('ALLOW_OFFLINE_AUTH must not be enabled in production');
  }
  if (String(env.ALLOW_DEV_DATA_FALLBACK || '').toLowerCase() === 'true') {
    errors.push('ALLOW_DEV_DATA_FALLBACK must not be enabled in production');
  }
  if (String(env.ALLOW_REFRESH_TOKEN_BODY || '').toLowerCase() === 'true') {
    errors.push('ALLOW_REFRESH_TOKEN_BODY must not be enabled in production');
  }
  if (String(env.RETURN_REFRESH_TOKEN_IN_BODY || '').toLowerCase() === 'true') {
    errors.push('RETURN_REFRESH_TOKEN_IN_BODY must not be enabled in production');
  }

  const sameSite = String(env.AUTH_COOKIE_SAME_SITE || 'lax').toLowerCase();
  if (!['lax', 'strict', 'none'].includes(sameSite)) {
    errors.push('AUTH_COOKIE_SAME_SITE must be lax, strict, or none');
  }
  if (
    env.AUTH_COOKIE_DOMAIN
    && !/^\.?[a-z0-9.-]+$/i.test(String(env.AUTH_COOKIE_DOMAIN))
  ) {
    errors.push('AUTH_COOKIE_DOMAIN must be a hostname without a scheme, port, or path');
  }

  const accessLifetime = parseDurationSeconds(env.JWT_EXPIRES_IN || '15m');
  const refreshLifetime = parseDurationSeconds(env.JWT_REFRESH_EXPIRES_IN || '30d');
  if (!accessLifetime || accessLifetime > 3600) {
    errors.push('JWT_EXPIRES_IN must be a positive duration no longer than 1 hour');
  }
  if (!refreshLifetime || refreshLifetime <= accessLifetime || refreshLifetime > 90 * 86400) {
    errors.push('JWT_REFRESH_EXPIRES_IN must be longer than access tokens and no longer than 90 days');
  }

  const smsProvider = String(env.SMS_PROVIDER || '').toLowerCase();
  if (!['msg91', 'fast2sms', 'twilio'].includes(smsProvider)) {
    errors.push('SMS_PROVIDER must select a configured production provider');
  }
  validateSmsProvider(env, smsProvider, errors);

  const emailProvider = String(env.EMAIL_OTP_PROVIDER || '').toLowerCase();
  if (emailProvider !== 'brevo') {
    errors.push('EMAIL_OTP_PROVIDER must select a configured production provider');
  } else {
    requireValue(env, 'BREVO_API_KEY', errors);
    requireValue(env, 'BREVO_SENDER_EMAIL', errors);
  }

  const paymentsEnabled = String(env.PAYMENTS_ENABLED || '').toLowerCase() === 'true'
    || Boolean(env.RAZORPAY_KEY_ID || env.RAZORPAY_KEY_SECRET || env.RAZORPAY_WEBHOOK_SECRET);
  if (paymentsEnabled) {
    requireValue(env, 'RAZORPAY_KEY_ID', errors);
    requireValue(env, 'RAZORPAY_KEY_SECRET', errors);
    requireValue(env, 'RAZORPAY_WEBHOOK_SECRET', errors);
  }

  const r2Configured = [
    'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL',
  ].every((name) => String(env[name] || '').trim());
  const cloudinaryConfigured = [
    'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET',
  ].every((name) => String(env[name] || '').trim());
  const mediaRequired = String(env.REQUIRE_MEDIA_STORAGE || 'true').toLowerCase() !== 'false';
  if (mediaRequired && !r2Configured && !cloudinaryConfigured) {
    errors.push('A complete R2 or Cloudinary media storage configuration is required');
  }

  const origins = String(env.CLIENT_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!origins.length || origins.includes('*')) {
    errors.push('CLIENT_ORIGINS must be a non-wildcard production allowlist');
  }

  if (errors.length) {
    const error = new Error(`Invalid production configuration:\n- ${errors.join('\n- ')}`);
    error.code = 'INVALID_ENVIRONMENT';
    error.details = [...errors];
    throw error;
  }

  return { valid: true, errors: [] };
}

function requireStrongSecret(env, name, errors) {
  const value = String(env[name] || '').trim();
  const isPlaceholder = (value.startsWith('<') && value.endsWith('>'))
    || /^(change|replace)[-_ ]/i.test(value);
  if (value.length < MIN_SECRET_LENGTH || isPlaceholder) {
    errors.push(`${name} must contain at least ${MIN_SECRET_LENGTH} characters`);
  }
}

function requireValue(env, name, errors) {
  if (!String(env[name] || '').trim()) errors.push(`${name} is required`);
}

function validateSmsProvider(env, provider, errors) {
  if (provider === 'twilio') {
    requireValue(env, 'SMS_ACCOUNT_SID', errors);
    requireValue(env, 'SMS_AUTH_TOKEN', errors);
    requireValue(env, 'SMS_SENDER_ID', errors);
  } else if (provider === 'msg91') {
    requireValue(env, 'SMS_API_KEY', errors);
    requireValue(env, 'SMS_TEMPLATE_ID', errors);
  } else if (provider === 'fast2sms') {
    requireValue(env, 'SMS_API_KEY', errors);
  }
}

function parseDurationSeconds(value) {
  if (typeof value === 'number') return value;
  const match = String(value || '').trim().match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return 0;
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(match[1]) * multipliers[match[2].toLowerCase()];
}

module.exports = { MIN_SECRET_LENGTH, validateEnvironment };
