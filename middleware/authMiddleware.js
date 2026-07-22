const mongoose = require('mongoose');
const User = require('../models/User');
const { verifyAccessToken } = require('../utils/generateToken');

async function protect(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.split(' ')[1] : null;
  if (!token) return res.status(401).json({ message: 'Not authorized' });

  try {
    const decoded = verifyAccessToken(token);
    if (canUseOfflineSession(decoded)) {
      req.user = buildOfflineUser(decoded);
      req.auth = decoded;
      return next();
    }
    req.user = await User.findById(decoded.id).select('+tokenVersion');
    if (!req.user || req.user.isBlocked) return res.status(401).json({ message: 'Account unavailable' });
    if (Number(decoded.tokenVersion || 0) !== Number(req.user.tokenVersion || 0)) {
      return res.status(401).json({ message: 'Session is no longer valid' });
    }
    req.auth = decoded;
    next();
  } catch {
    res.status(401).json({ message: 'Token failed' });
  }
}

function canUseOfflineSession(decoded) {
  return process.env.NODE_ENV !== 'production'
    && process.env.ALLOW_OFFLINE_AUTH === 'true'
    && mongoose.connection.readyState !== 1
    && decoded?.offlineSession
    && String(decoded.userId || decoded.id || '').startsWith('offline-');
}

function buildOfflineUser(decoded) {
  const user = {
    _id: decoded.userId || decoded.id,
    id: decoded.userId || decoded.id,
    name: decoded.name || `Samira User ${String(decoded.phone || '').slice(-4)}`,
    phone: decoded.phone,
    isPhoneVerified: true,
    role: decoded.role || 'customer',
    availableModes: ['admin', 'owner'].includes(decoded.role) ? ['customer', 'admin'] : ['customer'],
    activeMode: decoded.activeMode || 'customer',
    isBlocked: false,
    offlineSession: true,
  };
  user.toObject = () => ({ ...user });
  return user;
}

module.exports = { protect };
