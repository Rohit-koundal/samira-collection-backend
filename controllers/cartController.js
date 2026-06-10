const Cart = require('../models/Cart');

exports.getCart = async (req, res) => res.json(await Cart.findOne({ user: req.user._id }).populate('items.product'));
exports.addToCart = async (req, res) => {
  const cart = await Cart.findOneAndUpdate({ user: req.user._id }, { $push: { items: req.body } }, { new: true, upsert: true });
  res.status(201).json(cart);
};
exports.updateCartItem = async (req, res) => {
  const cart = await Cart.findOneAndUpdate({ user: req.user._id, 'items._id': req.params.itemId }, { $set: { 'items.$.quantity': req.body.quantity } }, { new: true });
  res.json(cart);
};
exports.removeCartItem = async (req, res) => res.json(await Cart.findOneAndUpdate({ user: req.user._id }, { $pull: { items: { _id: req.params.itemId } } }, { new: true }));
exports.clearCart = async (req, res) => { await Cart.findOneAndDelete({ user: req.user._id }); res.json({ message: 'Cart cleared' }); };
