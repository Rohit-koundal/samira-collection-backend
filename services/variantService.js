const mongoose = require('mongoose');
const { ApiError } = require('../utils/apiError');
const { getPrimaryImageUrl } = require('../utils/imageUtils');

function activeVariants(product = {}) {
  return (Array.isArray(product.variants) ? product.variants : []).filter((variant) => variant && variant.isActive !== false);
}

function hasManagedVariants(product = {}) {
  return activeVariants(product).length > 0;
}

function variantKey(size = '', color = '') {
  return `${String(size || '').trim().toLowerCase()}::${String(color || '').trim().toLowerCase()}`;
}

function variantId(variant) {
  return variant?._id ? String(variant._id) : '';
}

function findVariant(product, { variantId: id, size, color } = {}) {
  const variants = activeVariants(product);
  if (!variants.length) return null;

  if (id && mongoose.Types.ObjectId.isValid(id)) {
    const match = variants.find((variant) => String(variant._id) === String(id));
    if (match) return match;
  }

  if (size || color) {
    const exact = variants.find((variant) => variantKey(variant.size, variant.color) === variantKey(size, color));
    if (exact) return exact;
  }

  return null;
}

function requireVariant(product, selection = {}) {
  if (!hasManagedVariants(product)) return null;
  const variant = findVariant(product, selection);
  if (!variant) {
    throw new ApiError('VARIANT_UNAVAILABLE', 'Please choose an available size and colour');
  }
  return variant;
}

function variantUnitPrice(product, variant) {
  const price = Number(variant?.price || 0);
  return price > 0 ? price : Number(product.price || 0);
}

function variantUnitMrp(product, variant) {
  const mrp = Number(variant?.originalPrice || 0);
  if (mrp > 0) return mrp;
  return Number(product.originalPrice || variantUnitPrice(product, variant) || 0);
}

function variantImage(product, variant) {
  return getPrimaryImageUrl(variant?.images) || getPrimaryImageUrl(product.images);
}

function variantSku(product, variant) {
  return variant?.sku || product.sku || '';
}

function totalVariantStock(product = {}) {
  return activeVariants(product).reduce((sum, variant) => sum + Math.max(0, Number(variant.stock || 0)), 0);
}

function availableStock(product = {}, selection = {}) {
  if (!hasManagedVariants(product)) {
    return Math.max(0, Number(product.stock || 0));
  }
  const variant = findVariant(product, selection);
  if (!variant) return 0;
  return Math.max(0, Number(variant.stock || 0));
}

function normalizeVariantInput(raw = {}, product = {}) {
  const size = String(raw.size || '').trim();
  const color = String(raw.color || '').trim();
  const stock = Math.max(0, Number(raw.stock || 0));
  const price = Number(raw.price || 0);
  const originalPrice = Number(raw.originalPrice || 0);
  return {
    ...(raw._id && mongoose.Types.ObjectId.isValid(raw._id) ? { _id: raw._id } : {}),
    sku: String(raw.sku || '').trim() || undefined,
    size,
    color,
    stock,
    price: price > 0 ? price : undefined,
    originalPrice: originalPrice > 0 ? originalPrice : undefined,
    images: Array.isArray(raw.images) ? raw.images : [],
    isActive: raw.isActive !== false,
  };
}

function normalizeVariantsPayload(variants, product = {}) {
  if (!Array.isArray(variants)) return undefined;
  return variants
    .map((variant) => normalizeVariantInput(variant, product))
    .filter((variant) => variant.size || variant.color);
}

module.exports = {
  activeVariants,
  availableStock,
  findVariant,
  hasManagedVariants,
  normalizeVariantsPayload,
  requireVariant,
  totalVariantStock,
  variantId,
  variantImage,
  variantKey,
  variantSku,
  variantUnitMrp,
  variantUnitPrice,
};
