const { effectivePermissions } = require('../config/adminPermissions');

function adminOnly(req, res, next) {
  if (req.user && ['admin', 'owner'].includes(req.user.role) && req.user.activeMode === 'admin') return next();
  return res.status(403).json({ message: 'Admin access required', code: 'ADMIN_REQUIRED' });
}

function ownerOnly(req, res, next) {
  if (req.user && req.user.role === 'owner' && req.user.activeMode === 'admin') return next();
  return res.status(403).json({ message: 'Owner access required', code: 'OWNER_REQUIRED' });
}

function requirePermission(...required) {
  return function permissionRequired(req, res, next) {
    const permissions = effectivePermissions(req.user);
    if (required.some((permission) => permissions.has(permission))) return next();
    return res.status(403).json({ message: 'This admin account does not have permission for that action', code: 'PERMISSION_DENIED' });
  };
}

module.exports = { adminOnly, ownerOnly, requirePermission };
