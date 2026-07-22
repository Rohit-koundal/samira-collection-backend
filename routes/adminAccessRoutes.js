const router = require('express').Router();
const User = require('../models/User');
const { ADMIN_ROLES, PERMISSIONS } = require('../config/adminPermissions');
const { recordAdminAudit } = require('../services/adminAuditService');
const { revokeAllUserSessions } = require('../services/refreshSessionService');
const { assertObjectId } = require('../utils/requestValidation');

router.get('/', async (req, res) => {
  const users = await User.find({ role: { $in: ['admin', 'owner'] } })
    .select('name email phone role adminRole permissions isBlocked createdAt')
    .sort('-createdAt');
  return res.json(users);
});

router.patch('/:id', async (req, res) => {
  assertObjectId(req.params.id, 'user id');
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (user.role !== 'admin') return res.status(409).json({ message: 'Granular access can only be assigned to admin accounts' });
  const adminRole = String(req.body.adminRole || '');
  if (!ADMIN_ROLES.includes(adminRole)) return res.status(400).json({ message: 'Invalid admin role' });
  const permissions = req.body.permissions === undefined ? [] : req.body.permissions;
  if (!Array.isArray(permissions) || permissions.some((permission) => !PERMISSIONS.includes(permission))) {
    return res.status(400).json({ message: 'Invalid admin permissions' });
  }
  const before = { adminRole: user.adminRole, permissions: user.permissions };
  user.adminRole = adminRole;
  user.permissions = [...new Set(permissions)];
  await user.save();
  await revokeAllUserSessions(user._id, 'admin_access_changed');
  await recordAdminAudit({
    req,
    action: 'admin_access_changed',
    resource: 'user',
    resourceId: user._id,
    before,
    after: { adminRole: user.adminRole, permissions: user.permissions },
  });
  return res.json(user);
});

module.exports = router;
