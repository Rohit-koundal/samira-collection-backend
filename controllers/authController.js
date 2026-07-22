const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { generateToken, getRequiredSecret, verifyRefreshToken } = require('../utils/generateToken');
const {
  createEmailOtp,
  createOtp,
  invalidateOtp,
  isDevOtpAllowed,
  normalizeEmail,
  normalizePhone,
  verifyEmailOtp: verifyEmailOtpRecord,
  verifyOtp: verifyOtpRecord,
} = require('../services/otpService');
const { sendOtp } = require('../services/smsService');
const { sendOtpEmail } = require('../services/emailService');
const { enforceRateLimits } = require('../services/rateLimitService');
const {
  clearAuthCookies,
  getPresentedRefreshToken,
  issueRefreshSession,
  requireCookieCsrf,
  revokeAllUserSessions,
  revokeRefreshToken,
  rotateRefreshSession,
  setAuthCookies,
} = require('../services/refreshSessionService');
const {
  validateLogin,
  validateOtpSend,
  validateOtpVerify,
  validateProfileUpdate,
  validateRefreshRequest,
  validateRegistration,
  validateSwitchMode,
} = require('../utils/authValidation');

const offlineProfiles = new Map();
const PROFILE_VERIFICATION_TOKEN_TTL = process.env.PROFILE_VERIFICATION_TOKEN_TTL || '15m';

exports.register = async (req, res) => {
  try {
    const payload = validateRegistration(req.body);
    await enforceAuthLimits('register', req, payload.phone);
    const existing = await User.findOne({
      $or: [{ phone: payload.phone }, ...(payload.email ? [{ email: payload.email }] : [])],
    }).select('_id');
    if (existing) return res.status(409).json({ message: 'An account already exists for these details' });
    const user = await User.create(payload);
    return respondWithAuth(req, res, user, 201);
  } catch (error) {
    return sendAuthError(res, error, 'Unable to create account');
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = validateLogin(req.body);
    await enforceAuthLimits('login', req, email);
    const user = await User.findOne({ email }).select('+password +tokenVersion');
    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    if (user.isBlocked) return res.status(403).json({ message: 'Account unavailable' });

    const shouldUpgradePassword = user.hasLegacyPlainPassword?.();
    if (['admin', 'owner'].includes(user.role)) {
      user.availableModes = ['customer', 'admin'];
      user.activeMode = 'admin';
    }
    if (shouldUpgradePassword) user.markModified('password');
    if (['admin', 'owner'].includes(user.role) || shouldUpgradePassword) await user.save();
    return respondWithAuth(req, res, user);
  } catch (error) {
    return sendAuthError(res, error, 'Unable to sign in');
  }
};

exports.profile = async (req, res) => res.json(sanitize(req.user));
exports.me = exports.profile;

