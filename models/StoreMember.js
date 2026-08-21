const mongoose = require('mongoose');

const STORE_ROLES = [
  'OWNER',
  'MANAGER',
  'CATALOG_MANAGER',
  'ORDER_MANAGER',
  'SUPPORT',
  'MARKETING',
  'WAREHOUSE',
];

const PERMISSIONS_BY_ROLE = {
  OWNER: ['*'],
  MANAGER: [
    'catalog.read', 'catalog.write',
    'orders.read', 'orders.write',
    'returns.read', 'returns.write',
    'support.read', 'support.write',
    'marketing.read', 'marketing.write',
    'inventory.read', 'inventory.write',
    'crm.read', 'crm.write',
    'inbox.read', 'inbox.write',
    'settings.read', 'settings.write',
    'audit.read',
    'instagram.read', 'instagram.write',
  ],
  CATALOG_MANAGER: ['catalog.read', 'catalog.write', 'inventory.read'],
  ORDER_MANAGER: ['orders.read', 'orders.write', 'returns.read', 'returns.write', 'inventory.read', 'inventory.write'],
  SUPPORT: ['support.read', 'support.write', 'inbox.read', 'inbox.write', 'returns.read', 'returns.write', 'orders.read', 'crm.read'],
  MARKETING: ['marketing.read', 'marketing.write', 'catalog.read', 'crm.read'],
  WAREHOUSE: ['inventory.read', 'inventory.write', 'orders.read'],
};

const storeMemberSchema = new mongoose.Schema({
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, enum: STORE_ROLES, required: true },
  status: { type: String, enum: ['ACTIVE', 'INVITED', 'REVOKED'], default: 'ACTIVE', index: true },
}, { timestamps: true });

storeMemberSchema.index({ store: 1, user: 1 }, { unique: true });
storeMemberSchema.index({ user: 1, status: 1 });

function roleAllows(role, permission) {
  const granted = PERMISSIONS_BY_ROLE[role] || [];
  return granted.includes('*') || granted.includes(permission);
}

module.exports = mongoose.model('StoreMember', storeMemberSchema);
module.exports.STORE_ROLES = STORE_ROLES;
module.exports.PERMISSIONS_BY_ROLE = PERMISSIONS_BY_ROLE;
module.exports.roleAllows = roleAllows;
