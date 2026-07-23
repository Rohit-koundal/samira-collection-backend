const Banner = require('../models/Banner');
const { deleteImageFromR2, isR2Configured } = require('../services/r2Upload');
exports.getBanners = async (req, res) => {
  const query = req.query.admin === 'true' ? {} : { isActive: true };
  res.json(await Banner.find(query).sort('displayOrder'));
};
exports.getBannerById = async (req, res) => {
  const banner = await Banner.findById(req.params.id);
  if (!banner) return res.status(404).json({ message: 'Banner not found' });
  res.json(banner);
};
exports.createBanner = async (req, res) => {
  if (!req.body.title) return res.status(400).json({ message: 'Banner title is required' });
  if (!req.body.image) return res.status(400).json({ message: 'Banner image is required' });
  if (req.body.image?.startsWith('data:')) return res.status(400).json({ message: 'Banner image must be an uploaded file URL' });
  res.status(201).json(await Banner.create(normalizeBannerPayload(req.body)));
};
exports.updateBanner = async (req, res) => {
  if (req.body.image?.startsWith('data:')) return res.status(400).json({ message: 'Banner image must be an uploaded file URL' });
  const existingBanner = await Banner.findById(req.params.id);
  if (!existingBanner) return res.status(404).json({ message: 'Banner not found' });
  const updatedBanner = await Banner.findByIdAndUpdate(req.params.id, normalizeBannerPayload(req.body, existingBanner), { new: true, runValidators: true });
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

function normalizeBannerPayload(payload = {}, existingBanner = null) {
  return {
    ...payload,
    title: String(payload.title || existingBanner?.title || '').trim(),
    subtitle: String(payload.subtitle || '').trim(),
    buttonText: String(payload.buttonText || '').trim(),
    link: String(payload.link || '').trim(),
    image: String(payload.image || existingBanner?.image || '').trim(),
    type: payload.type || existingBanner?.type || 'Hero',
    position: payload.position || existingBanner?.position || 'Home - Top',
    displayOrder: Number(payload.displayOrder ?? existingBanner?.displayOrder ?? 0),
    views: Number(payload.views ?? existingBanner?.views ?? 0),
    isActive: payload.isActive ?? existingBanner?.isActive ?? true,
  };
}
