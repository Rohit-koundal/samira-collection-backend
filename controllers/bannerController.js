const Banner = require('../models/Banner');
const { deleteImageFromR2, isR2Configured } = require('../services/r2Upload');
const { andFilter } = require('../services/storeService');
const { asyncHandler } = require('../middleware/validate');

function withStoreId(payload, req) {
  const next = { ...payload };
  delete next.storeId;
  if (req.store?._id) next.storeId = req.store._id;
  return next;
}

exports.getBanners = asyncHandler(async (req, res) => {
  const query = andFilter(/^\/api\/(admin|seller)(\/|$)/.test(req.baseUrl || '') ? {} : { isActive: true }, req.tenantFilter);
  res.json(await Banner.find(query).sort('displayOrder'));
});
exports.getBannerById = asyncHandler(async (req, res) => {
  const banner = await Banner.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!banner) return res.status(404).json({ message: 'Banner not found' });
  res.json(banner);
});
exports.createBanner = asyncHandler(async (req, res) => {
  if (!req.body.title) return res.status(400).json({ message: 'Banner title is required' });
  if (!req.body.image) return res.status(400).json({ message: 'Banner image is required' });
  if (req.body.image?.startsWith('data:')) return res.status(400).json({ message: 'Banner image must be an uploaded file URL' });
  res.status(201).json(await Banner.create(withStoreId(normalizeBannerPayload(req.body), req)));
});
exports.updateBanner = asyncHandler(async (req, res) => {
  if (req.body.image?.startsWith('data:')) return res.status(400).json({ message: 'Banner image must be an uploaded file URL' });
  const existingBanner = await Banner.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!existingBanner) return res.status(404).json({ message: 'Banner not found' });
  const payload = normalizeBannerPayload(req.body, existingBanner);
  delete payload.storeId;
  const updatedBanner = await Banner.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
  if (existingBanner?.image && existingBanner.image !== updatedBanner?.image) {
    await safeDeleteBannerImage(existingBanner.image);
  }
  res.json(updatedBanner);
});
exports.deleteBanner = asyncHandler(async (req, res) => {
  const banner = await Banner.findOne(andFilter({ _id: req.params.id }, req.tenantFilter));
  if (!banner) return res.status(404).json({ message: 'Banner not found' });
  if (banner?.image) await safeDeleteBannerImage(banner.image);
  await Banner.findByIdAndDelete(req.params.id);
  res.json({ message: 'Banner deleted' });
});

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
    subtitle: String(payload.subtitle ?? existingBanner?.subtitle ?? '').trim(),
    buttonText: String(payload.buttonText ?? existingBanner?.buttonText ?? '').trim(),
    link: String(payload.link ?? existingBanner?.link ?? '').trim(),
    image: String(payload.image || existingBanner?.image || '').trim(),
    type: payload.type || existingBanner?.type || 'Hero',
    position: payload.position || existingBanner?.position || 'Home - Top',
    displayOrder: Number(payload.displayOrder ?? existingBanner?.displayOrder ?? 0),
    views: Number(payload.views ?? existingBanner?.views ?? 0),
    isActive: payload.isActive ?? existingBanner?.isActive ?? true,
  };
}
