const mongoose = require('mongoose');
const Product = require('../models/Product');
const Settings = require('../models/Settings');
const { getPrimaryImageUrl } = require('../utils/imageUtils');
const { validateCouponForCheckout } = require('./couponService');

async function prepareCheckout(orderItems = [], couponCode, {
  userId,
  paymentMethod = 'COD',
} = {}) {
  const requestedItems = normalizeRequestedItems(orderItems);
  const productIds = [...new Set(requestedItems.map((item) => item.product))];
  const products = await Product.find({ _id: { $in: productIds } });
  const productMap = new Map(products.map((product) => [String(product._id), product]));
  const checkoutLines = new Map();
  const inventoryQuantities = new Map();

  for (const requested of requestedItems) {
    const product = productMap.get(requested.product);
    if (!product || product.isActive === false) throw checkoutError('Product is unavailable', 'PRODUCT_UNAVAILABLE', 404);
    const resolved = resolveVariant(product, requested);
    const inventoryKey = `${requested.product}:${resolved.variantId || 'base'}`;
    const inventoryQuantity = Number(inventoryQuantities.get(inventoryKey) || 0) + requested.quantity;
    if (inventoryQuantity > resolved.stock) {
      throw checkoutError(`${product.name} has only ${resolved.stock} available`, 'INSUFFICIENT_STOCK', 409);
    }
    inventoryQuantities.set(inventoryKey, inventoryQuantity);
    const key = `${requested.product}:${resolved.variantId || 'base'}:${resolved.size}:${resolved.color}`;
    const existing = checkoutLines.get(key);
    const combinedQuantity = Number(existing?.quantity || 0) + requested.quantity;
    if (combinedQuantity > 20) throw checkoutError('Maximum quantity per item is 20', 'QUANTITY_LIMIT');
    checkoutLines.set(key, {
      product: product._id,
      variantId: resolved.variantId,
      sku: resolved.sku,
      name: product.name,
      image: resolved.image || getPrimaryImageUrl(product.images),
      size: resolved.size,
      color: resolved.color,
      quantity: combinedQuantity,
      price: resolved.price,
      originalPrice: resolved.originalPrice,
      categoryId: product.category,
    });
  }

  const settings = await Settings.findOne().lean();
  const linesWithContext = [...checkoutLines.values()];
  const items = linesWithContext.map(({ categoryId, ...item }) => item);
  const sellingTotal = roundMoney(items.reduce((sum, item) => sum + (item.price * item.quantity), 0));
  const totalMRP = roundMoney(items.reduce((sum, item) => sum + (item.originalPrice * item.quantity), 0));
  let couponSnapshot;
  if (couponCode) {
    const validated = await validateCouponForCheckout({
      code: couponCode,
      userId,
      items: linesWithContext.map((item) => ({
        productId: item.product,
        categoryId: item.categoryId,
        unitPrice: item.price,
        quantity: item.quantity,
      })),
      subtotal: sellingTotal,
      paymentMethod,
    });
    couponSnapshot = validated.snapshot;
  }
  const couponDiscount = Number(couponSnapshot?.discountAmount || 0);
  const deliveryCharge = sellingTotal >= Number(settings?.freeShippingMinAmount || 999)
    ? 0 : Number(settings?.deliveryCharge || 99);
  const codCharge = paymentMethod === 'COD' ? Number(settings?.codCharge || 0) : 0;
  if (paymentMethod === 'COD' && settings?.codEnabled === false) {
    throw checkoutError('Cash on delivery is currently unavailable', 'COD_DISABLED', 409);
  }
  if (paymentMethod === 'COD' && settings?.codMaxAmount && sellingTotal > Number(settings.codMaxAmount)) {
    throw checkoutError('This order exceeds the cash on delivery limit', 'COD_LIMIT_EXCEEDED', 409);
  }
  const taxAmount = 0;
  const totals = calculateTotals({
    totalMRP,
    sellingTotal,
    couponDiscount,
    deliveryCharge,
    codCharge,
    taxAmount,
    couponSnapshot,
  });
  return {
    items,
    couponItems: linesWithContext.map((item) => ({
      productId: item.product,
      categoryId: item.categoryId,
      unitPrice: item.price,
      quantity: item.quantity,
    })),
    sellingTotal,
    totals,
  };
}

