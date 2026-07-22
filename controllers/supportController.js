const crypto = require('crypto');
const SupportRequest = require('../models/SupportRequest');
const { sendSupportNotification } = require('../services/supportNotificationService');
const {
  assertObjectId,
  cleanMultilineText,
  cleanString,
  paginationEnvelope,
  parsePagination,
} = require('../utils/requestValidation');

const STATUS_TRANSITIONS = {
  New: new Set(['In Progress', 'Resolved', 'Closed']),
  'In Progress': new Set(['Resolved', 'Closed']),
  Resolved: new Set(['In Progress', 'Closed']),
  Closed: new Set(),
};

exports.createSupportRequest = async (req, res) => {
  if (String(req.body.website || '').trim()) {
    return res.status(202).json({ message: 'Your request has been received' });
  }
  const name = cleanString(req.body.name, { field: 'name', min: 2, max: 120, required: true });
  const email = normalizeEmail(req.body.email);
  const phone = normalizePhone(req.body.phone);
  if (!email && !phone) return res.status(400).json({ message: 'Email or phone is required' });
  const subject = cleanString(req.body.subject || 'Customer support', { field: 'subject', min: 2, max: 160 });
  const message = cleanMultilineText(req.body.message, { field: 'message', min: 10, max: 5000, required: true });
  const requestFingerprint = hash(`${email}|${phone}|${message.toLowerCase()}`);
  const duplicateSince = new Date(Date.now() - 10 * 60 * 1000);
  const duplicate = await SupportRequest.findOne({ requestFingerprint, createdAt: { $gte: duplicateSince } });
  if (duplicate) {
    return res.status(202).json({ message: 'Your request has been received', ticketId: duplicate._id });
  }
  const ticket = await SupportRequest.create({
    name,
    email,
    phone,
    subject,
    message,
    requestFingerprint,
    requestIpHash: hash(req.ip || ''),
    requestId: req.id,
    auditTrail: [{ action: 'support_request_created', toStatus: 'New' }],
  });
  sendSupportNotification(ticket).catch((error) => {
    req.log?.warn?.({ event: 'support_notification_failed', ticketId: ticket._id, code: error.code });
  });
  return res.status(201).json({
    message: 'Your request has been received',
    ticketId: ticket._id,
    status: ticket.status,
  });
};

exports.listSupportRequests = async (req, res) => {
  const { page, limit, skip, sort } = parsePagination(req.query, {
    allowedSorts: ['createdAt', 'updatedAt', 'status'],
  });
  const filter = {};
  if (req.query.status && STATUS_TRANSITIONS[req.query.status]) filter.status = req.query.status;
  if (req.query.search) {
    const search = escapeRegex(cleanString(req.query.search, { field: 'search', max: 100 }));
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { subject: { $regex: search, $options: 'i' } },
    ];
  }
  const [items, total] = await Promise.all([
    SupportRequest.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    SupportRequest.countDocuments(filter),
  ]);
  return res.json(paginationEnvelope(items, total, page, limit));
};

exports.updateSupportRequest = async (req, res) => {
  assertObjectId(req.params.id, 'support request id');
  const ticket = await SupportRequest.findById(req.params.id).select('+adminNote');
  if (!ticket) return res.status(404).json({ message: 'Support request not found' });
  const nextStatus = cleanString(req.body.status, { field: 'status', min: 3, max: 30, required: true });
  if (!STATUS_TRANSITIONS[ticket.status]?.has(nextStatus)) {
    return res.status(409).json({
      message: `Cannot transition support request from ${ticket.status} to ${nextStatus}`,
      code: 'INVALID_SUPPORT_TRANSITION',
    });
  }
  const note = cleanMultilineText(req.body.adminNote, { field: 'adminNote', max: 2000 });
  const previousStatus = ticket.status;
  ticket.status = nextStatus;
  if (note) ticket.adminNote = note;
  if (req.body.assignedTo) ticket.assignedTo = assertObjectId(req.body.assignedTo, 'assignee id');
  ticket.auditTrail.push({
    actor: req.user._id,
    action: 'support_status_changed',
    fromStatus: previousStatus,
    toStatus: nextStatus,
    note,
  });
  await ticket.save();
  return res.json(ticket);
};

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error('Enter a valid email address');
    error.statusCode = 400;
    throw error;
  }
  return email;
}

function normalizePhone(value) {
  const phone = String(value || '').replace(/[^\d+]/g, '');
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    const error = new Error('Enter a valid phone number');
    error.statusCode = 400;
    throw error;
  }
  return phone.startsWith('+') ? `+${digits}` : digits;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

exports.STATUS_TRANSITIONS = STATUS_TRANSITIONS;
