const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

async function protect(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.split(' ')[1] : null;
  if (!token) return res.status(401).json({ message: 'Not authorized' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
    if (canUseOfflineSession(decoded)) {
      req.user = buildOfflineUser(decoded);
      return next();
    }
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user || req.user.isBlocked) return res.status(401).json({ message: 'Account unavailable' });
    next();
  } catch (error) {
    res.status(401).json({ message: 'Token failed' });
  }
}

function canUseOfflineSession(decoded) {
  return process.env.NODE_ENV !== 'production'
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
    availableModes: decoded.role === 'admin' ? ['customer', 'admin'] : ['customer'],
    activeMode: decoded.activeMode || 'customer',
    isBlocked: false,
    offlineSession: true,
  };
  user.toObject = () => ({ ...user });
  return user;
}

module.exports = { protect };
