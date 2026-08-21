const crypto = require('crypto');
const mongoose = require('mongoose');
const Otp = require('../models/Otp');
const { normalizePhone, requireValidPhone } = require('../utils/phoneUtils');
const { getDemoOtp, getJwtSecret, isDemoOtpMode } = require('../config/env');

const memoryOtps = new Map();

function getMaxAttempts() {
  return Number(process.env.OTP_MAX_ATTEMPTS || 5);
}

function getExpiryMinutes() {
  return Number(process.env.OTP_EXPIRY_MINUTES || 5);
}

function generateOtp() {
  if (isDemoOtpMode()) return getDemoOtp();
  return String(crypto.randomInt(100000, 1000000));
}

function hashOtp(phoneOrOtp, maybeOtp) {
  const phone = maybeOtp === undefined ? '' : phoneOrOtp;
  const otp = maybeOtp === undefined ? phoneOrOtp : maybeOtp;
  return crypto
    .createHmac('sha256', getJwtSecret())
    .update(`${phone}:${otp}`)
    .digest('hex');
}

function compareOtp(phone, otp, otpHash) {
  const expected = Buffer.from(hashOtp(phone, otp));
  const actual = Buffer.from(String(otpHash || ''));
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function verifyOtpHash(phone, otp, otpHash) {
  return compareOtp(phone, otp, otpHash);
}

function buildMemoryKey(targetType, target) {
  return `${targetType}:${target}`;
}

function normalizeEmail(email = '') {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return '';
  return normalized;
}

function requireValidEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    const error = new Error('Enter a valid email address');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeTarget(target, targetType) {
  return targetType === 'email' ? requireValidEmail(target) : requireValidPhone(target);
}

async function canResendOtp(phone) {
  const normalizedPhone = requireValidPhone(phone);
  return canResendTargetOtp(normalizedPhone, 'phone');
}

async function canResendTargetOtp(target, targetType = 'phone') {
  const normalizedTarget = normalizeTarget(target, targetType);
  if (useMemoryOtpStore()) {
    const latest = memoryOtps.get(buildMemoryKey(targetType, normalizedTarget));
    const cooldownSeconds = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60);
    if (!latest || latest.isUsed) return { allowed: true, latest: null, retryAfter: 0 };
    const elapsedSeconds = Math.floor((Date.now() - latest.createdAt.getTime()) / 1000);
    return {
      allowed: elapsedSeconds >= cooldownSeconds,
      latest,
      retryAfter: Math.max(0, cooldownSeconds - elapsedSeconds),
    };
  }
  const latest = await Otp.findOne({ target: normalizedTarget, targetType, isUsed: false }).sort('-createdAt');
  const cooldownSeconds = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60);
  if (!latest) return { allowed: true, latest: null, retryAfter: 0 };
  const elapsedSeconds = Math.floor((Date.now() - latest.createdAt.getTime()) / 1000);
  return {
    allowed: elapsedSeconds >= cooldownSeconds,
    latest,
    retryAfter: Math.max(0, cooldownSeconds - elapsedSeconds),
  };
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
    const error = new Error(`Please wait ${resend.retryAfter}s before requesting another OTP`);
    error.statusCode = 429;
    throw error;
  }

  const otp = generateOtp();
  if (useMemoryOtpStore()) {
    const record = {
      phone: targetType === 'phone' ? normalizedTarget : undefined,
      email: targetType === 'email' ? normalizedTarget : undefined,
      target: normalizedTarget,
      targetType,
      otpHash: hashOtp(normalizedTarget, otp),
      purpose,
      provider: process.env.OTP_PROVIDER || process.env.SMS_PROVIDER || 'mock',
      expiresAt: new Date(Date.now() + getExpiryMinutes() * 60 * 1000),
      attempts: 0,
      maxAttempts: getMaxAttempts(),
      resendCount: resend.latest ? resend.latest.resendCount + 1 : 0,
      isUsed: false,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      createdAt: new Date(),
      async save() {
        memoryOtps.set(buildMemoryKey(targetType, normalizedTarget), this);
        return this;
      },
    };
    memoryOtps.set(buildMemoryKey(targetType, normalizedTarget), record);
    return { record, otp, target: normalizedTarget, [targetType]: normalizedTarget };
  }

  await Otp.updateMany({ target: normalizedTarget, targetType, isUsed: false }, { isUsed: true });
  const record = await Otp.create({
    phone: targetType === 'phone' ? normalizedTarget : undefined,
    email: targetType === 'email' ? normalizedTarget : undefined,
    target: normalizedTarget,
    targetType,
    otpHash: hashOtp(normalizedTarget, otp),
    purpose,
    provider: process.env.OTP_PROVIDER || process.env.SMS_PROVIDER || 'mock',
    expiresAt: new Date(Date.now() + getExpiryMinutes() * 60 * 1000),
    maxAttempts: getMaxAttempts(),
    resendCount: resend.latest ? resend.latest.resendCount + 1 : 0,
    ipAddress: req?.ip,
    userAgent: req?.headers?.['user-agent'],
  });

  return { record, otp, target: normalizedTarget, [targetType]: normalizedTarget };
}

