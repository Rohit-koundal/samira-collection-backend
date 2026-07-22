const router = require('express').Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const { ownerOnly } = require('../middleware/adminMiddleware');
const { revokeAllUserSessions } = require('../services/refreshSessionService');
const { paginationEnvelope, parsePagination } = require('../utils/requestValidation');

router.get('/', async (req, res) => {
  const { page, limit, skip, sort } = parsePagination(req.query, {
    allowedSorts: ['createdAt', 'name', 'email', 'phone'],
  });
  const query = String(req.query.search || '').trim();
  const safeQuery = escapeRegex(query.slice(0, 80));
  const filter = query ? {
    $or: [
      { phone: new RegExp(safeQuery, 'i') },
      { name: new RegExp(safeQuery, 'i') },
      { email: new RegExp(safeQuery, 'i') },
    ],
  } : {};
  const [items, total] = await Promise.all([
    User.find(filter).select('-password').sort(sort).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  res.json(paginationEnvelope(items, total, page, limit));
});

router.patch('/:userId/block', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.userId)) return res.status(400).json({ message: 'Invalid user ID' });
  if (
    !req.body
    || Object.keys(req.body).some((key) => key !== 'isBlocked')
    || typeof req.body.isBlocked !== 'boolean'
  ) {
    return res.status(400).json({ message: 'isBlocked must be a boolean' });
  }
  const userId = req.params.userId;
  const customer = await User.findById(userId);
  if (!customer) return res.status(404).json({ message: 'Customer not found' });
  if (customer.role !== 'customer') return res.status(403).json({ message: 'Only customer accounts can be blocked here' });
  customer.isBlocked = req.body.isBlocked;
  await customer.save();
  if (customer.isBlocked) await revokeAllUserSessions(customer._id, 'account_blocked');
  return res.json(customer);
});

router.patch('/:userId/promote-admin', ownerOnly, changeRole('admin'));
router.patch('/:userId/demote-admin', ownerOnly, changeRole('customer'));

function changeRole(role) {
  return async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.userId)) return res.status(400).json({ message: 'Invalid user ID' });
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role === 'owner') return res.status(403).json({ message: 'Owner accounts cannot be changed here' });
    user.role = role;
    user.availableModes = role === 'admin' ? ['customer', 'admin'] : ['customer'];
    user.activeMode = role === 'admin' ? 'admin' : 'customer';
    await user.save();
    await revokeAllUserSessions(user._id, 'role_changed');
    return res.json(user);
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
