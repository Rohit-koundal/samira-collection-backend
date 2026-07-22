const AdminAuditLog = require('../models/AdminAuditLog');
const { assertObjectId, paginationEnvelope, parsePagination } = require('../utils/requestValidation');

exports.listAuditLogs = async (req, res) => {
  const { page, limit, skip, sort } = parsePagination(req.query, {
    maxLimit: 100,
    allowedSorts: ['createdAt', 'action', 'resource'],
  });
  const filter = {};
  if (req.query.action) filter.action = String(req.query.action).slice(0, 120);
  if (req.query.resource) filter.resource = String(req.query.resource).slice(0, 100);
  if (req.query.actor) filter.actor = assertObjectId(req.query.actor, 'actor id');
  const [items, total] = await Promise.all([
    AdminAuditLog.find(filter).populate('actor', 'name email phone role adminRole').sort(sort).skip(skip).limit(limit).lean(),
    AdminAuditLog.countDocuments(filter),
  ]);
  return res.json(paginationEnvelope(items, total, page, limit));
};
