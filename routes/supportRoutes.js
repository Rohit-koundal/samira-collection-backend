const router = require('express').Router();
const support = require('../controllers/supportController');
const { rateLimit } = require('../middleware/rateLimitMiddleware');

router.post('/contact', rateLimit({
  scope: 'support_contact',
  limit: 5,
  windowSeconds: 60 * 60,
}), support.createSupportRequest);

module.exports = router;
