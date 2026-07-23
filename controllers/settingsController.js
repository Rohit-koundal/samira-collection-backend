const Settings = require('../models/Settings');
exports.getSettings = async (req, res) => res.json((await Settings.findOne()) || await Settings.create({}));
exports.updateSettings = async (req, res) => {
  if (!req.body.storeName) return res.status(400).json({ message: 'Store name is required' });
  if (req.body.contactEmail && !/^\S+@\S+\.\S+$/.test(req.body.contactEmail)) return res.status(400).json({ message: 'Valid email is required' });
  res.json(await Settings.findOneAndUpdate({}, req.body, { new: true, upsert: true }));
};
