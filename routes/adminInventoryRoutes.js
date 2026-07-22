const router = require('express').Router();
const { listInventoryMovements } = require('../controllers/inventoryMovementController');

router.get('/movements', listInventoryMovements);

module.exports = router;
