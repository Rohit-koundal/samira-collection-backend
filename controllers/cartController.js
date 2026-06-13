const Cart = require('../models/Cart');
const Product = require('../models/Product');
const mongoose = require('mongoose');

exports.getCart = async (req, res) => res.json(await Cart.findOne({ user: req.user._id }).populate('items.product'));
exports.addToCart = async (req, res) => {
  const productId = req.body.product || req.body.productId;
  if (!productId) return res.status(400).json({ message: 'Product is required' });
  if (!mongoose.Types.ObjectId.isValid(productId)) return res.status(400).json({ message: 'Valid product is required' });

  const product = await Product.findById(productId);
  if (!product) return res.status(404).json({ message: 'Product not found' });

  const requestedQuantity = Math.max(1, Number(req.body.quantity || 1));
  const size = req.body.size || '';
  const color = req.body.color || '';
  const variantId = req.body.variantId || req.body.selectedVariant || '';
  const stock = getAvailableStock(product);

  let cart = await Cart.findOne({ user: req.user._id });
  if (!cart) cart = await Cart.create({ user: req.user._id, items: [] });

  const item = cart.items.find((entry) => sameCartLine(entry, productId, size, color, variantId));
  if (item) {
    const nextQuantity = Number(item.quantity || 0) + requestedQuantity;
    if (stock !== null && nextQuantity > stock) return res.status(400).json({ message: `Only ${stock} item${stock === 1 ? '' : 's'} available in stock` });
    item.quantity = nextQuantity;
    item.price = Number(req.body.price ?? product.price);
  } else {
    if (stock !== null && requestedQuantity > stock) return res.status(400).json({ message: `Only ${stock} item${stock === 1 ? '' : 's'} available in stock` });
    cart.items.push({
      product: productId,
      size,
      color,
      variantId,
      quantity: requestedQuantity,
      price: Number(req.body.price ?? product.price),
    });
  }

  await cart.save();
  await cart.populate('items.product');
  res.status(201).json(cart);
};
exports.updateCartItem = async (req, res) => {
  const nextQuantity = Number(req.body.quantity || 0);
  const cart = await Cart.findOne({ user: req.user._id }).populate('items.product');
  if (!cart) return res.status(404).json({ message: 'Cart not found' });
  const item = cart.items.id(req.params.itemId);
  if (!item) return res.status(404).json({ message: 'Cart item not found' });

  if (nextQuantity <= 0) {
    item.deleteOne();
    await cart.save();
    return res.json(cart);
  }

  const stock = getAvailableStock(item.product);
  if (stock !== null && nextQuantity > stock) return res.status(400).json({ message: `Only ${stock} item${stock === 1 ? '' : 's'} available in stock` });
  item.quantity = nextQuantity;
  await cart.save();
  res.json(cart);
};
exports.removeCartItem = async (req, res) => res.json(await Cart.findOneAndUpdate({ user: req.user._id }, { $pull: { items: { _id: req.params.itemId } } }, { new: true }));
exports.clearCart = async (req, res) => { await Cart.findOneAndDelete({ user: req.user._id }); res.json({ message: 'Cart cleared' }); };

function sameCartLine(item, productId, size, color, variantId) {
  return String(item.product) === String(productId)
    && String(item.size || '') === String(size || '')
    && String(item.color || '') === String(color || '')
    && String(item.variantId || '') === String(variantId || '');
}

function getAvailableStock(product = {}) {
  if (product.stock === undefined || product.stock === null || product.stock === '') return null;
  const stock = Number(product.stock);
  return Number.isFinite(stock) ? Math.max(0, stock) : null;
}
