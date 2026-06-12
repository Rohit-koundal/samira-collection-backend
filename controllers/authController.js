const User = require('../models/User');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { generateRefreshToken, generateToken } = require('../utils/generateToken');
const { normalizePhone, createOtp, invalidateOtp, verifyOtp: verifyOtpRecord } = require('../services/otpService');
const { sendOtp } = require('../services/smsService');

const otpRateLimit = new Map();

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
  const { role, availableModes, activeMode, isBlocked, phone, ...safeBody } = req.body;
  Object.assign(req.user, safeBody);
  await req.user.save();
  res.json(sanitize(req.user));
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
  const mode = req.body.mode;
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
  const user = {
    _id: `offline-${phone}`,
    id: `offline-${phone}`,
    name: `Samira User ${phone.slice(-4)}`,
    phone,
    isPhoneVerified: true,
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
