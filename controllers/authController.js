const User = require('../models/User');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { generateRefreshToken, generateToken } = require('../utils/generateToken');
const { normalizePhone, normalizeEmail, createOtp, createEmailOtp, invalidateOtp, verifyOtp: verifyOtpRecord, verifyEmailOtp: verifyEmailOtpRecord } = require('../services/otpService');
const { sendOtp } = require('../services/smsService');
const { sendOtpEmail } = require('../services/emailService');

const otpRateLimit = new Map();
const offlineProfiles = new Map();
const PROFILE_VERIFICATION_TOKEN_TTL = process.env.PROFILE_VERIFICATION_TOKEN_TTL || '15m';

exports.register = async (req, res) => {
  const user = await User.create(req.body);
  res.status(201).json(authPayload(user));
};

exports.login = async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user || !(await user.matchPassword(password))) return res.status(401).json({ message: 'Invalid credentials' });
  const shouldUpgradePassword = user.hasLegacyPlainPassword?.();
  if (user.role === 'admin') {
    user.availableModes = ['customer', 'admin'];
    user.activeMode = 'admin';
  }
  if (shouldUpgradePassword) {
    user.markModified('password');
  }
  if (user.role === 'admin' || shouldUpgradePassword) {
    await user.save();
  }
  res.json(authPayload(user));
};

exports.profile = async (req, res) => res.json(req.user);

