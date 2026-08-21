const Cart = require('../models/Cart');
const Product = require('../models/Product');
const mongoose = require('mongoose');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, notFound } = require('../utils/apiError');
const { availableStock, hasManagedVariants, requireVariant, variantId, variantUnitPrice } = require('../services/variantService');

function readSessionId(req) {
  const raw = String(req.headers['x-session-id'] || '').trim();
  if (raw.length < 8 || raw.length > 120) return '';
  return raw;
}

function requireCartIdentity(req) {
  if (req.user?._id || readSessionId(req)) return;
  throw new ApiError('UNAUTHORIZED', 'Sign in or keep a shopping session to update your cart');
}

async function mergeSessionCartIntoUser(userId, sessionId) {
  if (!userId || !sessionId) return;
  const guest = await Cart.findOne({ sessionId });
  if (!guest) return;
  if (guest.user && String(guest.user) === String(userId)) {
    guest.sessionId = undefined;
    await guest.save();
    return;
  }
  if (guest.user && String(guest.user) !== String(userId)) return;

  let userCart = await Cart.findOne({ user: userId });
  if (!userCart) {
    guest.user = userId;
    guest.sessionId = undefined;
    await guest.save();
    return;
  }

  for (const line of guest.items || []) {
    const existing = userCart.items.find((entry) => sameCartLine(
      entry,
      line.product,
      line.size,
      line.color,
      line.variantId,
    ));
    if (existing) {
      existing.quantity = Number(existing.quantity || 0) + Number(line.quantity || 0);
      if (line.price != null) existing.price = line.price;
    } else {
      userCart.items.push({
        product: line.product,
        size: line.size,
        color: line.color,
        variantId: line.variantId,
        quantity: line.quantity,
        price: line.price,
      });
    }
  }

  await userCart.save();
  await guest.deleteOne();
}

async function findCart(req, { create = false } = {}) {
  const userId = req.user?._id;
  const sessionId = readSessionId(req);

  if (userId) {
    await mergeSessionCartIntoUser(userId, sessionId);
    let cart = await Cart.findOne({ user: userId });
    if (!cart && create) cart = await Cart.create({ user: userId, items: [] });
    return cart;
  }

  if (sessionId) {
    let cart = await Cart.findOne({ sessionId });
    if (!cart && create) cart = await Cart.create({ sessionId, items: [] });
    return cart;
  }

  return null;
}

exports.getCart = asyncHandler(async (req, res) => {
  const cart = await findCart(req);
  if (!cart) return res.json({ items: [] });
  await cart.populate('items.product');
  res.json(cart);
});

exports.addToCart = asyncHandler(async (req, res) => {
  requireCartIdentity(req);
  const productId = req.body.product || req.body.productId;
  if (!productId) throw new ApiError('VALIDATION_ERROR', 'Product is required');
  if (!mongoose.Types.ObjectId.isValid(productId)) throw new ApiError('VALIDATION_ERROR', 'Valid product is required');

  const product = await Product.findById(productId);
  if (!product) throw notFound('Product not found');
  if (product.isActive === false || product.isArchived) {
    throw new ApiError('NOT_FOUND', 'This product is no longer available');
  }

  const requestedQuantity = Math.max(1, Number(req.body.quantity || 1));
  const size = req.body.size || '';
  const color = req.body.color || '';
  const variant = hasManagedVariants(product)
    ? requireVariant(product, { variantId: req.body.variantId || req.body.selectedVariant, size, color })
    : null;
  const resolvedVariantId = variant ? variantId(variant) : (req.body.variantId || req.body.selectedVariant || '');
  const stock = availableStock(product, { variantId: resolvedVariantId, size: variant?.size || size, color: variant?.color || color });
  const unitPrice = variant ? variantUnitPrice(product, variant) : Number(product.price);

  const cart = await findCart(req, { create: true });

  const item = cart.items.find((entry) => sameCartLine(entry, productId, variant?.size || size, variant?.color || color, resolvedVariantId));
  if (item) {
    const nextQuantity = Number(item.quantity || 0) + requestedQuantity;
    if (nextQuantity > stock) {
      throw new ApiError('OUT_OF_STOCK', `Only ${stock} item${stock === 1 ? '' : 's'} available in stock`, { details: { available: stock } });
    }
    item.quantity = nextQuantity;
    item.price = unitPrice;
    item.variantId = resolvedVariantId;
  } else {
    if (requestedQuantity > stock) {
      throw new ApiError('OUT_OF_STOCK', `Only ${stock} item${stock === 1 ? '' : 's'} available in stock`, { details: { available: stock } });
    }
    cart.items.push({
      product: productId,
      size: variant?.size || size,
      color: variant?.color || color,
      variantId: resolvedVariantId,
      quantity: requestedQuantity,
      price: unitPrice,
    });
  }

  await cart.save();
  await cart.populate('items.product');
  res.status(201).json(cart);
});

exports.updateCartItem = asyncHandler(async (req, res) => {
  requireCartIdentity(req);
  const nextQuantity = Number(req.body.quantity || 0);
  const cart = await findCart(req);
  if (!cart) throw notFound('Cart not found');
  await cart.populate('items.product');
  const item = cart.items.id(req.params.itemId);
  if (!item) throw notFound('Cart item not found');

  if (nextQuantity <= 0) {
    item.deleteOne();
    await cart.save();
    return res.json(cart);
  }

  const product = item.product;
  const stock = availableStock(product, { variantId: item.variantId, size: item.size, color: item.color });
  if (nextQuantity > stock) {
    throw new ApiError('OUT_OF_STOCK', `Only ${stock} item${stock === 1 ? '' : 's'} available in stock`, { details: { available: stock } });
  }
  item.quantity = nextQuantity;
  await cart.save();
  res.json(cart);
});

exports.removeCartItem = asyncHandler(async (req, res) => {
  requireCartIdentity(req);
  const cart = await findCart(req);
  if (!cart) return res.json({ items: [] });
  cart.items.pull({ _id: req.params.itemId });
  await cart.save();
  await cart.populate('items.product');
  res.json(cart);
});

exports.clearCart = asyncHandler(async (req, res) => {
  requireCartIdentity(req);
  const userId = req.user?._id;
  const sessionId = readSessionId(req);
  if (userId) await Cart.findOneAndDelete({ user: userId });
  else if (sessionId) await Cart.findOneAndDelete({ sessionId });
  res.json({ message: 'Cart cleared' });
});

function sameCartLine(item, productId, size, color, variantIdValue) {
  return String(item.product) === String(productId)
    && String(item.size || '') === String(size || '')
    && String(item.color || '') === String(color || '')
    && String(item.variantId || '') === String(variantIdValue || '');
}
