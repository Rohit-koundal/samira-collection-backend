const ADMIN_ROLES = [
  'catalog_manager',
  'order_manager',
  'customer_support_manager',
  'marketing_manager',
  'inventory_manager',
];

const PERMISSIONS = [
  'manage_catalog',
  'manage_inventory',
  'manage_orders',
  'manage_customers',
  'manage_support',
  'manage_marketing',
  'manage_settings',
  'refund_payments',
  'delete_media',
  'export_customer_data',
  'view_financial_reports',
  'view_audit_logs',
];

const ROLE_PERMISSIONS = {
  catalog_manager: ['manage_catalog'],
  order_manager: ['manage_orders'],
  customer_support_manager: ['manage_customers', 'manage_support'],
  marketing_manager: ['manage_marketing'],
  inventory_manager: ['manage_inventory', 'manage_catalog'],
};

function effectivePermissions(user) {
  if (user?.role === 'owner') return new Set(PERMISSIONS);
  if (user?.role !== 'admin') return new Set();
  return new Set([
    ...(ROLE_PERMISSIONS[user.adminRole] || []),
    ...(Array.isArray(user.permissions) ? user.permissions : []),
  ].filter((permission) => PERMISSIONS.includes(permission)));
}

module.exports = { ADMIN_ROLES, PERMISSIONS, ROLE_PERMISSIONS, effectivePermissions };
