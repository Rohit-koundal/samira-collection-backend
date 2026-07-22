const router = require('express').Router();
const { listAuditLogs } = require('../controllers/adminAuditController');

router.get('/', listAuditLogs);

module.exports = router;
