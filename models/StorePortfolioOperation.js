const mongoose = require('mongoose');

const storePortfolioOperationSchema = new mongoose.Schema({
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: {
    type: String,
    enum: ['ACCESS_GRANT', 'SUBSCRIPTION_UPDATE', 'LIFECYCLE_UPDATE', 'INDUSTRY_CONVERSION', 'INDUSTRY_ROLLBACK', 'OWNER_TRANSFER', 'MEMBER_UPDATE'],
    required: true,
    index: true,
  },
  idempotencyKey: { type: String, trim: true, maxlength: 100 },
  reason: { type: String, trim: true, maxlength: 500, required: true },
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

storePortfolioOperationSchema.index({ store: 1, idempotencyKey: 1 }, {
  unique: true,
  partialFilterExpression: { idempotencyKey: { $type: 'string' } },
});
storePortfolioOperationSchema.index({ store: 1, createdAt: -1 });

module.exports = mongoose.model('StorePortfolioOperation', storePortfolioOperationSchema);
