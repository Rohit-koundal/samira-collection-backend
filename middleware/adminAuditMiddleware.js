const { recordAdminAudit } = require('../services/adminAuditService');

function auditAdminMutations(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  res.on('finish', () => {
    if (res.statusCode >= 400 || !['admin', 'owner'].includes(req.user?.role)) return;
    const parts = String(req.originalUrl || '').split('?')[0].split('/').filter(Boolean);
    const adminIndex = parts.indexOf('admin');
    const resource = parts[adminIndex + 1] || 'admin';
    const resourceId = parts[adminIndex + 2];
    recordAdminAudit({
      req,
      action: `${req.method.toLowerCase()}_${resource}`,
      resource,
      resourceId,
      metadata: { status: res.statusCode },
    }).catch((error) => req.log?.error?.({ event: 'admin_audit_failed', code: error.code }));
  });
  next();
}

module.exports = { auditAdminMutations };
