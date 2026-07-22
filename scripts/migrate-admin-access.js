#!/usr/bin/env node
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User');
const { ADMIN_ROLES, PERMISSIONS } = require('../config/adminPermissions');

const apply = process.argv.includes('--apply');
const ADMIN_ROLE_SET = new Set(ADMIN_ROLES);
const PERMISSION_SET = new Set(PERMISSIONS);

function normalizeAdminAccess(user = {}) {
  const role = ['customer', 'admin', 'owner'].includes(user.role) ? user.role : 'customer';
  const activeMode = ['customer', 'admin'].includes(user.activeMode)
    ? user.activeMode
    : role === 'customer' ? 'customer' : 'admin';

  if (role === 'admin') {
    return {
      role,
      adminRole: ADMIN_ROLE_SET.has(user.adminRole) ? user.adminRole : 'order_manager',
      permissions: uniqueAllowed(user.permissions, PERMISSION_SET),
      availableModes: ['customer', 'admin'],
      activeMode,
    };
  }

  return {
    role,
    adminRole: undefined,
    permissions: [],
    availableModes: role === 'owner' ? ['customer', 'admin'] : ['customer'],
    activeMode: role === 'owner' ? activeMode : 'customer',
  };
}

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    scanned: 0,
    changed: 0,
    adminsDefaulted: 0,
    invalidPermissionsRemoved: 0,
    nonAdminAccessCleared: 0,
  };
  let operations = [];
  const cursor = User.find({})
    .select('role adminRole permissions availableModes activeMode +tokenVersion')
    .lean()
    .cursor();

  for await (const user of cursor) {
    summary.scanned += 1;
    const normalized = normalizeAdminAccess(user);
    if (user.role === 'admin' && !ADMIN_ROLE_SET.has(user.adminRole)) summary.adminsDefaulted += 1;
    summary.invalidPermissionsRemoved += countInvalidPermissions(user.permissions);
    if (user.role !== 'admin' && (user.adminRole || (user.permissions || []).length)) {
      summary.nonAdminAccessCleared += 1;
    }
    if (sameAccess(user, normalized)) continue;

    summary.changed += 1;
    if (apply) {
      operations.push(buildUpdate(user._id, normalized));
      if (operations.length >= 500) {
        await User.bulkWrite(operations, { ordered: false });
        operations = [];
      }
    }
  }
  if (apply && operations.length) await User.bulkWrite(operations, { ordered: false });

  console.log(JSON.stringify(summary, null, 2));
}

function buildUpdate(id, normalized) {
  const update = {
    $set: {
      role: normalized.role,
      permissions: normalized.permissions,
      availableModes: normalized.availableModes,
      activeMode: normalized.activeMode,
    },
    $inc: { tokenVersion: 1 },
  };
  if (normalized.adminRole) update.$set.adminRole = normalized.adminRole;
  else update.$unset = { adminRole: '' };
  return { updateOne: { filter: { _id: id }, update } };
}

function sameAccess(user, normalized) {
  return String(user.role || 'customer') === normalized.role
    && String(user.adminRole || '') === String(normalized.adminRole || '')
    && sameArray(user.permissions, normalized.permissions)
    && sameArray(user.availableModes, normalized.availableModes)
    && String(user.activeMode || '') === normalized.activeMode;
}

function sameArray(left, right) {
  return JSON.stringify(Array.isArray(left) ? left : []) === JSON.stringify(right);
}

function uniqueAllowed(values, allowed) {
  return [...new Set(Array.isArray(values) ? values : [])].filter((value) => allowed.has(value));
}

function countInvalidPermissions(values) {
  return (Array.isArray(values) ? values : []).filter((value) => !PERMISSION_SET.has(value)).length;
}

if (require.main === module) {
  run()
    .then(() => mongoose.disconnect())
    .catch(async (error) => {
      console.error(error.message);
      await mongoose.disconnect().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { normalizeAdminAccess };
