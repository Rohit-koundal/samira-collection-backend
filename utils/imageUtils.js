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

function normalizeImageEntry(image) {
  if (!image) return null;
  if (typeof image === 'string') {
    return { url: image, primary: false };
  }
  const url = image.url || '';
  if (!url) return null;
  return {
    ...image,
    url,
    primary: Boolean(image.primary),
  };
}

function normalizeImageEntries(images = []) {
  return Array.isArray(images)
    ? images.map(normalizeImageEntry).filter(Boolean)
    : [];
}

function getPrimaryImageUrl(images = []) {
  const normalized = normalizeImageEntries(images).filter((image) => image.url && !isKnownMissingImage(image.url));
  return normalized.find((image) => image.primary)?.url || normalized[0]?.url || '';
}

function normalizeImageForResponse(image, req) {
  const normalized = normalizeImageEntry(image);
  const url = normalized?.url;
  if (!url || isKnownMissingImage(url)) {
    return { ...(normalized || {}), url: placeholderUrl(req), isPlaceholder: true, primary: Boolean(normalized?.primary) };
  }
  return normalized;
}

function normalizeProductImages(product, req) {
  const data = typeof product.toObject === 'function' ? product.toObject() : { ...product };
  const images = normalizeImageEntries(data.images).map((image) => normalizeImageForResponse(image, req));
  if (images.length) {
    const primaryIndex = images.findIndex((image) => image.primary);
    if (primaryIndex === -1) images[0] = { ...images[0], primary: true };
    data.images = images;
    data.primaryImage = getPrimaryImageUrl(images);
  } else {
    data.images = [{ url: placeholderUrl(req), isPlaceholder: true, primary: true }];
    data.primaryImage = data.images[0].url;
  }
  return data;
}

function normalizeProductPayload(data = {}) {
  const payload = { ...data };
  const images = normalizeImageEntries(payload.images).filter((image) => image.url && !isKnownMissingImage(image.url));
  if (images.length) {
    const primaryIndex = images.findIndex((image) => image.primary);
    if (primaryIndex === -1) images[0].primary = true;
    payload.images = images.map((image) => ({
      url: image.url,
      publicId: image.publicId,
      primary: Boolean(image.primary),
    }));
    payload.primaryImage = getPrimaryImageUrl(payload.images);
  }
  return payload;
}

function isKnownMissingImage(url) {
  return /(^|\/)placeholder\.jpe?g($|\?)/i.test(String(url || ''));
}

module.exports = {
  getPublicApiUrl,
  getPrimaryImageUrl,
  normalizeImageEntries,
  normalizeProductImages,
  normalizeProductPayload,
  placeholderUrl,
};
