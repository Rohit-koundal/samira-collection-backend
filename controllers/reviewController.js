const Review = require('../models/Review');
exports.createReview = async (req, res) => res.status(201).json(await Review.create({ ...req.body, user: req.user._id, product: req.params.productId }));
exports.getReviews = async (req, res) => res.json(await Review.find({ product: req.params.productId, isVisible: true }).populate('user', 'name'));
exports.adminReviews = async (req, res) => res.json(await Review.find().populate('user product'));
exports.toggleVisibility = async (req, res) => res.json(await Review.findByIdAndUpdate(req.params.id, { isVisible: req.body.isVisible }, { new: true }));
exports.deleteReview = async (req, res) => { await Review.findByIdAndDelete(req.params.id); res.json({ message: 'Review deleted' }); };
