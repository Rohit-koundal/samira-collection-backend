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
  return /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(String(url || ''));
}

function extractUploadsPath(url = '') {
  const match = String(url).match(/\/uploads\/[^?#\s]+/i);
  return match ? match[0] : '';
}

function rewriteImageUrl(url, req) {
  if (!url || isKnownMissingImage(url)) return '';

  const uploadsPath = extractUploadsPath(url);
  if (uploadsPath && isInaccessibleImageUrl(url)) {
    return `${getPublicApiUrl(req)}${uploadsPath}`;
  }

  if (url.startsWith('/uploads/')) {
    return `${getPublicApiUrl(req)}${url}`;
  }

  return url;
}

function sanitizeStoredImageUrl(url = '') {
  if (!url) return url;
  if (isInaccessibleImageUrl(url)) {
    const uploadsPath = extractUploadsPath(url);
    return uploadsPath || url;
  }
  return url;
}

function sanitizeProductImages(images = []) {
  if (!Array.isArray(images)) return images;
  return images.map((image) => {
    if (!image || typeof image !== 'object') return image;
    return { ...image, url: sanitizeStoredImageUrl(image.url) };
  });
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
  const rewritten = rewriteImageUrl(url, req);
  if (!rewritten) {
    return { ...(typeof image === 'object' && image ? image : {}), url: placeholderUrl(req), isPlaceholder: true };
  }
  return typeof image === 'string' ? { url: rewritten } : { ...image, url: rewritten };
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
  sanitizeProductImages,
};
