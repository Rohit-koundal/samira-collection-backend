const { normalizePhone } = require('../utils/phoneUtils');
const { ApiError } = require('../utils/apiError');

// Deployment-owned identity, not an editable store setting or a secret.
const MASTER_OWNER_PHONE = '9816978086';
const isOwnerPhone = (phone) => normalizePhone(phone) === MASTER_OWNER_PHONE;
const isOwnerAccount = (user) => Boolean(user && isOwnerPhone(user.phone));
function isMasterOwner(user) {
  return Boolean(isOwnerAccount(user) && user.systemRole === 'MASTER_OWNER' &&
    user.role === 'admin' && user.activeMode === 'admin' && user.isPhoneVerified &&
    !user.isBlocked && !user.offlineSession && user.$locals?.masterAuthenticated === true);
}
function attachMasterSession(user, claims = {}) {
  if (!user) return user;
  user.$locals = user.$locals || {};
  user.$locals.masterAuthenticated = Boolean(isOwnerAccount(user) && user.systemRole === 'MASTER_OWNER' &&
    user.isPhoneVerified && !user.isBlocked && !user.offlineSession &&
    user.masterSessionVersion && claims.masterSessionVersion === user.masterSessionVersion);
  return user;
}
function assertMasterOwner(user) {
  if (!isMasterOwner(user)) throw new ApiError('FORBIDDEN', 'Master Owner permission required');
}
function masterOnly(req, res, next) {
  try { assertMasterOwner(req.user); return next(); } catch (error) { return next(error); }
}
module.exports = { MASTER_OWNER_PHONE, isOwnerPhone, isOwnerAccount, isMasterOwner, attachMasterSession, assertMasterOwner, masterOnly };
