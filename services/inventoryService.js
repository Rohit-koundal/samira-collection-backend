const mongoose = require('mongoose');
const Product = require('../models/Product');
const InventoryTransaction = require('../models/InventoryTransaction');
const { ApiError } = require('../utils/apiError');
const { hasManagedVariants, totalVariantStock, variantId } = require('./variantService');

function itemQuantity(item) {
  return Math.max(1, Number(item.quantity || 1));
}

function itemProductId(item) {
  return item.product?._id || item.product || item.productId;
}

function itemVariantId(item) {
  return item.variantId ? String(item.variantId) : '';
}

function stockAfterFromProduct(product, selection = {}) {
  if (!hasManagedVariants(product)) return Number(product?.stock || 0);
  const match = (product.variants || []).find((variant) => String(variant._id) === String(selection.variantId || ''));
  return Number(match?.stock || 0);
}

async function deductVariant(productId, variantObjectId, quantity, session, { allowShortfall = false } = {}) {
  const updated = await Product.findOneAndUpdate(
    {
      _id: productId,
      variants: { $elemMatch: { _id: variantObjectId, isActive: { $ne: false }, stock: { $gte: quantity } } },
    },
    { $inc: { 'variants.$.stock': -quantity, stock: -quantity } },
    { new: true, session },
  ).select('name stock sku variants');

  if (updated) {
    return {
      productId,
      quantity,
      stockAfter: stockAfterFromProduct(updated, { variantId: variantObjectId }),
      sku: updated.sku,
      shortfall: 0,
      variantId: String(variantObjectId),
    };
  }

  const product = await Product.findById(productId).select('name stock sku variants').session(session || null);
  const current = stockAfterFromProduct(product, { variantId: variantObjectId });
  const available = Math.max(0, current);

  if (!allowShortfall) {
    throw new ApiError(
      'OUT_OF_STOCK',
      product
        ? `${product.name} has only ${available} left for that size and colour`
        : 'That size and colour is no longer available',
      { details: { productId: String(productId), variantId: String(variantObjectId), available } },
    );
  }

  if (!product || available <= 0) {
    return { productId, quantity: 0, stockAfter: 0, shortfall: quantity, variantId: String(variantObjectId), sku: product?.sku };
  }

  const taken = Math.min(quantity, available);
  const clamped = await Product.findOneAndUpdate(
    {
      _id: productId,
      variants: { $elemMatch: { _id: variantObjectId, stock: { $gte: taken } } },
    },
    { $inc: { 'variants.$.stock': -taken, stock: -taken } },
    { new: true, session },
  ).select('stock sku variants');

  return {
    productId,
    quantity: taken,
    stockAfter: stockAfterFromProduct(clamped || product, { variantId: variantObjectId }),
    sku: product.sku,
    shortfall: quantity - taken,
    variantId: String(variantObjectId),
  };
}

async function deductProductLevel(productId, quantity, session, { allowShortfall = false } = {}) {
  const updated = await Product.findOneAndUpdate(
    { _id: productId, stock: { $gte: quantity } },
    { $inc: { stock: -quantity } },
    { new: true, session },
  ).select('name stock sku');

  if (updated) {
    return { productId, quantity, stockAfter: updated.stock, sku: updated.sku, shortfall: 0 };
  }

  const product = await Product.findById(productId).select('name stock sku').session(session || null);
  const available = Math.max(0, Number(product?.stock || 0));

  if (!allowShortfall) {
    throw new ApiError(
      'OUT_OF_STOCK',
      product
        ? `${product.name} has only ${available} left in stock`
        : 'A product is no longer available',
      { details: { productId: String(productId), available } },
    );
  }

  if (!product) return { productId, quantity: 0, stockAfter: 0, shortfall: quantity };
  const taken = Math.min(quantity, available);
  const clamped = taken > 0
    ? await Product.findOneAndUpdate(
      { _id: productId, stock: { $gte: taken } },
      { $inc: { stock: -taken } },
      { new: true, session },
    ).select('stock sku')
    : product;

  return {
    productId,
    quantity: taken,
    stockAfter: Math.max(0, Number(clamped?.stock ?? available)),
    sku: product.sku,
    shortfall: quantity - taken,
  };
}

async function deductOne(item, session, { allowShortfall = false } = {}) {
  const productId = itemProductId(item);
  const quantity = itemQuantity(item);
  const selectedVariantId = itemVariantId(item);

  if (selectedVariantId && mongoose.Types.ObjectId.isValid(selectedVariantId)) {
    return deductVariant(productId, selectedVariantId, quantity, session, { allowShortfall });
  }

  const product = await Product.findById(productId).select('name stock sku variants').session(session || null);
  if (hasManagedVariants(product)) {
    throw new ApiError('VARIANT_UNAVAILABLE', `${product.name} requires a size and colour selection`);
  }

  return deductProductLevel(productId, quantity, session, { allowShortfall });
}

