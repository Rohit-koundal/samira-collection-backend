const InventoryTransaction = require('../models/InventoryTransaction');
const { asyncHandler } = require('../middleware/validate');
const { andFilter } = require('../services/storeService');
const { buildPaginatedResponse, readPagination, requireEnum, requireObjectId } = require('../utils/validators');

const TYPES = ['SALE', 'CANCELLATION', 'RETURN', 'MANUAL_ADJUSTMENT', 'RESTOCK', 'IMPORT'];

exports.history = asyncHandler(async (req, res) => {
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: 50, maxLimit: 100 });
  const filter = {};
  if (req.query.product) filter.product = requireObjectId(req.query.product, 'product id');
  if (req.query.type) filter.type = requireEnum(req.query.type, TYPES, 'inventory movement');
  if (req.query.from || req.query.to) {
    const from = req.query.from ? new Date(req.query.from) : new Date(0);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
      const { ApiError } = require('../utils/apiError');
      throw new ApiError('VALIDATION_ERROR', 'Choose a valid inventory history date range');
    }
    to.setHours(23, 59, 59, 999);
    filter.createdAt = { $gte: from, $lte: to };
  }
  const scoped = andFilter(filter, req.tenantFilter);
  const [items, total] = await Promise.all([
    InventoryTransaction.find(scoped).populate('product', 'name sku').populate('createdBy', 'name').sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    InventoryTransaction.countDocuments(scoped),
  ]);
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json(buildPaginatedResponse(items, { page, limit, total }));
});

exports.TYPES = TYPES;
