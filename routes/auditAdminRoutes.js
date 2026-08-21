const router = require('express').Router();
const audit = require('../controllers/auditController');

router.get('/', audit.list);

module.exports = router;