async function restoreOne(item, session) {
  const productId = itemProductId(item);
  const quantity = itemQuantity(item);
  const selectedVariantId = itemVariantId(item);

  if (selectedVariantId && mongoose.Types.ObjectId.isValid(selectedVariantId)) {
    const updated = await Product.findOneAndUpdate(
      { _id: productId, 'variants._id': selectedVariantId },
      { $inc: { 'variants.$.stock': quantity, stock: quantity } },
      { new: true, session },
    ).select('stock sku variants');
    if (!updated) return null;
    return {
      productId,
      quantity,
      stockAfter: stockAfterFromProduct(updated, { variantId: selectedVariantId }),
      sku: updated.sku,
      variantId: selectedVariantId,
    };
  }

  const updated = await Product.findByIdAndUpdate(
    productId,
    { $inc: { stock: quantity } },
    { new: true, session },
  ).select('stock sku');

  if (!updated) return null;
  return { productId, quantity, stockAfter: updated.stock, sku: updated.sku };
}

async function recordTransactions(entries, { orderId, type, reason, userId, session }) {
  const movements = entries.filter((entry) => entry.quantity > 0);
  if (!movements.length) return;
  const productIds = [...new Set(movements.map((entry) => entry.productId).filter(Boolean))];
  const products = await Product.find({ _id: { $in: productIds } }).select('storeId').session(session || null).lean();
  const storeByProduct = new Map(products.map((product) => [String(product._id), product.storeId]));
  const docs = movements.map((entry) => ({
    storeId: storeByProduct.get(String(entry.productId)) || undefined,
    product: entry.productId,
    variantId: entry.variantId || '',
    sku: entry.sku,
    order: orderId,
    type,
    quantity: type === 'SALE' ? -entry.quantity : entry.quantity,
    stockBefore: type === 'SALE' ? entry.stockAfter + entry.quantity : entry.stockAfter - entry.quantity,
    stockAfter: entry.stockAfter,
    reason,
    createdBy: userId,
  }));
  await InventoryTransaction.insertMany(docs, session ? { session } : {});
}

async function deductStockForOrder(items, { orderId, userId, reason = 'Order placed', session, allowShortfall = false } = {}) {
  const applied = [];

  try {
    for (const item of items) {
      const entry = await deductOne(item, session, { allowShortfall });
      applied.push({ ...entry, variantId: entry.variantId || item.variantId || '' });
    }
  } catch (error) {
    if (!session) {
      for (const entry of applied) {
        if (entry.quantity <= 0) continue;
        await restoreOne({ product: entry.productId, quantity: entry.quantity, variantId: entry.variantId }, null).catch(() => null);
      }
    }
    throw error;
  }

  await recordTransactions(applied, { orderId, type: 'SALE', reason, userId, session });
  return applied;
}

async function restoreStockForOrder(items, { orderId, userId, type = 'CANCELLATION', reason = 'Order cancelled', session } = {}) {
  const applied = [];
  for (const item of items) {
    const entry = await restoreOne(item, session);
    if (entry) applied.push({ ...entry, variantId: entry.variantId || item.variantId || '' });
  }
  await recordTransactions(applied, { orderId, type, reason, userId, session });
  return applied;
}

async function claimInventoryRestore(OrderModel, orderId, session) {
  return OrderModel.findOneAndUpdate(
    { _id: orderId, inventoryDeducted: true, inventoryRestored: { $ne: true } },
    { $set: { inventoryRestored: true, inventoryRestoredAt: new Date() } },
    { new: true, session },
  );
}

async function claimInventoryDeduction(OrderModel, orderId, session) {
  const first = await OrderModel.findOneAndUpdate(
    { _id: orderId, inventoryDeducted: { $ne: true } },
    { $set: { inventoryDeducted: true, inventoryDeductedAt: new Date() } },
    { new: true, session },
  );
  if (first) return first;

  return OrderModel.findOneAndUpdate(
    { _id: orderId, inventoryDeducted: true, inventoryRestored: true },
    { $set: { inventoryRestored: false, inventoryDeductedAt: new Date() } },
    { new: true, session },
  );
}

async function syncProductStock(product) {
  if (!product || !hasManagedVariants(product)) return product;
  product.stock = totalVariantStock(product);
  return product.save();
}

module.exports = {
  claimInventoryDeduction,
  claimInventoryRestore,
  deductOne,
  deductStockForOrder,
  restoreOne,
  restoreStockForOrder,
  syncProductStock,
  variantId,
};
