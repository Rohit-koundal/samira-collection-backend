const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'access-secret-for-tests-only-000000000000000000000000';
process.env.JWT_REFRESH_SECRET = 'refresh-secret-for-tests-only-0000000000000000000000';
process.env.OTP_HASH_SECRET = 'otp-hash-secret-for-tests-only-000000000000000000000';
process.env.JWT_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '30d';
process.env.ALLOW_DEV_OTP = 'true';
process.env.ALLOW_OFFLINE_AUTH = 'true';
process.env.SMS_PROVIDER = 'mock';
process.env.EMAIL_OTP_PROVIDER = 'mock';
process.env.OTP_DEV_CODE = '654321';
process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
process.env.OTP_MAX_RESENDS = '3';
process.env.OTP_MAX_ATTEMPTS = '5';

const User = require('../models/User');
const authController = require('../controllers/authController');
const mockSmsProvider = require('../services/providers/mockSmsProvider');
const { sendOtp: sendSmsOtp } = require('../services/smsService');
const devFallback = require('../middleware/devFallbackMiddleware');
const {
  createEmailOtp,
  createOtp,
  resetMemoryOtpsForTests,
  verifyEmailOtp,
  verifyOtp,
} = require('../services/otpService');
const {
  getPresentedRefreshToken,
  issueRefreshSession,
  requireCookieCsrf,
  resetMemorySessionsForTests,
  rotateRefreshSession,
  setAuthCookies,
} = require('../services/refreshSessionService');
const {
  consumeRateLimit,
  resetMemoryRateLimitsForTests,
} = require('../services/rateLimitService');
const { generateToken } = require('../utils/generateToken');
const { validateEnvironment } = require('../config/env');
const { validateRegistration } = require('../utils/authValidation');

test.beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_DEV_OTP = 'true';
  process.env.ALLOW_OFFLINE_AUTH = 'true';
  process.env.SMS_PROVIDER = 'mock';
  process.env.EMAIL_OTP_PROVIDER = 'mock';
  process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
  process.env.OTP_MAX_RESENDS = '3';
  process.env.OTP_MAX_ATTEMPTS = '5';
  resetMemoryOtpsForTests();
  resetMemorySessionsForTests();
  resetMemoryRateLimitsForTests();
});

test('public registration rejects every protected account-control field', () => {
  const protectedFields = [
    'role',
    'adminRole',
    'activeMode',
    'availableModes',
    'isAdmin',
    'isBlocked',
    'isPhoneVerified',
    'isEmailVerified',
    'permissions',
    'refreshTokens',
    'passwordResetToken',
    'tokenVersion',
  ];
  for (const field of protectedFields) {
    assert.throws(
      () => validateRegistration(validRegistration({ [field]: field === 'role' ? 'admin' : true })),
      /unsupported fields/,
    );
  }
});

test('registration controller never passes attacker-controlled role to User.create', async () => {
  const originalFindOne = User.findOne;
  const originalCreate = User.create;
  let createdPayload;
  User.findOne = () => ({ select: async () => null });
  User.create = async (payload) => {
    createdPayload = payload;
    return fakeUser(payload);
  };

  try {
    const rejected = fakeResponse();
    await authController.register({
      body: validRegistration({ role: 'admin', isBlocked: true }),
      ip: '198.51.100.10',
      headers: {},
    }, rejected);
    assert.equal(rejected.statusCode, 400);
    assert.equal(createdPayload, undefined);

    const accepted = fakeResponse();
    await authController.register({
      body: validRegistration(),
      ip: '198.51.100.11',
      headers: {},
    }, accepted);
    assert.equal(accepted.statusCode, 201);
    assert.equal(createdPayload.role, 'customer');
    assert.equal(createdPayload.activeMode, 'customer');
    assert.deepEqual(createdPayload.availableModes, ['customer']);
    assert.equal(createdPayload.isBlocked, false);
    assert.equal(accepted.body.refreshToken, undefined);
  } finally {
    User.findOne = originalFindOne;
    User.create = originalCreate;
  }
});

test('OTP verifies once and cannot be replayed', async () => {
  const { otp } = await createOtp('9876543210', 'login');
  const verified = await verifyOtp('9876543210', otp, 'login');
  assert.equal(verified.phone, '9876543210');
  await assert.rejects(() => verifyOtp('9876543210', otp, 'login'), /not found or expired/);
});

test('email OTP normalizes the address, verifies once, and cannot be replayed', async () => {
  const { otp } = await createEmailOtp('  Customer@Example.Test ', 'profile_email_change');
  const verified = await verifyEmailOtp('customer@example.test', otp, 'profile_email_change');
  assert.equal(verified.email, 'customer@example.test');
  await assert.rejects(
    () => verifyEmailOtp('customer@example.test', otp, 'profile_email_change'),
    /not found or expired/,
  );
});

