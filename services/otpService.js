const crypto = require('crypto');
const mongoose = require('mongoose');
const Otp = require('../models/Otp');
const { normalizePhone, requireValidPhone } = require('../utils/phoneUtils');

const memoryOtps = new Map();

function getNumericSetting(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function getMaxAttempts() {
  return getNumericSetting('OTP_MAX_ATTEMPTS', 5, 1, 10);
}

function getExpiryMinutes() {
  return getNumericSetting('OTP_EXPIRY_MINUTES', 5, 1, 15);
}

function getResendCooldownSeconds() {
  return getNumericSetting('OTP_RESEND_COOLDOWN_SECONDS', 60, 1, 3600);
}

function getMaxResends() {
  return getNumericSetting('OTP_MAX_RESENDS', 3, 0, 10);
}

function isDevOtpAllowed() {
  return process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_OTP === 'true';
}

function generateOtp() {
  if (isDevOtpAllowed()) {
    const configured = String(process.env.OTP_DEV_CODE || '').trim();
    if (/^\d{6}$/.test(configured)) return configured;
  }
  return String(crypto.randomInt(100000, 1000000));
}

function getOtpHashSecret() {
  const secret = String(process.env.OTP_HASH_SECRET || '');
  if (!secret) {
    const error = new Error('OTP verification is not configured');
    error.statusCode = 503;
    error.code = 'OTP_CONFIGURATION_ERROR';
    throw error;
  }
  return secret;
}

function hashOtp(targetOrOtp, maybeOtp) {
  const target = maybeOtp === undefined ? '' : targetOrOtp;
  const otp = maybeOtp === undefined ? targetOrOtp : maybeOtp;
  return crypto
    .createHmac('sha256', getOtpHashSecret())
    .update(`${target}:${otp}`)
    .digest('hex');
}

function compareOtp(target, otp, otpHash) {
  const expected = Buffer.from(hashOtp(target, otp), 'hex');
  const actual = Buffer.from(String(otpHash || ''), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function verifyOtpHash(target, otp, otpHash) {
  return compareOtp(target, otp, otpHash);
}

function normalizeEmail(email = '') {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) return '';
  return normalized;
}

function requireValidEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw otpError('Enter a valid email address', 400);
  return normalized;
}

function normalizeTarget(target, targetType) {
  return targetType === 'email' ? requireValidEmail(target) : requireValidPhone(target);
}

function buildMemoryKey(targetType, target) {
  return `${targetType}:${target}`;
}

function useMemoryOtpStore() {
  return process.env.NODE_ENV === 'test'
    || (process.env.NODE_ENV !== 'production'
      && process.env.ALLOW_OFFLINE_AUTH === 'true'
      && mongoose.connection.readyState !== 1);
}

async function canResendOtp(phone) {
  return canResendTargetOtp(requireValidPhone(phone), 'phone');
}

async function canResendTargetOtp(target, targetType = 'phone') {
  const normalizedTarget = normalizeTarget(target, targetType);
  const latest = useMemoryOtpStore()
    ? memoryOtps.get(buildMemoryKey(targetType, normalizedTarget))
    : await Otp.findOne({ target: normalizedTarget, targetType, isUsed: false }).sort('-createdAt');

  if (!latest || latest.isUsed) return { allowed: true, latest: null, retryAfter: 0 };
  if (new Date(latest.expiresAt) <= new Date()) {
    await invalidateOtp(latest, 'expired');
    return { allowed: true, latest: null, retryAfter: 0 };
  }
  if (Number(latest.resendCount || 0) >= getMaxResends()) {
    return { allowed: false, latest, retryAfter: secondsUntil(latest.expiresAt), exhausted: true };
  }

  const elapsedSeconds = Math.floor((Date.now() - new Date(latest.createdAt).getTime()) / 1000);
  const retryAfter = Math.max(0, getResendCooldownSeconds() - elapsedSeconds);
  return { allowed: retryAfter === 0, latest, retryAfter, exhausted: false };
}

async function createOtp(phone, purpose = 'login', req) {
  return createTargetOtp(phone, { purpose, req, targetType: 'phone' });
}

async function createEmailOtp(email, purpose = 'profile_email_change', req) {
  return createTargetOtp(email, { purpose, req, targetType: 'email' });
}

async function createTargetOtp(target, { purpose = 'login', req, targetType = 'phone' } = {}) {
  const normalizedTarget = normalizeTarget(target, targetType);
  const resend = await canResendTargetOtp(normalizedTarget, targetType);
  if (!resend.allowed) {
    const message = resend.exhausted
      ? 'Maximum OTP resend attempts exceeded. Please try again later.'
      : `Please wait ${resend.retryAfter}s before requesting another OTP`;
    throw otpError(message, 429, resend.retryAfter);
  }

  const otp = generateOtp();
  const common = {
    phone: targetType === 'phone' ? normalizedTarget : undefined,
    email: targetType === 'email' ? normalizedTarget : undefined,
    target: normalizedTarget,
    targetType,
    otpHash: hashOtp(normalizedTarget, otp),
    purpose,
    provider: targetType === 'email'
      ? String(process.env.EMAIL_OTP_PROVIDER || 'unconfigured')
      : String(process.env.SMS_PROVIDER || 'unconfigured'),
    expiresAt: new Date(Date.now() + getExpiryMinutes() * 60 * 1000),
    attempts: 0,
    maxAttempts: getMaxAttempts(),
    resendCount: resend.latest ? Number(resend.latest.resendCount || 0) + 1 : 0,
    isUsed: false,
    ipAddress: req?.ip,
    userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 500),
    createdAt: new Date(),
  };

  if (useMemoryOtpStore()) {
    if (resend.latest) {
      resend.latest.isUsed = true;
      resend.latest.invalidatedAt = new Date();
      resend.latest.invalidationReason = 'superseded';
    }
    const key = buildMemoryKey(targetType, normalizedTarget);
    const record = {
      ...common,
      async save() {
        memoryOtps.set(key, this);
        return this;
      },
    };
    memoryOtps.set(key, record);
    return { record, otp, target: normalizedTarget, [targetType]: normalizedTarget };
  }

  await Otp.updateMany(
    { target: normalizedTarget, targetType, isUsed: false },
    { $set: { isUsed: true, invalidatedAt: new Date(), invalidationReason: 'superseded' } },
  );
  const record = await Otp.create(common);
  return { record, otp, target: normalizedTarget, [targetType]: normalizedTarget };
}

