const ReturnExchange = require('../models/ReturnExchange');
exports.createReturn = async (req, res) => res.status(201).json(await ReturnExchange.create({ ...req.body, user: req.user._id }));
exports.myReturns = async (req, res) => res.json(await ReturnExchange.find({ user: req.user._id }));
exports.adminReturns = async (req, res) => res.json(await ReturnExchange.find().populate('user order product'));
exports.updateReturnStatus = async (req, res) => res.json(await ReturnExchange.findByIdAndUpdate(req.params.id, req.body, { new: true }));
