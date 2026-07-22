const InventoryMovement = require('../models/InventoryMovement');
const {
  assertObjectId,
  cleanString,
  paginationEnvelope,
  parsePagination,
} = require('../utils/requestValidation');

const MOVEMENT_TYPES = new Set([
  'RESERVATION',
  'RESERVATION_RELEASE',
  'SALE_COMMIT',
  'CANCELLATION_RESTORE',
  'RETURN_RESTORE',
]);

exports.listInventoryMovements = async (req, res) => {
  const { page, limit, skip, sort } = parsePagination(req.query, {
    maxLimit: 100,
    allowedSorts: ['createdAt', 'movementType', 'quantity'],
  });
  const filter = {};
  if (req.query.product) filter.product = assertObjectId(req.query.product, 'product id');
  if (req.query.order) filter.order = assertObjectId(req.query.order, 'order id');
  if (req.query.variantId) {
    filter.variantId = cleanString(req.query.variantId, { field: 'variant id', min: 1, max: 120, required: true });
  }
  if (req.query.movementType) {
    const movementType = String(req.query.movementType).toUpperCase();
    if (!MOVEMENT_TYPES.has(movementType)) {
      const error = new Error('Invalid inventory movement type');
      error.statusCode = 400;
      error.code = 'INVALID_MOVEMENT_TYPE';
      throw error;
    }
    filter.movementType = movementType;
  }

  const [items, total] = await Promise.all([
    InventoryMovement.find(filter)
      .populate('product', 'name slug sku')
      .populate('actor', 'name email role adminRole')
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    InventoryMovement.countDocuments(filter),
  ]);
  return res.json(paginationEnvelope(items, total, page, limit));
};
