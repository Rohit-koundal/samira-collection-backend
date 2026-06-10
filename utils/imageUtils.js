function getPublicApiUrl(req) {
  const host = String(req.get('host') || '').toLowerCase();
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
  }
  return (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function placeholderUrl(req) {
  return `${getPublicApiUrl(req)}/placeholder.jpg`;
}

function normalizeImageForResponse(image, req) {
  const url = typeof image === 'string' ? image : image?.url;
  if (!url || isKnownMissingImage(url) || isRenderLocalUploadUrl(url)) {
    return { ...(typeof image === 'object' && image ? image : {}), url: placeholderUrl(req), isPlaceholder: true };
  }
  return typeof image === 'string' ? { url } : image;
}

function normalizeProductImages(product, req) {
  const data = typeof product.toObject === 'function' ? product.toObject() : { ...product };
  data.images = Array.isArray(data.images) && data.images.length
    ? data.images.map((image) => normalizeImageForResponse(image, req))
    : [{ url: placeholderUrl(req), isPlaceholder: true }];
  return data;
}

function isKnownMissingImage(url) {
  return /(^|\/)placeholder\.jpe?g($|\?)/i.test(String(url || ''));
}

function isRenderLocalUploadUrl(url) {
  return process.env.NODE_ENV === 'production'
    && String(url || '').includes('.onrender.com/uploads/')
    && !process.env.ALLOW_RENDER_DISK_UPLOADS;
}

module.exports = {
  getPublicApiUrl,
  normalizeProductImages,
  placeholderUrl,
};