async function verifyOtp(phone, otp, purpose = 'login') {
  return verifyTargetOtp(phone, otp, { targetType: 'phone', purpose });
}

async function verifyEmailOtp(email, otp, purpose = 'profile_email_change') {
  return verifyTargetOtp(email, otp, { targetType: 'email', purpose });
}

async function verifyTargetOtp(target, otp, { targetType = 'phone', purpose = 'login' } = {}) {
  const normalizedTarget = normalizeTarget(target, targetType);
  const code = String(otp || '');
  if (!/^\d{6}$/.test(code)) throw otpError('A valid mobile number or email and OTP are required', 400);

  const record = useMemoryOtpStore()
    ? getMemoryOtp(normalizedTarget, targetType, purpose)
    : await Otp.findOne({ target: normalizedTarget, targetType, purpose, isUsed: false }).sort('-createdAt');
  if (!record) throw otpError('OTP not found or expired', 400);

  const now = new Date();
  if (new Date(record.expiresAt) <= now) {
    await invalidateOtp(record, 'expired');
    throw otpError('OTP expired', 400);
  }
  if (Number(record.attempts || 0) >= Number(record.maxAttempts || getMaxAttempts())) {
    throw otpError('Maximum OTP attempts exceeded', 429);
  }

  if (!compareOtp(normalizedTarget, code, record.otpHash)) {
    if (useMemoryOtpStore()) {
      record.attempts = Number(record.attempts || 0) + 1;
      await record.save();
    } else {
      await Otp.updateOne(
        { _id: record._id, isUsed: false, attempts: { $lt: record.maxAttempts } },
        { $inc: { attempts: 1 } },
      );
    }
    throw otpError('Invalid OTP', 400);
  }

  if (useMemoryOtpStore()) {
    if (record.isUsed) throw otpError('OTP not found or expired', 400);
    record.isUsed = true;
    record.usedAt = now;
    await record.save();
  } else {
    const consumed = await Otp.findOneAndUpdate(
      {
        _id: record._id,
        isUsed: false,
        expiresAt: { $gt: now },
        attempts: { $lt: record.maxAttempts },
      },
      { $set: { isUsed: true, usedAt: now } },
      { new: true },
    );
    if (!consumed) throw otpError('OTP not found or expired', 400);
    await Otp.updateMany(
      {
        _id: { $ne: record._id },
        target: normalizedTarget,
        targetType,
        isUsed: false,
      },
      { $set: { isUsed: true, invalidatedAt: now, invalidationReason: 'verified' } },
    );
  }

  return { target: normalizedTarget, targetType, [targetType]: normalizedTarget, record };
}

async function markOtpUsed(record) {
  return invalidateOtp(record, 'used');
}

async function invalidateOtp(record, reason = 'invalidated') {
  if (!record) return null;
  const now = new Date();
  if (useMemoryOtpStore() || typeof record.save === 'function') {
    record.isUsed = true;
    record.invalidatedAt = now;
    record.invalidationReason = reason;
    return record.save();
  }
  return Otp.updateOne(
    { _id: record._id },
    { $set: { isUsed: true, invalidatedAt: now, invalidationReason: reason } },
  );
}

function getMemoryOtp(target, targetType = 'phone', purpose = 'login') {
  const record = memoryOtps.get(buildMemoryKey(targetType, target));
  if (!record || record.isUsed || record.purpose !== purpose) return null;
  return record;
}

function secondsUntil(date) {
  return Math.max(1, Math.ceil((new Date(date).getTime() - Date.now()) / 1000));
}

function otpError(message, statusCode, retryAfter) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (retryAfter) error.retryAfter = retryAfter;
  return error;
}

function resetMemoryOtpsForTests() {
  if (process.env.NODE_ENV === 'test') memoryOtps.clear();
}

module.exports = {
  canResendOtp,
  canResendTargetOtp,
  compareOtp,
  createEmailOtp,
  createOtp,
  createTargetOtp,
  generateOtp,
  hashOtp,
  invalidateOtp,
  isDevOtpAllowed,
  markOtpUsed,
  normalizeEmail,
  normalizePhone,
  requireValidEmail,
  resetMemoryOtpsForTests,
  verifyEmailOtp,
  verifyOtp,
  verifyOtpHash,
  verifyTargetOtp,
};
