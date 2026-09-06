const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { masterOnly } = require('../config/masterOwner');
const store = require('../controllers/storeController');
const { protect } = require('../middleware/authMiddleware');
const { requireStoreMember, requireStorePermission, stripClientStoreId } = require('../middleware/storeMiddleware');

const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 8,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/', protect, store.listMine);
router.post('/', protect, masterOnly, createLimiter, stripClientStoreId, store.createStore);
router.get('/resolve', store.resolveHost);
router.get('/me/current', protect, requireStoreMember, store.getMine);
router.put('/me/current', protect, requireStoreMember, requireStorePermission('settings.write'), stripClientStoreId, store.updateMine);
router.post('/me/current/publish', protect, requireStoreMember, requireStorePermission('settings.write'), store.publishMine);
router.get('/:slug', store.getPublic);

module.exports = router;