exports.updateProfile = async (req, res) => {
  try {
    const safeBody = validateProfileUpdate(req.body);
    const previousPhone = String(req.user.phone || '');
    const previousEmail = String(req.user.email || '').toLowerCase();
    const nextName = hasOwn(safeBody, 'name') ? normalizeTrimmed(safeBody.name) : req.user.name;
    const nextEmail = hasOwn(safeBody, 'email') ? normalizeProfileEmail(safeBody.email) : previousEmail;
    const nextPhone = hasOwn(safeBody, 'phone') ? normalizeProfilePhone(safeBody.phone) : previousPhone;
    const nextAlternatePhone = hasOwn(safeBody, 'alternatePhone')
      ? normalizeProfilePhone(safeBody.alternatePhone, { allowEmpty: true })
      : req.user.alternatePhone;
    const nextHintName = hasOwn(safeBody, 'hintName') ? normalizeTrimmed(safeBody.hintName) : req.user.hintName;
    const nextGender = hasOwn(safeBody, 'gender') ? normalizeGender(safeBody.gender) : req.user.gender;
    const nextBirthDate = hasOwn(safeBody, 'birthDate') ? normalizeBirthDate(safeBody.birthDate) : req.user.birthDate;

    if (!nextName) return res.status(400).json({ message: 'Name is required' });
    if (!nextPhone) return res.status(400).json({ message: 'Mobile number is required' });

    if (nextEmail && req.user.offlineSession !== true) {
      const existing = await User.findOne({ email: nextEmail, _id: { $ne: req.user._id } }).select('_id');
      if (existing) return res.status(409).json({ message: 'Email is already in use' });
    }
    if (nextPhone && req.user.offlineSession !== true) {
      const existing = await User.findOne({ phone: nextPhone, _id: { $ne: req.user._id } }).select('_id');
      if (existing) return res.status(409).json({ message: 'Mobile number is already in use' });
    }

    const phoneChanged = nextPhone !== previousPhone;
    const emailChanged = nextEmail !== previousEmail;
    const verifiedPhone = phoneChanged && verifyProfileChangeToken(safeBody.phoneVerificationToken, {
      userId: req.user._id || req.user.id,
      targetType: 'phone',
      target: nextPhone,
      source: previousPhone,
      tokenVersion: req.user.tokenVersion,
    });
    const verifiedEmail = nextEmail
      ? (emailChanged
        ? verifyProfileChangeToken(safeBody.emailVerificationToken, {
          userId: req.user._id || req.user.id,
          targetType: 'email',
          target: nextEmail,
          source: previousEmail,
          tokenVersion: req.user.tokenVersion,
        })
        : Boolean(req.user.isEmailVerified))
      : false;

    if (phoneChanged && !verifiedPhone) {
      return res.status(400).json({ message: 'Please verify your new mobile number before saving' });
    }
    if (nextEmail && emailChanged && !verifiedEmail) {
      return res.status(400).json({ message: 'Please verify your email before saving' });
    }

    const nextProfile = {
      name: nextName,
      email: nextEmail || undefined,
      phone: nextPhone,
      gender: nextGender,
      birthDate: nextBirthDate,
      alternatePhone: nextAlternatePhone,
      hintName: nextHintName,
      isEmailVerified: verifiedEmail,
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
    return res.json(sanitize(req.user));
  } catch (error) {
    return sendAuthError(res, error, 'Unable to update profile');
  }
};

exports.sendProfilePhoneChangeOtp = async (req, res) => {
  try {
    const { phone } = validateOtpSend(req.body);
    await enforceAuthLimits('otp_send', req, phone);
    if (phone === String(req.user.phone || '')) {
      return res.status(400).json({ message: 'This mobile number is already on your account' });
    }
    const existing = req.user.offlineSession
      ? null
      : await User.findOne({ phone, _id: { $ne: req.user._id } }).select('_id');
    if (existing) return res.status(409).json({ message: 'Mobile number is already in use' });

    const { otp, record } = await createOtp(phone, 'profile_phone_change', req);
    const delivery = await deliverPhoneOtp(phone, otp, record);
    return res.json(otpSentResponse(delivery));
  } catch (error) {
    return sendAuthError(res, error, 'Unable to send OTP');
  }
};

exports.verifyProfilePhoneChangeOtp = async (req, res) => {
  try {
    const { phone, otp } = validateOtpVerify(req.body);
    await enforceAuthLimits('otp_verify', req, phone);
    await verifyOtpRecord(phone, otp, 'profile_phone_change');
    const verificationToken = createProfileChangeToken({
      userId: req.user._id || req.user.id,
      targetType: 'phone',
      target: phone,
      source: String(req.user.phone || ''),
      tokenVersion: req.user.tokenVersion,
    });
    return res.json({ success: true, verified: true, verificationToken });
  } catch (error) {
    return sendAuthError(res, error, 'Unable to verify OTP');
  }
};

exports.sendProfileEmailChangeOtp = async (req, res) => {
  try {
    const { email } = validateOtpSend(req.body, 'email');
    await enforceAuthLimits('otp_send', req, email);
    if (email === String(req.user.email || '').toLowerCase()) {
      return res.status(400).json({ message: 'This email is already on your account' });
    }
    const existing = req.user.offlineSession
      ? null
      : await User.findOne({ email, _id: { $ne: req.user._id } }).select('_id');
    if (existing) return res.status(409).json({ message: 'Email is already in use' });

    const { otp, record } = await createEmailOtp(email, 'profile_email_change', req);
    const delivery = await deliverEmailOtp(email, otp, record);
    return res.json(otpSentResponse(delivery));
  } catch (error) {
    return sendAuthError(res, error, 'Unable to send OTP');
  }
};

exports.verifyProfileEmailChangeOtp = async (req, res) => {
  try {
    const { email, otp } = validateOtpVerify(req.body, 'email');
    await enforceAuthLimits('otp_verify', req, email);
    await verifyEmailOtpRecord(email, otp, 'profile_email_change');
    const verificationToken = createProfileChangeToken({
      userId: req.user._id || req.user.id,
      targetType: 'email',
      target: email,
      source: String(req.user.email || '').toLowerCase(),
      tokenVersion: req.user.tokenVersion,
    });
    return res.json({ success: true, verified: true, verificationToken });
  } catch (error) {
    return sendAuthError(res, error, 'Unable to verify OTP');
  }
};

exports.deleteProfile = async (req, res) => {
  try {
    if (req.user.offlineSession) {
      removeOfflineProfile(req.user);
    } else {
      await revokeAllUserSessions(req.user._id, 'account_deleted');
      await User.findByIdAndDelete(req.user._id);
    }
    clearAuthCookies(res);
    return res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    return sendAuthError(res, error, 'Unable to delete account');
  }
};

exports.sendOtp = async (req, res) => {
  try {
    const { phone } = validateOtpSend(req.body);
    await enforceAuthLimits('otp_send', req, phone);
    const { otp, record } = await createOtp(phone, 'login', req);
    const delivery = await deliverPhoneOtp(phone, otp, record);
    return res.json(otpSentResponse(delivery));
  } catch (error) {
    return sendAuthError(res, error, 'Unable to send OTP');
  }
};

exports.resendOtp = exports.sendOtp;

exports.verifyOtp = async (req, res) => {
  try {
    const { phone, otp } = validateOtpVerify(req.body);
    await enforceAuthLimits('otp_verify', req, phone);
    await verifyOtpRecord(phone, otp, 'login');
    const user = mongoose.connection.readyState === 1
      ? await upsertPhoneLoginUser(phone, { activeMode: 'customer' })
      : buildOfflineLoginUser(phone, { activeMode: 'customer' });
    return respondWithAuth(req, res, user);
  } catch (error) {
    return sendAuthError(res, error, 'Unable to verify OTP');
  }
};

exports.logout = async (req, res) => {
  try {
    validateRefreshRequest(req.body || {});
    const presented = getPresentedRefreshToken(req);
    if (presented.source === 'cookie') requireCookieCsrf(req);
    if (presented.token) await revokeRefreshToken(presented.token, 'logout');
    clearAuthCookies(res);
    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    return sendAuthError(res, error, 'Unable to log out');
  }
};

exports.refresh = async (req, res) => {
  try {
    validateRefreshRequest(req.body || {});
    await enforceAuthLimits('refresh', req);
    const presented = getPresentedRefreshToken(req);
    if (!presented.token) return res.status(401).json({ message: 'Refresh token required' });
    const csrfToken = presented.source === 'cookie' ? requireCookieCsrf(req) : undefined;
    const decoded = verifyRefreshToken(presented.token);
    const user = canRefreshOfflineSession(decoded)
      ? buildOfflineLoginUser(decoded.phone, { activeMode: decoded.activeMode || 'customer' })
      : await User.findById(decoded.id).select('+tokenVersion');
    if (!user || user.isBlocked) return res.status(401).json({ message: 'Account unavailable' });

    const replacement = await rotateRefreshSession(presented.token, user, {
      csrfToken,
      ipAddress: req.ip,
      userAgent: String(req.headers?.['user-agent'] || '').slice(0, 500),
    });
    setAuthCookies(res, replacement.token, replacement.csrfToken);
    return res.json({
      success: true,
      user: sanitize(user),
      token: generateToken(user),
      csrfToken: replacement.csrfToken,
    });
  } catch (error) {
    if (!['CSRF_VALIDATION_FAILED', 'RATE_LIMIT_EXCEEDED', 'VALIDATION_ERROR'].includes(error?.code)) {
      clearAuthCookies(res);
    }
    return sendAuthError(res, error, 'Refresh token expired. Please login again.');
  }
};

exports.switchMode = async (req, res) => {
  try {
    const { mode } = validateSwitchMode(req.body);
    if (mode === 'admin' && (!['admin', 'owner'].includes(req.user.role) || !req.user.availableModes?.includes('admin'))) {
      return res.status(403).json({ message: 'Admin mode is not allowed' });
    }
    req.user.activeMode = mode;
    if (!req.user.offlineSession) await req.user.save();

    const current = getPresentedRefreshToken(req);
    if (current.token) await revokeRefreshToken(current.token, 'mode_changed');
    return respondWithAuth(req, res, req.user);
  } catch (error) {
    return sendAuthError(res, error, 'Unable to switch mode');
  }
};

async function respondWithAuth(req, res, user, status = 200) {
  const token = generateToken(user);
  const refresh = await issueRefreshSession(user, {
    ipAddress: req.ip,
    userAgent: String(req.headers?.['user-agent'] || '').slice(0, 500),
  });
  setAuthCookies(res, refresh.token, refresh.csrfToken);
  const payload = {
    success: true,
    user: sanitize(user),
    token,
    csrfToken: refresh.csrfToken,
  };
  if (process.env.NODE_ENV !== 'production' && process.env.RETURN_REFRESH_TOKEN_IN_BODY === 'true') {
    payload.refreshToken = refresh.token;
  }
  return res.status(status).json(payload);
}

function sanitize(user) {
  const data = typeof user.toObject === 'function' ? user.toObject() : { ...user };
  delete data.password;
  delete data.tokenVersion;
  delete data.__v;
  data.id = String(data._id || data.id);
  return data;
}

async function upsertPhoneLoginUser(phone, { activeMode = 'customer' } = {}) {
  let user = await User.findOne({ phone }).select('+tokenVersion');
  if (!user) {
    return User.create({
      name: `Samira User ${phone.slice(-4)}`,
      phone,
      email: `phone+${phone}@samira.invalid`,
      isPhoneVerified: true,
      role: 'customer',
      availableModes: ['customer'],
      activeMode: 'customer',
      isBlocked: false,
    });
  }
  if (user.isBlocked) {
    const error = new Error('Account unavailable');
    error.statusCode = 403;
    throw error;
  }
  user.isPhoneVerified = true;
  user.availableModes = ['admin', 'owner'].includes(user.role) ? ['customer', 'admin'] : ['customer'];
  user.activeMode = activeMode;
  await user.save();
  return user;
}

function buildOfflineLoginUser(phone, { activeMode = 'customer' } = {}) {
  if (
    process.env.NODE_ENV === 'production'
    || process.env.ALLOW_OFFLINE_AUTH !== 'true'
    || process.env.ALLOW_DEV_OTP !== 'true'
  ) {
    const error = new Error('Authentication service is unavailable');
    error.statusCode = 503;
    throw error;
  }
  const saved = offlineProfiles.get(phone) || {};
  const user = {
    _id: `offline-${phone}`,
    id: `offline-${phone}`,
    name: saved.name || `Samira User ${phone.slice(-4)}`,
    email: saved.email,
    phone,
    gender: saved.gender || '',
    birthDate: saved.birthDate,
    alternatePhone: saved.alternatePhone || '',
    hintName: saved.hintName || '',
    isPhoneVerified: saved.isPhoneVerified ?? true,
    isEmailVerified: saved.isEmailVerified ?? false,
    role: 'customer',
    availableModes: ['customer'],
    activeMode,
    isBlocked: false,
    tokenVersion: 0,
    offlineSession: true,
  };
  user.toObject = () => ({ ...user });
  return user;
}

function canRefreshOfflineSession(decoded) {
  return process.env.NODE_ENV !== 'production'
    && process.env.ALLOW_OFFLINE_AUTH === 'true'
    && mongoose.connection.readyState !== 1
    && decoded?.offlineSession
    && String(decoded.id || '').startsWith('offline-');
}

async function deliverPhoneOtp(phone, otp, record) {
  try {
    const delivery = await sendOtp(phone, otp);
    if (!delivery?.success) throw new Error('OTP delivery failed');
    return delivery;
  } catch {
    await invalidateOtp(record, 'delivery_failed');
    const error = new Error('Unable to deliver OTP. Please try again later.');
    error.statusCode = 503;
    throw error;
  }
}

async function deliverEmailOtp(email, otp, record) {
  try {
    const delivery = await sendOtpEmail(email, otp);
    if (!delivery?.success) throw new Error('OTP delivery failed');
    return delivery;
  } catch {
    await invalidateOtp(record, 'delivery_failed');
    const error = new Error('Unable to deliver OTP. Please try again later.');
    error.statusCode = 503;
    throw error;
  }
}

function otpSentResponse(delivery) {
  const response = { success: true, message: 'OTP sent successfully' };
  if (isDevOtpAllowed() && delivery?.devOtp) response.devOtp = delivery.devOtp;
  return response;
}

async function enforceAuthLimits(action, req, identifier = '') {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const limits = {
    register: { ip: [10, 3600], target: [3, 3600] },
    login: { ip: [20, 900], target: [8, 900] },
    otp_send: { ip: [20, 600], target: [5, 600] },
    otp_verify: { ip: [30, 600], target: [10, 600] },
    refresh: { ip: [60, 900], target: null },
  }[action];
  const rules = [{
    scope: `${action}:ip`,
    identifier: ip,
    limit: limits.ip[0],
    windowSeconds: limits.ip[1],
  }];
  if (limits.target && identifier) {
    rules.push({
      scope: `${action}:target`,
      identifier,
      limit: limits.target[0],
      windowSeconds: limits.target[1],
    });
  }
  await enforceRateLimits(rules);
}

function storeOfflineProfile(user) {
  const phone = String(user.phone || '');
  if (!phone) return;
  offlineProfiles.set(phone, {
    name: user.name || '',
    email: user.email || '',
    isEmailVerified: Boolean(user.isEmailVerified),
    gender: user.gender || '',
    birthDate: user.birthDate,
    alternatePhone: user.alternatePhone || '',
    hintName: user.hintName || '',
    isPhoneVerified: Boolean(user.isPhoneVerified),
  });
}

function removeOfflineProfile(user) {
  const phone = String(user.phone || '');
  if (phone) offlineProfiles.delete(phone);
}

function normalizeTrimmed(value) {
  return String(value || '').trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 80);
}

