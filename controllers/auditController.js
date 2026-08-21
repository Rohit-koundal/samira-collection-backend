const AuditLog = require('../models/AuditLog');
const { asyncHandler } = require('../middleware/validate');
const { sendList } = require('../utils/listResponse');

exports.list = asyncHandler(async (req, res) => {
  const filter = { ...(req.tenantFilter || {}) };
  if (req.query.action) filter.action = String(req.query.action);
  if (req.query.entityType) filter.entityType = String(req.query.entityType);
  await sendList(res, req, {
    model: AuditLog,
    filter,
    sort: '-createdAt',
    populate: { path: 'actor', select: 'name email phone' },
    defaultLimit: 50,
    maxLimit: 200,
  });
});
