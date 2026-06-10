const jwt = require('jsonwebtoken');

function tokenPayload(user) {
  const id = user._id || user.id || user;
  return {
    id,
    userId: id,
    phone: user.phone,
    name: user.name,
    role: user.role,
    activeMode: user.activeMode,
    offlineSession: !!user.offlineSession,
  };
}

function generateToken(user) {
  return jwt.sign(tokenPayload(user), process.env.JWT_SECRET || 'dev_secret_change_me', {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });
}

function generateRefreshToken(user) {
  return jwt.sign(
    { ...tokenPayload(user), tokenType: 'refresh' },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'dev_secret_change_me',
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' },
  );
}

module.exports = { generateRefreshToken, generateToken };
