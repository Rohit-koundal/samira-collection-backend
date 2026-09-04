const router = require('express').Router();
const auth = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/send-otp', auth.sendOtp);
router.post('/verify-otp', auth.verifyOtp);
router.post('/resend-otp', auth.resendOtp);
router.post('/profile/send-phone-change-otp', protect, auth.sendProfilePhoneChangeOtp);
router.post('/profile/verify-phone-change-otp', protect, auth.verifyProfilePhoneChangeOtp);
router.post('/profile/send-email-change-otp', protect, auth.sendProfileEmailChangeOtp);
router.post('/profile/verify-email-change-otp', protect, auth.verifyProfileEmailChangeOtp);
router.post('/refresh', auth.refresh);
router.get('/me', protect, auth.me);
router.post('/logout', protect, auth.logout);
router.post('/switch-mode', protect, auth.switchMode);
router.get('/profile', protect, auth.profile);
router.put('/profile', protect, auth.updateProfile);
router.delete('/profile', protect, auth.deleteProfile);

module.exports = router;
