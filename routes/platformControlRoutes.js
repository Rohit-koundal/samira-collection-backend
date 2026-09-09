const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/clientPlatformController');

const validateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 'RATE_LIMITED', message: 'Too many installation requests. Please retry shortly.' },
});
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 'RATE_LIMITED', message: 'Too many payment attempts. Please wait before retrying.' },
});

router.post('/validate', validateLimiter, controller.validate);
router.post('/subscription/checkout', paymentLimiter, controller.checkout);
router.post('/subscription/verify', paymentLimiter, controller.verify);

module.exports = router;