function calculateTotals({
  totalMRP,
  sellingTotal,
  couponDiscount = 0,
  deliveryCharge = 0,
  codCharge = 0,
  taxAmount = 0,
  couponSnapshot,
}) {
  const safeDiscount = Math.min(Math.max(0, Number(couponDiscount)), Number(sellingTotal));
  const productDiscount = roundMoney(Math.max(0, Number(totalMRP) - Number(sellingTotal)));
  return {
    totalMRP: roundMoney(totalMRP),
    productDiscount,
    couponDiscount: roundMoney(safeDiscount),
    discount: roundMoney(productDiscount + safeDiscount),
    deliveryCharge: roundMoney(deliveryCharge),
    codCharge: roundMoney(codCharge),
    taxAmount: roundMoney(taxAmount),
    finalAmount: roundMoney(Math.max(
      0,
      Number(sellingTotal) - safeDiscount + Number(deliveryCharge) + Number(codCharge) + Number(taxAmount),
    )),
    coupon: couponSnapshot ? {
      couponId: couponSnapshot.couponId,
      code: couponSnapshot.code,
      discountAmount: roundMoney(safeDiscount),
    } : undefined,
  };
}

function applyReservedCoupon(totals, sellingTotal, reservation) {
  return calculateTotals({
    totalMRP: totals.totalMRP,
    sellingTotal,
    couponDiscount: reservation?.discountAmount || 0,
    deliveryCharge: totals.deliveryCharge,
    codCharge: totals.codCharge,
    taxAmount: totals.taxAmount,
    couponSnapshot: reservation,
  });
}

function normalizeRequestedItems(orderItems) {
  if (!Array.isArray(orderItems) || !orderItems.length) {
    throw checkoutError('Order items are required', 'ORDER_ITEMS_REQUIRED');
  }
  if (orderItems.length > 50) throw checkoutError('Too many order lines', 'ORDER_LINE_LIMIT');
  return orderItems.map((item) => {
    const product = String(item?.product || item?.productId || '');
    if (!mongoose.Types.ObjectId.isValid(product)) {
      throw checkoutError('A valid product is required for every order item', 'INVALID_PRODUCT');
    }
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) {
      throw checkoutError('Item quantity must be a whole number between 1 and 20', 'INVALID_QUANTITY');
    }
    return {
      product,
      variantId: item.variantId ? String(item.variantId) : '',
      size: String(item.size || '').trim().slice(0, 80),
      color: String(item.color || '').trim().slice(0, 80),
      quantity,
    };
  });
}

function resolveVariant(product, requested) {
  const variants = Array.isArray(product.variants)
    ? product.variants.filter((variant) => variant.isActive !== false)
    : [];
  if (variants.length) {
    let variant;
    if (requested.variantId) {
      variant = variants.find((entry) => String(entry._id) === requested.variantId);
    } else {
      const matches = variants.filter((entry) => (
        (!requested.size || String(entry.size || '') === requested.size)
        && (!requested.color || String(entry.color || '') === requested.color)
      ));
      if (matches.length === 1) [variant] = matches;
    }
    if (!variant) throw checkoutError('Select an available product variant', 'VARIANT_REQUIRED');
    const price = money(variant.price ?? product.price, 'Variant price is invalid');
    return {
      variantId: String(variant._id),
      sku: variant.sku || product.sku,
      size: String(variant.size || requested.size || ''),
      color: String(variant.color || requested.color || ''),
      stock: nonNegativeStock(variant.stock),
      price,
      originalPrice: money(variant.originalPrice ?? product.originalPrice ?? price, 'Variant original price is invalid'),
      image: variant.images?.[0]?.url,
    };
  }
  if (requested.variantId) throw checkoutError('Selected product variant does not exist', 'VARIANT_NOT_FOUND');
  if (requested.size && product.sizes?.length && !product.sizes.includes(requested.size)) {
    throw checkoutError('Selected size is unavailable', 'SIZE_UNAVAILABLE');
  }
  if (requested.color && product.colors?.length && !product.colors.includes(requested.color)) {
    throw checkoutError('Selected color is unavailable', 'COLOR_UNAVAILABLE');
  }
  const price = money(product.price, 'Product price is invalid');
  return {
    variantId: undefined,
    sku: product.sku,
    size: requested.size,
    color: requested.color,
    stock: nonNegativeStock(product.stock),
    price,
    originalPrice: money(product.originalPrice ?? price, 'Product original price is invalid'),
  };
}

function money(value, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw checkoutError(message, 'INVALID_CATALOG_PRICE', 409);
  return roundMoney(number);
}

function nonNegativeStock(value) {
  const stock = Number(value);
  return Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : 0;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function checkoutError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

module.exports = {
  applyReservedCoupon,
  calculateTotals,
  normalizeRequestedItems,
  prepareCheckout,
  resolveVariant,
};
