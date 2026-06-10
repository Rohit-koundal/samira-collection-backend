const Banner = require('../models/Banner');
exports.getBanners = async (req, res) => {
  const query = req.query.admin === 'true' ? {} : { isActive: true };
  res.json(await Banner.find(query).sort('displayOrder'));
};
exports.createBanner = async (req, res) => {
  if (!req.body.title) return res.status(400).json({ message: 'Banner title is required' });
  if (!req.body.image) return res.status(400).json({ message: 'Banner image is required' });
  if (req.body.image?.startsWith('data:')) return res.status(400).json({ message: 'Banner image must be an uploaded file URL' });
  res.status(201).json(await Banner.create(req.body));
};
exports.updateBanner = async (req, res) => {
  if (req.body.image?.startsWith('data:')) return res.status(400).json({ message: 'Banner image must be an uploaded file URL' });
  res.json(await Banner.findByIdAndUpdate(req.params.id, req.body, { new: true }));
};
exports.deleteBanner = async (req, res) => { await Banner.findByIdAndDelete(req.params.id); res.json({ message: 'Banner deleted' }); };
