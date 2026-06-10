const router = require('express').Router();
const auth = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', auth.register);
router.post('/login', auth.login);
router.post('/send-otp', auth.sendOtp);
router.post('/verify-otp', auth.verifyOtp);
router.post('/resend-otp', auth.resendOtp);
router.post('/refresh', auth.refresh);
router.get('/me', protect, auth.me);
router.post('/logout', protect, auth.logout);
router.post('/switch-mode', protect, auth.switchMode);
router.get('/profile', protect, auth.profile);
router.put('/profile', protect, auth.updateProfile);

module.exports = router;
