const router = require('express').Router();
const notifications = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, notifications.myNotifications);
router.patch('/:id/read', protect, notifications.markRead);

module.exports = router;
