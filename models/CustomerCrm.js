const mongoose = require('mongoose');

const CRM_TAGS = [
  'VIP',
  'Repeat',
  'Repeat Customer',
  'New',
  'New Customer',
  'High RTO',
  'Frequent Return',
  'Instagram',
  'Instagram Customer',
  'WhatsApp Customer',
  'Inactive',
  'At Risk',
  'Wholesale',
];

const customerCrmSchema = new mongoose.Schema({
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tags: [{ type: String, enum: CRM_TAGS }],
  notes: { type: String, maxlength: 2000 },
  acquisition: { type: String, maxlength: 80 },
}, { timestamps: true });

customerCrmSchema.index({ storeId: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('CustomerCrm', customerCrmSchema);
module.exports.CRM_TAGS = CRM_TAGS;
