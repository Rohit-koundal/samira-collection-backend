const Notification = require('../models/Notification');
const { asyncHandler } = require('../middleware/validate');
const { notFound } = require('../utils/apiError');
const { readPagination, requireObjectId } = require('../utils/validators');

exports.myNotifications = asyncHandler(async (req, res) => {
  const { limit, skip } = readPagination(req.query, { defaultLimit: 50, maxLimit: 100 });
  res.json(await Notification.find({ user: req.user._id, channel: 'IN_APP' }).sort('-createdAt').skip(skip).limit(limit));
});

exports.markRead = asyncHandler(async (req, res) => {
  requireObjectId(req.params.id, 'notification id');
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { readAt: new Date() },
    { new: true },
  );
  if (!notification) throw notFound('Notification not found');
  res.json(notification);
});