test('incorrect, expired, and over-attempted OTPs are rejected', async () => {
  process.env.OTP_MAX_ATTEMPTS = '2';
  const incorrect = await createOtp('9876543211', 'login');
  await assert.rejects(() => verifyOtp('9876543211', '000000', 'login'), /Invalid OTP/);
  await assert.rejects(() => verifyOtp('9876543211', '000000', 'login'), /Invalid OTP/);
  await assert.rejects(
    () => verifyOtp('9876543211', incorrect.otp, 'login'),
    (error) => error.statusCode === 429 && /Maximum OTP attempts/.test(error.message),
  );

  const expired = await createOtp('9876543212', 'login');
  expired.record.expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(() => verifyOtp('9876543212', expired.otp, 'login'), /OTP expired/);
});

test('OTP resend cooldown and maximum resend count are enforced', async () => {
  process.env.OTP_RESEND_COOLDOWN_SECONDS = '1';
  process.env.OTP_MAX_RESENDS = '2';
  let latest = await createOtp('9876543213', 'login');
  await assert.rejects(
    () => createOtp('9876543213', 'login'),
    (error) => error.statusCode === 429 && /Please wait/.test(error.message),
  );

  latest.record.createdAt = new Date(Date.now() - 2000);
  latest = await createOtp('9876543213', 'login');
  latest.record.createdAt = new Date(Date.now() - 2000);
  latest = await createOtp('9876543213', 'login');
  latest.record.createdAt = new Date(Date.now() - 2000);
  await assert.rejects(
    () => createOtp('9876543213', 'login'),
    (error) => error.statusCode === 429 && /Maximum OTP resend/.test(error.message),
  );
});

test('mock OTP delivery is disabled in production and production response hides devOtp', async () => {
  process.env.NODE_ENV = 'production';
  await assert.rejects(() => mockSmsProvider.sendOtp('9876543210', '654321'), /disabled/);
  const response = authController._private.otpSentResponse({ success: true, devOtp: '654321' });
  assert.equal(Object.hasOwn(response, 'devOtp'), false);
});

test('provider failure returns a generic delivery error', async () => {
  process.env.SMS_PROVIDER = 'not-configured';
  await assert.rejects(
    () => sendSmsOtp('9876543210', '654321'),
    (error) => error.statusCode === 503
      && error.code === 'OTP_DELIVERY_FAILED'
      && error.message === 'Unable to deliver OTP. Please try again later.',
  );
});

test('refresh tokens rotate, and reuse revokes the replacement family', async () => {
  const user = fakeUser({ tokenVersion: 0 });
  const first = await issueRefreshSession(user, { ipAddress: '198.51.100.20' });
  const second = await rotateRefreshSession(first.token, user, {
    csrfToken: first.csrfToken,
    ipAddress: '198.51.100.20',
  });
  assert.notEqual(second.token, first.token);
  await assert.rejects(
    () => rotateRefreshSession(first.token, user, { csrfToken: first.csrfToken }),
    (error) => error.code === 'REFRESH_TOKEN_REUSE',
  );
  await assert.rejects(
    () => rotateRefreshSession(second.token, user, { csrfToken: second.csrfToken }),
    (error) => error.code === 'REFRESH_TOKEN_REUSE',
  );
});

test('password token-version changes invalidate outstanding refresh tokens', async () => {
  const user = fakeUser({ tokenVersion: 0 });
  const session = await issueRefreshSession(user);
  user.tokenVersion = 1;
  await assert.rejects(
    () => rotateRefreshSession(session.token, user, { csrfToken: session.csrfToken }),
    /no longer valid/,
  );
});

test('cookie refresh requires matching CSRF cookie and header', () => {
  assert.equal(
    requireCookieCsrf({ headers: { cookie: 'samira_csrf=csrf-value', 'x-csrf-token': 'csrf-value' } }),
    'csrf-value',
  );
  assert.throws(
    () => requireCookieCsrf({ headers: { cookie: 'samira_csrf=csrf-value', 'x-csrf-token': 'different' } }),
    (error) => error.statusCode === 403,
  );
});

test('production refresh cookie is HttpOnly, Secure, and body tokens are ignored', () => {
  process.env.NODE_ENV = 'production';
  const response = fakeResponse();
  setAuthCookies(response, 'refresh-value', 'csrf-value');
  const refreshCookie = response.cookies.find((cookie) => cookie.name === 'samira_refresh');
  const csrfCookie = response.cookies.find((cookie) => cookie.name === 'samira_csrf');
  assert.equal(refreshCookie.options.httpOnly, true);
  assert.equal(refreshCookie.options.secure, true);
  assert.equal(refreshCookie.options.path, '/api/auth');
  assert.equal(csrfCookie.options.httpOnly, false);
  assert.equal(csrfCookie.options.path, '/');
  assert.deepEqual(
    getPresentedRefreshToken({ headers: {}, body: { refreshToken: 'body-token' } }),
    { token: '', source: 'none' },
  );
});