async function verifyOtp(phone, otp) {
  return verifyTargetOtp(phone, otp, { targetType: 'phone' });
}

async function verifyEmailOtp(email, otp) {
  return verifyTargetOtp(email, otp, { targetType: 'email' });
}

async function verifyTargetOtp(target, otp, { targetType = 'phone' } = {}) {
  const normalizedTarget = normalizeTarget(target, targetType);
  const code = String(otp || '');
  if (!/^\d{6}$/.test(code)) {
    const error = new Error(`Valid ${targetType === 'email' ? 'email' : 'mobile number'} and OTP are required`);
    error.statusCode = 400;
    throw error;
  }

  const record = useMemoryOtpStore()
    ? getMemoryOtp(normalizedTarget, targetType)
    : await Otp.findOne({ target: normalizedTarget, targetType, isUsed: false }).sort('-createdAt');
  if (!record) {
    const error = new Error('OTP not found or expired');
    error.statusCode = 400;
    throw error;
  }
  if (record.expiresAt < new Date()) {
    record.isUsed = true;
    await record.save();
    const error = new Error('OTP expired');
    error.statusCode = 400;
    throw error;
  }
  if (record.attempts >= record.maxAttempts) {
    const error = new Error('Maximum OTP attempts exceeded');
    error.statusCode = 429;
    throw error;
  }
  const matches = compareOtp(normalizedTarget, code, record.otpHash);

  if (!matches) {
    record.attempts += 1;
    await record.save();
    const error = new Error('Invalid OTP');
    error.statusCode = 400;
    throw error;
  }

  record.isUsed = true;
  await record.save();
  return { target: normalizedTarget, targetType, [targetType]: normalizedTarget, record };
}

async function markOtpUsed(record) {
  record.isUsed = true;
  return record.save();
}

async function invalidateOtp(record) {
  if (!record) return null;
  record.isUsed = true;
  return record.save();
}

function useMemoryOtpStore() {
  return process.env.NODE_ENV !== 'production' && mongoose.connection.readyState !== 1;
}

function getMemoryOtp(target, targetType = 'phone') {
  const record = memoryOtps.get(buildMemoryKey(targetType, target));
  if (!record || record.isUsed) return null;
  return record;
}

module.exports = {
  normalizePhone,
  normalizeEmail,
  generateOtp,
  hashOtp,
  compareOtp,
  verifyOtpHash,
  createOtp,
  createEmailOtp,
  verifyOtp,
  verifyEmailOtp,
  createTargetOtp,
  verifyTargetOtp,
  markOtpUsed,
  invalidateOtp,
  canResendOtp,
  canResendTargetOtp,
  requireValidEmail,
};
