const AdminAuditLog = require('../models/AdminAuditLog');

const BLOCKED_KEYS = /password|otp|token|secret|authorization|cookie|signature|credential|card/i;

async function recordAdminAudit({ req, actor, action, resource, resourceId, before, after, metadata }) {
  const actorId = actor?._id || actor || req?.user?._id;
  if (!actorId) return null;
  return AdminAuditLog.create({
    actor: actorId,
    action: String(action).slice(0, 120),
    resource: String(resource).slice(0, 100),
    resourceId: resourceId ? String(resourceId).slice(0, 120) : undefined,
    before: safeSummary(before),
    after: safeSummary(after),
    metadata: safeSummary(metadata),
    ip: String(req?.ip || '').slice(0, 100),
    requestId: String(req?.id || '').slice(0, 100),
  });
}

function safeSummary(value, depth = 0) {
  if (value === undefined || value === null) return value;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => safeSummary(entry, depth + 1));
  if (typeof value === 'object') {
    const source = typeof value.toObject === 'function' ? value.toObject() : value;
    return Object.fromEntries(Object.entries(source)
      .filter(([key]) => !BLOCKED_KEYS.test(key))
      .slice(0, 100)
      .map(([key, child]) => [key, safeSummary(child, depth + 1)]));
  }
  if (typeof value === 'string') return value.slice(0, 1000);
  if (['number', 'boolean'].includes(typeof value)) return value;
  return String(value).slice(0, 200);
}

module.exports = { recordAdminAudit, safeSummary };