test('local rate limiter blocks excess identifier requests', async () => {
  const rule = { scope: 'test', identifier: '198.51.100.30', limit: 2, windowSeconds: 60 };
  assert.equal((await consumeRateLimit(rule)).allowed, true);
  assert.equal((await consumeRateLimit(rule)).allowed, true);
  const blocked = await consumeRateLimit(rule);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0);
});

test('JWT generation has no fallback secret', () => {
  const secret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    assert.throws(() => generateToken(fakeUser()), /not configured/);
  } finally {
    process.env.JWT_SECRET = secret;
  }
});

test('production configuration fails closed for dev OTP and missing persistent limits', () => {
  assert.throws(
    () => validateEnvironment({
      NODE_ENV: 'production',
      MONGO_URI: 'mongodb://database/app',
      JWT_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      OTP_HASH_SECRET: 'c'.repeat(40),
      ALLOW_DEV_OTP: 'true',
      SMS_PROVIDER: 'twilio',
      SMS_ACCOUNT_SID: 'configured',
      SMS_AUTH_TOKEN: 'configured',
      SMS_SENDER_ID: 'configured',
      EMAIL_OTP_PROVIDER: 'brevo',
      BREVO_API_KEY: 'configured',
      BREVO_SENDER_EMAIL: 'security@example.test',
      CLIENT_ORIGINS: 'https://shop.example.test',
    }),
    (error) => error.code === 'INVALID_ENVIRONMENT'
      && error.details.some((message) => message.includes('ALLOW_DEV_OTP'))
      && error.details.some((message) => message.includes('REDIS_REST_URL')),
  );
});

test('production configuration accepts distinct strong secrets and persistent providers', () => {
  assert.deepEqual(validateEnvironment({
    NODE_ENV: 'production',
    REQUIRE_DATABASE: 'true',
    PAYMENTS_ENABLED: 'false',
    MONGO_URI: 'mongodb://database/app',
    JWT_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    OTP_HASH_SECRET: 'c'.repeat(40),
    ALLOW_DEV_OTP: 'false',
    ALLOW_OFFLINE_AUTH: 'false',
    ALLOW_DEV_DATA_FALLBACK: 'false',
    REDIS_REST_URL: 'https://redis.example.test',
    REDIS_REST_TOKEN: 'configured',
    SMS_PROVIDER: 'twilio',
    SMS_ACCOUNT_SID: 'configured',
    SMS_AUTH_TOKEN: 'configured',
    SMS_SENDER_ID: 'configured',
    EMAIL_OTP_PROVIDER: 'brevo',
    BREVO_API_KEY: 'configured',
    BREVO_SENDER_EMAIL: 'security@example.test',
    CLOUDINARY_CLOUD_NAME: 'configured-cloud',
    CLOUDINARY_API_KEY: 'configured-key',
    CLOUDINARY_API_SECRET: 'configured-secret',
    CLIENT_ORIGINS: 'https://shop.example.test',
    REQUIRE_MEDIA_STORAGE: 'false',
  }), { valid: true, errors: [] });
});

test('development data fallback is opt-in and never grants anonymous admin access', () => {
  const previous = process.env.ALLOW_DEV_DATA_FALLBACK;
  delete process.env.ALLOW_DEV_DATA_FALLBACK;
  let calledNext = false;
  devFallback({ path: '/admin/profile', method: 'GET', headers: {} }, fakeResponse(), () => {
    calledNext = true;
  });
  assert.equal(calledNext, true);

  process.env.ALLOW_DEV_DATA_FALLBACK = 'true';
  const denied = fakeResponse();
  devFallback({ path: '/admin/profile', method: 'GET', headers: {} }, denied, () => {});
  assert.equal(denied.statusCode, 401);
  if (previous === undefined) delete process.env.ALLOW_DEV_DATA_FALLBACK;
  else process.env.ALLOW_DEV_DATA_FALLBACK = previous;
});

function validRegistration(overrides = {}) {
  return {
    name: 'Customer Name',
    phone: '9876543210',
    email: 'customer@example.test',
    password: 'Secure123',
    ...overrides,
  };
}

function fakeUser(overrides = {}) {
  const data = {
    _id: '507f1f77bcf86cd799439011',
    id: '507f1f77bcf86cd799439011',
    name: 'Customer Name',
    phone: '9876543210',
    email: 'customer@example.test',
    role: 'customer',
    activeMode: 'customer',
    availableModes: ['customer'],
    isBlocked: false,
    tokenVersion: 0,
    ...overrides,
  };
  return { ...data, toObject: () => ({ ...data }) };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    cookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
      return this;
    },
    clearCookie() {
      return this;
    },
    setHeader() {},
  };
}
