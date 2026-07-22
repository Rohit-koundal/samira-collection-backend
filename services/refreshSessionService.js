const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const RefreshSession = require('../models/RefreshSession');
const { generateRefreshToken, verifyRefreshToken } = require('../utils/generateToken');

const REFRESH_COOKIE = 'samira_refresh';
const CSRF_COOKIE = 'samira_csrf';
const memorySessions = new Map();

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function canUseMemorySessions() {
  return process.env.NODE_ENV === 'test'
    || (process.env.NODE_ENV !== 'production'
      && process.env.ALLOW_OFFLINE_AUTH === 'true'
      && mongoose.connection.readyState !== 1);
}

async function issueRefreshSession(user, metadata = {}, familyId = crypto.randomUUID()) {
  const jti = crypto.randomUUID();
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const token = generateRefreshToken(user, { jti, familyId });
  const decoded = jwt.decode(token);
  const session = {
    user: String(user._id || user.id),
    tokenHash: hashValue(token),
    csrfHash: hashValue(csrfToken),
    jti,
    familyId,
    expiresAt: new Date(Number(decoded.exp) * 1000),
    revokedAt: null,
    revokeReason: null,
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent,
    createdAt: new Date(),
  };

  if (canUseMemorySessions()) {
    memorySessions.set(session.tokenHash, session);
  } else {
    await RefreshSession.create(session);
  }

  return { token, csrfToken, session };
}

async function rotateRefreshSession(rawToken, user, metadata = {}) {
  const decoded = verifyRefreshToken(rawToken);
  const tokenHash = hashValue(rawToken);
  const current = await findSession(tokenHash);
  if (!current) throw authError('Refresh session is unavailable');

  if (current.revokedAt) {
    await revokeFamily(current.familyId, 'reuse_detected', { reuseDetectedAt: new Date() });
    throw authError('Refresh token reuse detected', 'REFRESH_TOKEN_REUSE');
  }

  validateSession(current, decoded, user, metadata.csrfToken);
  const consumed = await consumeSession(current);
  if (!consumed) {
    await revokeFamily(current.familyId, 'reuse_detected', { reuseDetectedAt: new Date() });
    throw authError('Refresh token reuse detected', 'REFRESH_TOKEN_REUSE');
  }

  const replacement = await issueRefreshSession(user, metadata, current.familyId);
  await linkReplacement(current, replacement.session.jti);
  return replacement;
}

async function revokeRefreshToken(rawToken, reason = 'logout') {
  if (!rawToken) return false;
  const current = await findSession(hashValue(rawToken));
  if (!current) return false;
  await revokeFamily(current.familyId, reason);
  return true;
}

async function revokeAllUserSessions(userId, reason = 'account_security_change') {
  const now = new Date();
  if (canUseMemorySessions()) {
    for (const session of memorySessions.values()) {
      if (String(session.user) === String(userId) && !session.revokedAt) {
        session.revokedAt = now;
        session.revokeReason = reason;
      }
    }
    return;
  }
  await RefreshSession.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: now, revokeReason: reason } },
  );
}

async function findSession(tokenHash) {
  if (canUseMemorySessions()) return memorySessions.get(tokenHash) || null;
  return RefreshSession.findOne({ tokenHash });
}

function validateSession(session, decoded, user, csrfToken) {
  const userId = String(user._id || user.id);
  if (
    String(session.user) !== userId
    || String(decoded.id) !== userId
    || session.jti !== decoded.jti
    || session.familyId !== decoded.familyId
  ) {
    throw authError('Refresh session is invalid');
  }
  if (Number(decoded.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
    throw authError('Refresh session is no longer valid');
  }
  if (session.expiresAt <= new Date()) throw authError('Refresh session has expired');
  if (csrfToken && !safeEqual(session.csrfHash, hashValue(csrfToken))) {
    throw csrfError();
  }
}

async function consumeSession(session) {
  const now = new Date();
  if (canUseMemorySessions()) {
    if (session.revokedAt || session.expiresAt <= now) return false;
    session.revokedAt = now;
    session.revokeReason = 'rotated';
    session.lastUsedAt = now;
    return true;
  }
  return RefreshSession.findOneAndUpdate(
    { _id: session._id, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now, revokeReason: 'rotated', lastUsedAt: now } },
    { new: true },
  );
}

