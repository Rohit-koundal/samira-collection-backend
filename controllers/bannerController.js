const Banner = require('../models/Banner');
const { deleteImageFromR2, isR2Configured } = require('../services/r2Upload');
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
  const existingBanner = await Banner.findById(req.params.id);
  const updatedBanner = await Banner.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (existingBanner?.image && existingBanner.image !== updatedBanner?.image) {
    await safeDeleteBannerImage(existingBanner.image);
  }
  res.json(updatedBanner);
};
exports.deleteBanner = async (req, res) => {
  const banner = await Banner.findById(req.params.id);
  if (banner?.image) await safeDeleteBannerImage(banner.image);
  await Banner.findByIdAndDelete(req.params.id);
  res.json({ message: 'Banner deleted' });
};

async function safeDeleteBannerImage(image) {
  if (!isR2Configured()) return;
  try {
    await deleteImageFromR2(image);
  } catch {
    // Ignore cleanup failures so banner updates stay safe.
  }
}
