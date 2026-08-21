const Product = require('../models/Product');
const Store = require('../models/Store');
const { asyncHandler } = require('../middleware/validate');
const { ensureDefaultStore } = require('../services/storeService');

function siteOrigin(req) {
  const frontend = String(process.env.FRONTEND_URL || process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
  if (frontend) return frontend;
  return `${req.protocol}://${req.get('host')}`;
}

function productPath(product, storeById) {
  const slug = product?.slug || '';
  const storeSlug = product?.storeId ? storeById.get(String(product.storeId)) : '';
  if (storeSlug && storeSlug !== 'samira-collection') return `/store/${storeSlug}/products/${slug}`;
  return `/product/${slug}`;
}

exports.robots = asyncHandler(async (req, res) => {
  const origin = siteOrigin(req);
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`);
});

exports.sitemap = asyncHandler(async (req, res) => {
  const origin = siteOrigin(req);
  const [stores, products] = await Promise.all([
    Store.find({ status: 'PUBLISHED' }).select('_id slug updatedAt isDefault').lean(),
    Product.find({ isActive: true, isArchived: { $ne: true } }).select('slug storeId updatedAt').lean(),
  ]);
  const storeById = new Map(stores.map((store) => [String(store._id), store.slug]));
  const urls = [
    loc(`${origin}/`, new Date()),
    ...stores.map((store) => loc(`${origin}/store/${store.slug}`, store.updatedAt)),
    ...products.map((product) => loc(`${origin}${productPath(product, storeById)}`, product.updatedAt)),
  ];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
});

exports.productShare = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ slug: req.params.slug, isActive: true, isArchived: { $ne: true } });
  const origin = siteOrigin(req);
  const store = product?.storeId ? await Store.findById(product.storeId) : await ensureDefaultStore();
  const title = product?.metaTitle || product?.name || 'Samira Collection';
  const description = product?.metaDescription || product?.shortDescription || product?.description || 'Ethnic wear from Samira Collection.';
  const image = product?.images?.find((item) => item.primary)?.url || product?.images?.[0]?.url || `${origin}/logo192.png`;
  const storeById = new Map(store?._id ? [[String(store._id), store.slug]] : []);
  const url = `${origin}${productPath(product || { slug: req.params.slug, storeId: store?._id }, storeById)}`;
  const jsonLd = product ? {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description,
    image,
    sku: product.sku,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'INR',
      price: product.price,
      availability: product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    },
  } : null;

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(String(description).slice(0, 180))}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(String(description).slice(0, 180))}" />
  <meta property="og:image" content="${escapeHtml(image)}" />
  <meta property="og:url" content="${escapeHtml(url)}" />
  <meta property="og:type" content="product" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(String(description).slice(0, 180))}" />
  <meta name="twitter:image" content="${escapeHtml(image)}" />
  <link rel="canonical" href="${escapeHtml(url)}" />
  ${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
  <meta http-equiv="refresh" content="0;url=${escapeHtml(url)}" />
</head>
<body>
  <p>${escapeHtml(store?.name || 'Samira Collection')} — <a href="${escapeHtml(url)}">${escapeHtml(title)}</a></p>
</body>
</html>`);
});

function loc(url, lastmod) {
  const modified = lastmod ? new Date(lastmod).toISOString() : new Date().toISOString();
  return `  <url><loc>${escapeXml(url)}</loc><lastmod>${modified}</lastmod></url>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function escapeXml(value) {
  return escapeHtml(value);
}
