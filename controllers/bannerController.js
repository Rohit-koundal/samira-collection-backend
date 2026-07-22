const Banner = require('../models/Banner');
const { assertObjectId, cleanString, pick } = require('../utils/requestValidation');

const BANNER_FIELDS = ['title', 'subtitle', 'image', 'buttonText', 'link', 'type', 'position', 'isActive', 'displayOrder'];

exports.getBanners = async (req, res) => {
  const isAdmin = ['admin', 'owner'].includes(req.user?.role)
    && String(req.baseUrl || '').startsWith('/api/admin/banners');
  return res.json(await Banner.find(isAdmin ? {} : { isActive: true }).sort('displayOrder'));
};

exports.getBannerById = async (req, res) => {
  assertObjectId(req.params.id, 'banner id');
  const banner = await Banner.findById(req.params.id);
  if (!banner) return res.status(404).json({ message: 'Banner not found' });
  return res.json(banner);
};

exports.createBanner = async (req, res) => {
  const payload = normalizeBannerPayload(pick(req.body, BANNER_FIELDS), null, true);
  return res.status(201).json(await Banner.create(payload));
};

exports.updateBanner = async (req, res) => {
  assertObjectId(req.params.id, 'banner id');
  const existing = await Banner.findById(req.params.id);
  if (!existing) return res.status(404).json({ message: 'Banner not found' });
  const updated = await Banner.findByIdAndUpdate(
    req.params.id,
    normalizeBannerPayload(pick(req.body, BANNER_FIELDS), existing, false),
    { new: true, runValidators: true },
  );
  return res.json(updated);
};

exports.deleteBanner = async (req, res) => {
  assertObjectId(req.params.id, 'banner id');
  const banner = await Banner.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!banner) return res.status(404).json({ message: 'Banner not found' });
  return res.json({ message: 'Banner archived', banner });
};

function normalizeBannerPayload(payload, existing, creating) {
  const data = { ...payload };
  if (creating || data.title !== undefined) {
    data.title = cleanString(data.title || existing?.title, { field: 'title', min: 2, max: 160, required: true });
  }
  for (const field of ['subtitle', 'buttonText']) {
    if (data[field] !== undefined) data[field] = cleanString(data[field], { field, max: 300 });
  }
  if (creating || data.image !== undefined) {
    data.image = String(data.image || existing?.image || '').trim();
    if (!data.image || (!/^https:\/\//i.test(data.image) && !/^\/uploads\/[a-z0-9._-]+$/i.test(data.image))) {
      throw validationError('Banner image must be a secure uploaded file URL');
    }
  }
  if (data.link !== undefined) {
    data.link = String(data.link || '').trim();
    if (data.link && !data.link.startsWith('/') && !/^https:\/\//i.test(data.link)) throw validationError('Banner link must be an internal path or HTTPS URL');
  }
  if (data.displayOrder !== undefined) {
    const order = Number(data.displayOrder);
    if (!Number.isSafeInteger(order) || order < 0 || order > 10000) throw validationError('Invalid display order');
    data.displayOrder = order;
  }
  if (data.isActive !== undefined && typeof data.isActive !== 'boolean') throw validationError('isActive must be a boolean');
  return data;
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}
