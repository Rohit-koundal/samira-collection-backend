const Cart = require('../models/Cart');
const Product = require('../models/Product');
const mongoose = require('mongoose');

exports.getCart = async (req, res, next) => {
  try {
    const cart = await Cart.findOne({ user: req.user._id }).populate('items.product');
    if (!cart) return res.json({ user: req.user._id, items: [], pricingChanges: [] });
    const pricingChanges = [];
    for (const item of cart.items) {
      if (!item.product) continue;
      const resolved = resolveCartVariant(item.product, item);
      if (Number(item.price) !== resolved.price) {
        pricingChanges.push({
          itemId: item._id,
          previousPrice: Number(item.price || 0),
          currentPrice: resolved.price,
        });
        item.price = resolved.price;
      }
    }
    if (pricingChanges.length) await cart.save();
    const payload = cart.toObject();
    payload.pricingChanges = pricingChanges;
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
};
exports.addToCart = async (req, res, next) => {
  try {
  const productId = req.body.product || req.body.productId;
  if (!productId) return res.status(400).json({ message: 'Product is required' });
  if (!mongoose.Types.ObjectId.isValid(productId)) return res.status(400).json({ message: 'Valid product is required' });
  if (Object.prototype.hasOwnProperty.call(req.body, 'price')) {
    return res.status(400).json({ message: 'Cart prices are calculated by the server', code: 'CLIENT_PRICING_NOT_ALLOWED' });
  }

  const product = await Product.findById(productId);
  if (!product || product.isActive === false) return res.status(404).json({ message: 'Product not found' });

  const requestedQuantity = parseQuantity(req.body.quantity ?? 1);
  const size = req.body.size || '';
  const color = req.body.color || '';
  const variantId = req.body.variantId || req.body.selectedVariant || '';
  const resolved = resolveCartVariant(product, { size, color, variantId });
  const stock = resolved.stock;

  let cart = await Cart.findOne({ user: req.user._id });
  if (!cart) cart = await Cart.create({ user: req.user._id, items: [] });

  const item = cart.items.find((entry) => sameCartLine(
    entry,
    productId,
    resolved.size,
    resolved.color,
    resolved.variantId,
  ));
  if (item) {
    const nextQuantity = Number(item.quantity || 0) + requestedQuantity;
    if (nextQuantity > 20) return res.status(400).json({ message: 'Maximum quantity per item is 20' });
    if (stock !== null && nextQuantity > stock) return res.status(400).json({ message: `Only ${stock} item${stock === 1 ? '' : 's'} available in stock` });
    item.quantity = nextQuantity;
    item.price = resolved.price;
  } else {
    if (stock !== null && requestedQuantity > stock) return res.status(400).json({ message: `Only ${stock} item${stock === 1 ? '' : 's'} available in stock` });
    cart.items.push({
      product: productId,
      size: resolved.size,
      color: resolved.color,
      variantId: resolved.variantId,
      quantity: requestedQuantity,
      price: resolved.price,
    });
  }

  await cart.save();
  await cart.populate('items.product');
  return res.status(201).json(cart);
  } catch (error) {
    return next(error);
  }
};
exports.updateCartItem = async (req, res, next) => {
  try {
  if (Object.prototype.hasOwnProperty.call(req.body, 'price')) {
    return res.status(400).json({ message: 'Cart prices are calculated by the server', code: 'CLIENT_PRICING_NOT_ALLOWED' });
  }
  const nextQuantity = Number(req.body.quantity);
  if (!Number.isSafeInteger(nextQuantity) || nextQuantity < 0 || nextQuantity > 20) {
    return res.status(400).json({ message: 'Quantity must be a whole number between 0 and 20' });
  }
  const cart = await Cart.findOne({ user: req.user._id }).populate('items.product');
  if (!cart) return res.status(404).json({ message: 'Cart not found' });
  const item = cart.items.id(req.params.itemId);
  if (!item) return res.status(404).json({ message: 'Cart item not found' });

  if (nextQuantity <= 0) {
    item.deleteOne();
    await cart.save();
    return res.json(cart);
  }

  const resolved = resolveCartVariant(item.product, item);
  const stock = resolved.stock;
  if (stock !== null && nextQuantity > stock) return res.status(400).json({ message: `Only ${stock} item${stock === 1 ? '' : 's'} available in stock` });
  item.quantity = nextQuantity;
  item.price = resolved.price;
  await cart.save();
  return res.json(cart);
  } catch (error) {
    return next(error);
  }
};
exports.removeCartItem = async (req, res) => {
  const cart = await Cart.findOneAndUpdate(
    { user: req.user._id },
    { $pull: { items: { _id: req.params.itemId } } },
    { new: true },
  ).populate('items.product');
  res.json(cart);
};
exports.clearCart = async (req, res) => { await Cart.findOneAndDelete({ user: req.user._id }); res.json({ message: 'Cart cleared' }); };

function sameCartLine(item, productId, size, color, variantId) {
  return String(item.product) === String(productId)
    && String(item.size || '') === String(size || '')
    && String(item.color || '') === String(color || '')
    && String(item.variantId || '') === String(variantId || '');
}

function resolveCartVariant(product = {}, selection = {}) {
  const variants = Array.isArray(product.variants)
    ? product.variants.filter((variant) => variant.isActive !== false)
    : [];
  if (variants.length) {
    let variant;
    if (selection.variantId) {
      variant = variants.find((entry) => String(entry._id) === String(selection.variantId));
    } else {
      const matches = variants.filter((entry) => (
        (!selection.size || String(entry.size || '') === String(selection.size))
        && (!selection.color || String(entry.color || '') === String(selection.color))
      ));
      if (matches.length === 1) [variant] = matches;
    }
    if (!variant) throw cartError('Select an available product variant', 'VARIANT_REQUIRED');
    return {
      variantId: String(variant._id),
      size: String(variant.size || ''),
      color: String(variant.color || ''),
      stock: normalizeStock(variant.stock),
      price: normalizePrice(variant.price ?? product.price),
    };
  }
  if (selection.variantId) throw cartError('Selected product variant is unavailable', 'VARIANT_NOT_FOUND');
  return {
    variantId: '',
    size: String(selection.size || ''),
    color: String(selection.color || ''),
    stock: normalizeStock(product.stock),
    price: normalizePrice(product.price),
  };
}

function parseQuantity(value) {
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) {
    throw cartError('Quantity must be a whole number between 1 and 20', 'INVALID_QUANTITY');
  }
  return quantity;
}

function normalizeStock(value) {
  const stock = Number(value);
  return Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : 0;
}

function normalizePrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) throw cartError('Product price is unavailable', 'INVALID_CATALOG_PRICE', 409);
  return Math.round((price + Number.EPSILON) * 100) / 100;
}

function cartError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