async function linkReplacement(session, replacementJti) {
  if (canUseMemorySessions()) {
    session.replacedBy = replacementJti;
    return;
  }
  await RefreshSession.updateOne({ _id: session._id }, { $set: { replacedBy: replacementJti } });
}

async function revokeFamily(familyId, reason, extra = {}) {
  const now = new Date();
  if (canUseMemorySessions()) {
    for (const session of memorySessions.values()) {
      if (session.familyId === familyId) {
        if (!session.revokedAt) session.revokedAt = now;
        session.revokeReason = reason;
        Object.assign(session, extra);
      }
    }
    return;
  }
  await RefreshSession.updateMany(
    { familyId },
    { $set: { revokedAt: now, revokeReason: reason, ...extra } },
  );
}

function getPresentedRefreshToken(req) {
  const cookieToken = readCookie(req, REFRESH_COOKIE);
  if (cookieToken) return { token: cookieToken, source: 'cookie' };
  if (
    process.env.NODE_ENV !== 'production'
    && process.env.ALLOW_REFRESH_TOKEN_BODY === 'true'
    && req.body?.refreshToken
  ) {
    return { token: String(req.body.refreshToken), source: 'body' };
  }
  return { token: '', source: 'none' };
}

function requireCookieCsrf(req) {
  const cookieToken = readCookie(req, CSRF_COOKIE);
  const headerToken = String(req.headers?.['x-csrf-token'] || '');
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) throw csrfError();
  return headerToken;
}

function setAuthCookies(res, token, csrfToken) {
  const options = getCookieOptions();
  res.cookie(REFRESH_COOKIE, token, { ...options, path: '/api/auth', httpOnly: true });
  res.cookie(CSRF_COOKIE, csrfToken, { ...options, path: '/', httpOnly: false });
}

function clearAuthCookies(res) {
  const options = getCookieOptions();
  delete options.maxAge;
  res.clearCookie(REFRESH_COOKIE, { ...options, path: '/api/auth', httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...options, path: '/', httpOnly: false });
}

function getCookieOptions() {
  const sameSite = String(process.env.AUTH_COOKIE_SAME_SITE || 'lax').toLowerCase();
  const options = {
    secure: process.env.NODE_ENV === 'production',
    sameSite: ['lax', 'strict', 'none'].includes(sameSite) ? sameSite : 'lax',
    maxAge: parseDurationMs(process.env.JWT_REFRESH_EXPIRES_IN || '30d'),
  };
  if (process.env.AUTH_COOKIE_DOMAIN) options.domain = process.env.AUTH_COOKIE_DOMAIN;
  return options;
}

function parseDurationMs(value) {
  if (typeof value === 'number') return value * 1000;
  const match = String(value).trim().match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return Number(match[1]) * multipliers[match[2].toLowerCase()];
}

function readCookie(req, name) {
  const raw = String(req.headers?.cookie || '');
  const match = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!match) return '';
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    return '';
  }
}

function authError(message, code = 'INVALID_REFRESH_TOKEN') {
  const error = new Error(message);
  error.statusCode = 401;
  error.code = code;
  return error;
}

function csrfError() {
  const error = new Error('CSRF validation failed');
  error.statusCode = 403;
  error.code = 'CSRF_VALIDATION_FAILED';
  return error;
}

function resetMemorySessionsForTests() {
  if (process.env.NODE_ENV === 'test') memorySessions.clear();
}

module.exports = {
  CSRF_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  getPresentedRefreshToken,
  hashValue,
  issueRefreshSession,
  requireCookieCsrf,
  resetMemorySessionsForTests,
  revokeAllUserSessions,
  revokeRefreshToken,
  rotateRefreshSession,
  setAuthCookies,
};
