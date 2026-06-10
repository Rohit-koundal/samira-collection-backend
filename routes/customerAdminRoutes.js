const router = require('express').Router();
const User = require('../models/User');

router.get('/', async (req, res) => {
  const query = String(req.query.search || '').trim();
  const filter = query ? {
    $or: [
      { phone: new RegExp(query, 'i') },
      { name: new RegExp(query, 'i') },
      { email: new RegExp(query, 'i') },
    ],
  } : {};
  res.json(await User.find(filter).select('-password').sort('-createdAt'));
});

router.patch('/:userId/block', async (req, res) => {
  const userId = req.params.userId;
  const customer = await User.findByIdAndUpdate(userId, { isBlocked: req.body.isBlocked }, { new: true }).select('-password');
  if (!customer) return res.status(404).json({ message: 'Customer not found' });
  res.json(customer);
});

router.patch('/:userId/promote-admin', async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.userId, { role: 'admin', availableModes: ['customer', 'admin'], activeMode: 'customer' }, { new: true }).select('-password');
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json(user);
});

router.patch('/:userId/demote-admin', async (req, res) => {
  if (String(req.params.userId) === String(req.user._id)) return res.status(400).json({ message: 'You cannot demote yourself' });
  const user = await User.findByIdAndUpdate(req.params.userId, { role: 'customer', availableModes: ['customer'], activeMode: 'customer' }, { new: true }).select('-password');
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json(user);
});

module.exports = router;
