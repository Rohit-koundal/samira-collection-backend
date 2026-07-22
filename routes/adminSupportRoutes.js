const router = require('express').Router();
const support = require('../controllers/supportController');

router.get('/', support.listSupportRequests);
router.patch('/:id/status', support.updateSupportRequest);

module.exports = router;
