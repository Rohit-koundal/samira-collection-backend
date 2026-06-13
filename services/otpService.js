const crypto = require('crypto');
const mongoose = require('mongoose');
const Otp = require('../models/Otp');
const { normalizePhone, requireValidPhone } = require('../utils/phoneUtils');

const memoryOtps = new Map();

function getMaxAttempts() {
  return Number(process.env.OTP_MAX_ATTEMPTS || 5);
}

function getExpiryMinutes() {
  return Number(process.env.OTP_EXPIRY_MINUTES || 5);
}

function generateOtp() {
  if ((process.env.OTP_PROVIDER || 'mock') === 'mock') return process.env.OTP_DEV_CODE || '123456';
  return String(crypto.randomInt(100000, 1000000));
}

function hashOtp(phoneOrOtp, maybeOtp) {
  const phone = maybeOtp === undefined ? '' : phoneOrOtp;
  const otp = maybeOtp === undefined ? phoneOrOtp : maybeOtp;
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'dev_secret_change_me')
    .update(`${phone}:${otp}`)
    .digest('hex');
}

function compareOtp(phone, otp, otpHash) {
  const expected = hashOtp(phone, otp);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(otpHash));
}

function verifyOtpHash(phone, otp, otpHash) {
  return compareOtp(phone, otp, otpHash);
}

async function canResendOtp(phone) {
  const normalizedPhone = requireValidPhone(phone);
  if (useMemoryOtpStore()) {
    const latest = memoryOtps.get(normalizedPhone);
    const cooldownSeconds = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60);
    if (!latest || latest.isUsed) return { allowed: true, latest: null, retryAfter: 0 };
    const elapsedSeconds = Math.floor((Date.now() - latest.createdAt.getTime()) / 1000);
    return {
      allowed: elapsedSeconds >= cooldownSeconds,
      latest,
      retryAfter: Math.max(0, cooldownSeconds - elapsedSeconds),
    };
  }
  const latest = await Otp.findOne({ phone: normalizedPhone, isUsed: false }).sort('-createdAt');
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
  const normalizedPhone = requireValidPhone(phone);
  const resend = await canResendOtp(normalizedPhone);
  if (!resend.allowed) {
    const error = new Error(`Please wait ${resend.retryAfter}s before requesting another OTP`);
    error.statusCode = 429;
    throw error;
  }

  const otp = generateOtp();
  if (useMemoryOtpStore()) {
    const record = {
      phone: normalizedPhone,
      otpHash: hashOtp(normalizedPhone, otp),
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
        memoryOtps.set(normalizedPhone, this);
        return this;
      },
    };
    memoryOtps.set(normalizedPhone, record);
    return { record, otp, phone: normalizedPhone };
  }

  await Otp.updateMany({ phone: normalizedPhone, isUsed: false }, { isUsed: true });
  const record = await Otp.create({
    phone: normalizedPhone,
    otpHash: hashOtp(normalizedPhone, otp),
    purpose,
    provider: process.env.OTP_PROVIDER || process.env.SMS_PROVIDER || 'mock',
    expiresAt: new Date(Date.now() + getExpiryMinutes() * 60 * 1000),
    maxAttempts: getMaxAttempts(),
    resendCount: resend.latest ? resend.latest.resendCount + 1 : 0,
    ipAddress: req?.ip,
    userAgent: req?.headers?.['user-agent'],
  });

  return { record, otp, phone: normalizedPhone };
}

async function verifyOtp(phone, otp) {
  const normalizedPhone = requireValidPhone(phone);
  const code = String(otp || '');
  if (!/^\d{6}$/.test(code)) {
    const error = new Error('Valid phone and OTP are required');
    error.statusCode = 400;
    throw error;
  }

  const record = useMemoryOtpStore()
    ? getMemoryOtp(normalizedPhone)
    : await Otp.findOne({ phone: normalizedPhone, isUsed: false }).sort('-createdAt');
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
  const matches = compareOtp(normalizedPhone, code, record.otpHash);

  if (!matches) {
    record.attempts += 1;
    await record.save();
    const error = new Error('Invalid OTP');
    error.statusCode = 400;
    throw error;
  }

  record.isUsed = true;
  await record.save();
  return { phone: normalizedPhone, record };
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

function getMemoryOtp(phone) {
  const record = memoryOtps.get(phone);
  if (!record || record.isUsed) return null;
  return record;
}

module.exports = {
  normalizePhone,
  generateOtp,
  hashOtp,
  compareOtp,
  verifyOtpHash,
  createOtp,
  verifyOtp,
  markOtpUsed,
  invalidateOtp,
  canResendOtp,
};
