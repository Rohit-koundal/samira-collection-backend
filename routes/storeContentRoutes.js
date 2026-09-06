const router = require('express').Router();
const content = require('../controllers/storeContentController');
router.get('/', content.get);
router.put('/', content.update);
module.exports = router;
