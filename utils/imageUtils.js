function isLocalRequest(req) {
  const host = String(req?.get?.('host') || req?.hostname || '').toLowerCase();
  return host.includes('localhost') || host.includes('127.0.0.1');
}

function getPublicApiUrl(req) {
  if (isLocalRequest(req)) {
    return `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
  }

  let apiUrl = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`;
  if (/localhost|127\.0\.0\.1/i.test(apiUrl)) {
    apiUrl = `${req.protocol}://${req.get('host')}`;
  }

  return apiUrl.replace(/\/$/, '');
}

function placeholderUrl(req) {
  return `${getPublicApiUrl(req)}/placeholder.jpg`;
}

function isInaccessibleImageUrl(url) {
  return process.env.NODE_ENV === 'production'
    && /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(String(url || ''));
}

function buildUploadFileResponse(file, req) {
  return {
    url: `${getPublicApiUrl(req)}/uploads/${file.filename}`,
    publicId: file.filename,
    originalName: file.originalname,
  };
}

function normalizeImageForResponse(image, req) {
  const url = typeof image === 'string' ? image : image?.url;
  if (!url || isKnownMissingImage(url) || isInaccessibleImageUrl(url)) {
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

module.exports = {
  buildUploadFileResponse,
  getPublicApiUrl,
  isLocalRequest,
  normalizeProductImages,
  placeholderUrl,
};
