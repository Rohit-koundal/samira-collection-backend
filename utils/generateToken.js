const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_TYPE = 'access';
const REFRESH_TOKEN_TYPE = 'refresh';

function getRequiredSecret(name) {
  const value = String(process.env[name] || '');
  if (!value) {
    const error = new Error('Authentication is not configured');
    error.code = 'AUTH_CONFIGURATION_ERROR';
    throw error;
  }
  return value;
}

function getJwtOptions(expiresIn) {
  return {
    algorithm: 'HS256',
    audience: process.env.JWT_AUDIENCE || 'samira-collection-web',
    issuer: process.env.JWT_ISSUER || 'samira-collection-api',
    expiresIn,
  };
}

function tokenPayload(user) {
  const id = user._id || user.id || user;
  return {
    id: String(id),
    userId: String(id),
    phone: user.phone,
    name: user.name,
    role: user.role,
    activeMode: user.activeMode,
    tokenVersion: Number(user.tokenVersion || 0),
    offlineSession: Boolean(user.offlineSession),
  };
}

function generateToken(user) {
  return jwt.sign(
    { ...tokenPayload(user), tokenType: ACCESS_TOKEN_TYPE },
    getRequiredSecret('JWT_SECRET'),
    getJwtOptions(process.env.JWT_EXPIRES_IN || '15m'),
  );
}

function generateRefreshToken(user, { jti, familyId } = {}) {
  if (!jti || !familyId) throw new Error('Refresh token identifiers are required');
  return jwt.sign(
    { ...tokenPayload(user), tokenType: REFRESH_TOKEN_TYPE, jti, familyId },
    getRequiredSecret('JWT_REFRESH_SECRET'),
    getJwtOptions(process.env.JWT_REFRESH_EXPIRES_IN || '30d'),
  );
}

function verifyAccessToken(token) {
  const decoded = jwt.verify(token, getRequiredSecret('JWT_SECRET'), {
    algorithms: ['HS256'],
    audience: process.env.JWT_AUDIENCE || 'samira-collection-web',
    issuer: process.env.JWT_ISSUER || 'samira-collection-api',
  });
  if (decoded.tokenType !== ACCESS_TOKEN_TYPE) throw new Error('Invalid access token');
  return decoded;
}

function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, getRequiredSecret('JWT_REFRESH_SECRET'), {
    algorithms: ['HS256'],
    audience: process.env.JWT_AUDIENCE || 'samira-collection-web',
    issuer: process.env.JWT_ISSUER || 'samira-collection-api',
  });
  if (decoded.tokenType !== REFRESH_TOKEN_TYPE) throw new Error('Invalid refresh token');
  return decoded;
}

module.exports = {
  ACCESS_TOKEN_TYPE,
  REFRESH_TOKEN_TYPE,
  generateRefreshToken,
  generateToken,
  getRequiredSecret,
  verifyAccessToken,
  verifyRefreshToken,
};
