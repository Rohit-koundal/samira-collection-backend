const mongoose = require('mongoose');
const StoreMember = require('../models/StoreMember');
const { roleAllows } = require('../models/StoreMember');
const { ApiError } = require('../utils/apiError');
const { isPlatformAdmin, resolvePublicStore, resolveStoreFromHost } = require('../services/storeService');

function requestedStoreId(req) {
  return String(req.headers['x-store-id'] || req.query.storeId || '').trim();
}

async function optionalResolveStore(req, res, next) {
  try {
    const slug = String(req.headers['x-store-slug'] || req.query.store || '').trim().toLowerCase();
    const resolved = slug
      ? await resolvePublicStore(slug)
      : await resolveStoreFromHost(req.headers['x-forwarded-host'] || req.headers.host);
    req.store = resolved.store;
    req.isDefaultStore = resolved.isDefaultStore;
    req.tenantFilter = resolved.tenantFilter;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Platform admins on /api/admin keep an unscoped view so existing screens
 * and tests continue to see every document, including legacy rows with no
 * storeId. Seller routes always scope to a membership-checked store.
 */
function platformAdminUnscoped(req, res, next) {
  if (isPlatformAdmin(req.user)) {
    req.tenantFilter = {};
    return next();
  }
  return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Admin access required' });
}

async function requireStoreMember(req, res, next) {
  try {
    if (!req.user?._id) throw new ApiError('UNAUTHORIZED', 'Not authorized');

    const headerId = requestedStoreId(req);
    const filter = { user: req.user._id, status: 'ACTIVE' };
    if (headerId) {
      if (!mongoose.Types.ObjectId.isValid(headerId)) {
        throw new ApiError('VALIDATION_ERROR', 'A valid store is required');
      }
      filter.store = headerId;
    }

    let membership = await StoreMember.findOne(filter).populate('store');
    if (!membership && !headerId) {
      membership = await StoreMember.findOne({ user: req.user._id, status: 'ACTIVE' }).populate('store').sort('-createdAt');
    }
    if (!membership?.store) {
      throw new ApiError('FORBIDDEN', 'Seller access required');
    }

    req.storeMember = membership;
    req.store = membership.store;
    req.tenantFilter = { storeId: membership.store._id };
    next();
  } catch (error) {
    next(error);
  }
}

function requireStorePermission(permission) {
  return (req, res, next) => {
    if (!req.storeMember) {
      return next(new ApiError('FORBIDDEN', 'Seller access required'));
    }
    if (!roleAllows(req.storeMember.role, permission)) {
      return next(new ApiError('FORBIDDEN', 'You do not have permission for this action'));
    }
    return next();
  };
}

function stripClientStoreId(req, _res, next) {
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'storeId')) {
    delete req.body.storeId;
  }
  next();
}

function assertStoreOwned(doc, req) {
  if (!req.store?._id || !doc) return doc;
  if (!doc.storeId) return doc;
  if (String(doc.storeId) !== String(req.store._id)) {
    throw new ApiError('FORBIDDEN', 'Not allowed to access another store');
  }
  return doc;
}

module.exports = {
  assertStoreOwned,
  optionalResolveStore,
  platformAdminUnscoped,
  requireStoreMember,
  requireStorePermission,
  stripClientStoreId,
};
