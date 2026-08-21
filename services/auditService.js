const AuditLog = require('../models/AuditLog');
const { redact } = require('../utils/logger');

function logAudit({ req, action, entityType, entityId, before, after, storeId }) {
  const actor = req?.user?._id;
  const resolvedStore = storeId || req?.store?._id;
  AuditLog.create({
    storeId: resolvedStore || undefined,
    actor,
    action,
    entityType,
    entityId: entityId ? String(entityId) : undefined,
    before: before ? redact(before) : undefined,
    after: after ? redact(after) : undefined,
    requestId: req?.requestId,
    ip: req?.ip,
  }).catch(() => null);
}

module.exports = { logAudit };