function normalizeProfileEmail(value) {
  if (value === undefined || value === null || value === '') return '';
  const email = normalizeEmail(value);
  if (!email) throw Object.assign(new Error('Please enter a valid email address'), { statusCode: 400 });
  return email;
}

function normalizeProfilePhone(value, { allowEmpty = false } = {}) {
  if (allowEmpty && !String(value || '').trim()) return '';
  const phone = normalizePhone(value);
  if (!phone) throw Object.assign(new Error('Please enter a valid mobile number'), { statusCode: 400 });
  return phone;
}

function normalizeGender(value) {
  const gender = String(value || '').trim().toLowerCase();
  if (!gender) return '';
  if (!['male', 'female', 'other'].includes(gender)) {
    throw Object.assign(new Error('Please select a valid gender'), { statusCode: 400 });
  }
  return gender;
}

function normalizeBirthDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date > new Date()) {
    throw Object.assign(new Error('Please enter a valid birth date'), { statusCode: 400 });
  }
  return date;
}

function createProfileChangeToken({ userId, targetType, target, source, tokenVersion }) {
  return jwt.sign(
    {
      tokenType: 'profile_verification',
      userId: String(userId),
      targetType,
      target,
      source: String(source || ''),
      tokenVersion: Number(tokenVersion || 0),
    },
    getRequiredSecret('JWT_SECRET'),
    {
      algorithm: 'HS256',
      audience: process.env.JWT_AUDIENCE || 'samira-collection-web',
      issuer: process.env.JWT_ISSUER || 'samira-collection-api',
      expiresIn: PROFILE_VERIFICATION_TOKEN_TTL,
    },
  );
}

function verifyProfileChangeToken(token, {
  userId,
  targetType,
  target,
  source,
  tokenVersion,
}) {
  if (!token) return false;
  try {
    const decoded = jwt.verify(token, getRequiredSecret('JWT_SECRET'), {
      algorithms: ['HS256'],
      audience: process.env.JWT_AUDIENCE || 'samira-collection-web',
      issuer: process.env.JWT_ISSUER || 'samira-collection-api',
    });
    return decoded?.tokenType === 'profile_verification'
      && String(decoded.userId) === String(userId)
      && decoded.targetType === targetType
      && String(decoded.target) === String(target)
      && String(decoded.source || '') === String(source || '')
      && Number(decoded.tokenVersion || 0) === Number(tokenVersion || 0);
  } catch {
    return false;
  }
}

function sendAuthError(res, error, fallbackMessage) {
  const status = Number(error?.statusCode) || (error?.code === 11000 ? 409 : 500);
  if (error?.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const message = safeStatus >= 500 ? fallbackMessage : (error?.message || fallbackMessage);
  return res.status(safeStatus).json({ message });
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

exports._private = {
  otpSentResponse,
  sanitize,
};