exports.updateProfile = async (req, res) => {
  try {
    const { role, availableModes, activeMode, isBlocked, ...safeBody } = req.body || {};
    const nextName = normalizeTrimmed(safeBody.name);
    const nextEmail = normalizeProfileEmail(safeBody.email);
    const nextPhone = normalizeProfilePhone(safeBody.phone);
    const nextAlternatePhone = normalizeProfilePhone(safeBody.alternatePhone, { allowEmpty: true });
    const nextHintName = normalizeTrimmed(safeBody.hintName);
    const nextGender = normalizeGender(safeBody.gender);
    const nextBirthDate = normalizeBirthDate(safeBody.birthDate);

    if (nextEmail && req.user.offlineSession !== true) {
      const existingEmailUser = await User.findOne({ email: nextEmail, _id: { $ne: req.user._id } }).select('_id');
      if (existingEmailUser) return res.status(400).json({ message: 'Email is already in use' });
    }

    if (nextPhone && req.user.offlineSession !== true) {
      const existingPhoneUser = await User.findOne({ phone: nextPhone, _id: { $ne: req.user._id } }).select('_id');
      if (existingPhoneUser) return res.status(400).json({ message: 'Mobile number is already in use' });
    }

    const previousPhone = String(req.user.phone || '');
    const previousEmail = String(req.user.email || '').toLowerCase();
    const phoneChanged = nextPhone && nextPhone !== previousPhone;
    const emailChanged = nextEmail !== previousEmail;
    const verifiedPhone = phoneChanged ? verifyProfileChangeToken(req.body.phoneVerificationToken, {
      userId: req.user._id || req.user.id,
      targetType: 'phone',
      target: nextPhone,
    }) : false;
    const verifiedEmail = nextEmail ? (
      emailChanged
        ? verifyProfileChangeToken(req.body.emailVerificationToken, {
          userId: req.user._id || req.user.id,
          targetType: 'email',
          target: nextEmail,
        })
        : Boolean(req.user.isEmailVerified)
    ) : false;

    if (phoneChanged && !verifiedPhone) {
      return res.status(400).json({ message: 'Please verify your new mobile number with OTP before saving' });
    }

    if (nextEmail && emailChanged && !verifiedEmail) {
      return res.status(400).json({ message: 'Please verify your email with OTP before saving' });
    }

    const nextProfile = {
      name: nextName || req.user.name || '',
      email: nextEmail || undefined,
      phone: nextPhone || previousPhone,
      gender: nextGender,
      birthDate: nextBirthDate,
      alternatePhone: nextAlternatePhone,
      hintName: nextHintName,
      isEmailVerified: nextEmail ? verifiedEmail : false,
    };

    if (req.user.offlineSession) {
      if (phoneChanged) removeOfflineProfile({ phone: previousPhone });
      Object.assign(req.user, nextProfile);
      if (phoneChanged) req.user.isPhoneVerified = true;
      storeOfflineProfile(req.user);
      return res.json(sanitize(req.user));
    }

    Object.assign(req.user, nextProfile);
    if (phoneChanged) req.user.isPhoneVerified = true;
    await req.user.save();
    res.json(sanitize(req.user));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.sendProfilePhoneChangeOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ message: 'Valid 10-digit Indian mobile number is required' });
    if (phone === String(req.user.phone || '')) return res.status(400).json({ message: 'This mobile number is already on your account' });

    const existingUser = req.user.offlineSession
      ? null
      : await User.findOne({ phone, _id: { $ne: req.user._id } }).select('_id');
    if (existingUser) return res.status(400).json({ message: 'Mobile number is already in use' });

    const { otp } = await createOtp(phone, 'profile_phone_change', req);
    const delivery = await sendOtp(phone, otp);
    return res.json({
      success: true,
      message: 'OTP sent successfully',
      ...(delivery.devOtp ? { devOtp: delivery.devOtp } : {}),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

exports.verifyProfilePhoneChangeOtp = async (req, res) => {
  try {
    const { phone } = await verifyOtpRecord(req.body.phone, req.body.otp);
    const verificationToken = createProfileChangeToken({
      userId: req.user._id || req.user.id,
      targetType: 'phone',
      target: phone,
    });
    res.json({ success: true, verified: true, verificationToken });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

exports.sendProfileEmailChangeOtp = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.status(400).json({ message: 'Please enter a valid email address' });
    if (email === String(req.user.email || '').toLowerCase()) return res.status(400).json({ message: 'This email is already on your account' });

    const existingUser = req.user.offlineSession
      ? null
      : await User.findOne({ email, _id: { $ne: req.user._id } }).select('_id');
    if (existingUser) return res.status(400).json({ message: 'Email is already in use' });

    const { otp } = await createEmailOtp(email, 'profile_email_change', req);
    const delivery = await sendOtpEmail(email, otp);
    return res.json({
      success: true,
      message: 'OTP sent successfully',
      ...(delivery.devOtp ? { devOtp: delivery.devOtp } : {}),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

exports.verifyProfileEmailChangeOtp = async (req, res) => {
  try {
    const { email } = await verifyEmailOtpRecord(req.body.email, req.body.otp);
    const verificationToken = createProfileChangeToken({
      userId: req.user._id || req.user.id,
      targetType: 'email',
      target: email,
    });
    res.json({ success: true, verified: true, verificationToken });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

exports.deleteProfile = async (req, res) => {
  try {
    if (req.user.offlineSession) {
      removeOfflineProfile(req.user);
      return res.json({ success: true, message: 'Account deleted successfully' });
    }

    await User.findByIdAndDelete(req.user._id);
    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.sendOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ message: 'Valid 10-digit Indian mobile number is required' });
    if (!allowOtpRequest(phone, req.ip)) {
      return res.status(429).json({ message: 'Too many OTP requests. Please try again shortly.' });
    }

    const { otp, record } = await createOtp(phone, 'login', req);
    let delivery;
    try {
      delivery = await sendOtp(phone, otp);
    } catch (deliveryError) {
      await invalidateOtp(record);
      throw deliveryError;
    }
    const response = { success: true, message: 'OTP sent successfully' };
    if (delivery.devOtp) response.devOtp = delivery.devOtp;
    res.json(response);
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

exports.resendOtp = exports.sendOtp;

exports.verifyOtp = async (req, res) => {
  try {
    const { phone } = await verifyOtpRecord(req.body.phone, req.body.otp);
    const user = mongoose.connection.readyState === 1
      ? await upsertPhoneLoginUser(phone, { activeMode: 'customer' })
      : buildOfflineLoginUser(phone, { activeMode: 'customer' });
    res.json({ success: true, ...authPayload(user) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message });
  }
};

exports.me = async (req, res) => res.json(sanitize(req.user));

exports.logout = async (req, res) => {
  res.json({ success: true, message: 'Logged out successfully' });
};

exports.refresh = async (req, res) => {
  const token = req.body.refreshToken;
  if (!token) return res.status(401).json({ message: 'Refresh token required' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'dev_secret_change_me');
    if (decoded.tokenType !== 'refresh') return res.status(401).json({ message: 'Invalid refresh token' });

    let user;
    if (canRefreshOfflineSession(decoded)) {
      user = buildOfflineLoginUser(decoded.phone, { activeMode: decoded.activeMode || 'customer' });
    } else {
      user = await User.findById(decoded.id).select('-password');
      if (!user || user.isBlocked) return res.status(401).json({ message: 'Account unavailable' });
    }

    res.json({ success: true, ...authPayload(user) });
  } catch (error) {
    res.status(401).json({ message: 'Refresh token expired. Please login again.' });
  }
};

exports.switchMode = async (req, res) => {
  let mode = String(req.body.mode || req.body.activeMode || req.query.mode || '').trim();
  if (!['customer', 'admin'].includes(mode)) {
    if (req.user.role === 'admin' && req.user.availableModes?.includes('admin') && req.user.activeMode !== 'admin') {
      mode = 'admin';
    } else if (req.user.role === 'admin' && req.user.availableModes?.includes('customer') && req.user.activeMode === 'admin') {
      mode = 'customer';
    }
  }
  if (!['customer', 'admin'].includes(mode)) return res.status(400).json({ message: 'Invalid mode' });
  if (mode === 'admin' && (req.user.role !== 'admin' || !req.user.availableModes?.includes('admin'))) {
    return res.status(403).json({ message: 'Admin mode is not allowed' });
  }
  if (req.user.offlineSession) {
    req.user.activeMode = mode;
    return res.json({ success: true, ...authPayload(req.user) });
  }
  req.user.activeMode = mode;
  await req.user.save();
  res.json({ success: true, ...authPayload(req.user) });
};

function sanitize(user) {
  const data = typeof user.toObject === 'function' ? user.toObject() : { ...user };
  delete data.password;
  data.id = String(data._id || data.id);
  return data;
}

function authPayload(user) {
  return {
    user: sanitize(user),
    token: generateToken(user),
    refreshToken: generateRefreshToken(user),
  };
}

function getAdminPhones() {
  return String(process.env.ADMIN_PHONE_NUMBERS || '').split(',').map((item) => normalizePhone(item)).filter(Boolean);
}

async function upsertPhoneLoginUser(phone, { activeMode = 'customer' } = {}) {
  const isAdminPhone = getAdminPhones().includes(phone);
  let user = await User.findOne({ phone });
  if (!user) {
    user = await User.create({
      name: `Samira User ${phone.slice(-4)}`,
      phone,
      isPhoneVerified: true,
      role: isAdminPhone ? 'admin' : 'customer',
      availableModes: isAdminPhone ? ['customer', 'admin'] : ['customer'],
      activeMode,
    });
    return user;
  }

  if (user.isBlocked) {
    const error = new Error('Account is blocked');
    error.statusCode = 403;
    throw error;
  }

  user.isPhoneVerified = true;
  if (isAdminPhone || user.role === 'admin') {
    user.role = 'admin';
    user.availableModes = ['customer', 'admin'];
  } else {
    user.role = 'customer';
    user.availableModes = ['customer'];
  }
  user.activeMode = activeMode;
  await user.save();
  return user;
}

function buildOfflineLoginUser(phone, { activeMode = 'customer' } = {}) {
  if (process.env.NODE_ENV === 'production') {
    const error = new Error('Database is unavailable');
    error.statusCode = 503;
    throw error;
  }
  const isAdminPhone = getAdminPhones().includes(phone);
  const savedProfile = offlineProfiles.get(phone) || {};
  const user = {
    _id: `offline-${phone}`,
    id: `offline-${phone}`,
    name: savedProfile.name || `Samira User ${phone.slice(-4)}`,
    email: savedProfile.email,
    phone,
    gender: savedProfile.gender || '',
    birthDate: savedProfile.birthDate,
    alternatePhone: savedProfile.alternatePhone || '',
    hintName: savedProfile.hintName || '',
    isPhoneVerified: savedProfile.isPhoneVerified ?? true,
    isEmailVerified: savedProfile.isEmailVerified ?? false,
    role: isAdminPhone ? 'admin' : 'customer',
    availableModes: isAdminPhone ? ['customer', 'admin'] : ['customer'],
    activeMode,
    isBlocked: false,
    offlineSession: true,
  };
  user.toObject = () => ({ ...user });
  return user;
}

function canRefreshOfflineSession(decoded) {
  return process.env.NODE_ENV !== 'production'
    && mongoose.connection.readyState !== 1
    && decoded?.offlineSession
    && String(decoded.userId || decoded.id || '').startsWith('offline-');
}

function allowOtpRequest(phone, ip) {
  const key = `${phone}:${ip || 'unknown'}`;
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const limit = 8;
  const hits = (otpRateLimit.get(key) || []).filter((time) => now - time < windowMs);
  hits.push(now);
  otpRateLimit.set(key, hits);
  return hits.length <= limit;
}

function storeOfflineProfile(user) {
  const phone = String(user.phone || '');
  if (!phone) return;
  offlineProfiles.set(phone, {
    name: user.name || '',
    email: user.email || '',
    isEmailVerified: Boolean(user.isEmailVerified),
    gender: user.gender || '',
    birthDate: user.birthDate || undefined,
    alternatePhone: user.alternatePhone || '',
    hintName: user.hintName || '',
    isPhoneVerified: Boolean(user.isPhoneVerified),
  });
}

function removeOfflineProfile(user) {
  const phone = String(user.phone || '');
  if (!phone) return;
  offlineProfiles.delete(phone);
}

function normalizeTrimmed(value) {
  return String(value || '').trim();
}

function normalizeProfileEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!validEmail.test(email)) throw new Error('Please enter a valid email address');
  return email;
}

function normalizeProfilePhone(value, { allowEmpty = false } = {}) {
  const raw = String(value || '').replace(/\D/g, '');
  if (!raw) {
    if (allowEmpty) return '';
    return '';
  }

  const local = raw.replace(/^91/, '');
  if (!/^[6-9]\d{9}$/.test(local)) throw new Error('Please enter a valid 10-digit mobile number');
  return local;
}

function normalizeGender(value) {
  const gender = String(value || '').trim().toLowerCase();
  if (!gender) return '';
  if (!['male', 'female', 'other'].includes(gender)) throw new Error('Please select a valid gender');
  return gender;
}

function normalizeBirthDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Please enter a valid birth date');
  return date;
}

function createProfileChangeToken({ userId, targetType, target }) {
  return jwt.sign(
    {
      tokenType: 'profile_verification',
      userId: String(userId),
      targetType,
      target,
    },
    process.env.JWT_SECRET || 'dev_secret_change_me',
    { expiresIn: PROFILE_VERIFICATION_TOKEN_TTL },
  );
}

function verifyProfileChangeToken(token, { userId, targetType, target }) {
  if (!token) return false;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
    return decoded?.tokenType === 'profile_verification'
      && String(decoded.userId) === String(userId)
      && decoded.targetType === targetType
      && String(decoded.target) === String(target);
  } catch {
    return false;
  }
}
