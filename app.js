const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { validateEnvironment } = require('./config/env');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const {
  queryPollutionProtection,
  rejectUnsafeMongoKeys,
  requestCompression,
  requestContext,
  secureHeaders,
} = require('./middleware/securityMiddleware');
const devFallback = require('./middleware/devFallbackMiddleware');
const { protect } = require('./middleware/authMiddleware');
const { adminOnly, ownerOnly, requirePermission } = require('./middleware/adminMiddleware');
const { auditAdminMutations } = require('./middleware/adminAuditMiddleware');
const { rateLimit } = require('./middleware/rateLimitMiddleware');
const { getRateLimitStoreState } = require('./services/rateLimitService');
const { corsOptions } = require('./config/corsOptions');
const { getMediaStorageState } = require('./services/mediaStorage');
const { getShippingState } = require('./services/shippingService');
const paymentController = require('./controllers/paymentController');
const { wrapPaymentHandler } = require('./utils/paymentRouteHandler');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 1);
app.use(requestContext);
app.use(secureHeaders);
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.post(
  '/api/payments/webhook',
  rateLimit({ scope: 'payment_webhook', limit: 300, windowSeconds: 60 }),
  express.raw({ type: 'application/json', limit: '1mb' }),
  wrapPaymentHandler(paymentController.handleWebhook),
);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(queryPollutionProtection);
app.use(rejectUnsafeMongoKeys);
app.use(requestCompression);
if (process.env.NODE_ENV !== 'production') app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/uploads/:filename', sendImagePlaceholder);
app.get('/placeholder.jpg', sendImagePlaceholder);

app.get('/', (req, res) => res.json({ message: 'Samira Collection API is running' }));
app.get('/health/live', (req, res) => res.json({ status: 'ok', requestId: req.id }));
const readinessHandler = async (req, res) => {
  const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const database = dbStates[mongoose.connection.readyState] || 'unknown';
  const media = getMediaStorageState();
  const shipping = getShippingState();
  const rateLimitStore = await getRateLimitStoreState();
  const checks = {
    environment: 'ok',
    database,
    mediaStorage: media.configured ? media.provider : 'not_configured',
    redis: rateLimitStore.available
      ? 'available'
      : (rateLimitStore.configured ? 'unavailable' : 'not_configured'),
    payments: process.env.PAYMENTS_ENABLED === 'true'
      ? (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET ? 'configured' : 'not_configured')
      : 'disabled',
    shipping: shipping.enabled ? shipping.provider : 'disabled',
  };
  try {
    validateEnvironment();
  } catch {
    checks.environment = 'invalid';
  }
  const requireDatabase = process.env.NODE_ENV === 'production' || process.env.REQUIRE_DATABASE === 'true';
  const requireMedia = process.env.NODE_ENV === 'production'
    ? process.env.REQUIRE_MEDIA_STORAGE !== 'false'
    : process.env.REQUIRE_MEDIA_STORAGE === 'true';
  const ready = checks.environment === 'ok'
    && (!requireDatabase || database === 'connected')
    && (!requireMedia || media.configured)
    && (process.env.PAYMENTS_ENABLED !== 'true' || checks.payments === 'configured')
    && (process.env.NODE_ENV !== 'production' || checks.redis === 'available');
  return res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks, requestId: req.id });
};
app.get('/health/ready', readinessHandler);
app.get('/health', readinessHandler);

app.use('/api', devFallback);

app.use('/api/products', rateLimit({
  scope: 'product_search',
  limit: 120,
  windowSeconds: 60,
  when: (req) => req.method === 'GET' && Boolean(req.query.search),
}));
app.use('/api/auth', require('./routes/authRoutes'));
app.post('/api/admin/login', require('./controllers/authController').login);
app.use('/api/admin', auditAdminMutations);
app.use('/api/admin/access', protect, adminOnly, ownerOnly, require('./routes/adminAccessRoutes'));
app.use('/api/admin/audit-logs', protect, adminOnly, requirePermission('view_audit_logs'), require('./routes/adminAuditRoutes'));
app.use('/api/admin/inventory', protect, adminOnly, requirePermission('manage_inventory'), require('./routes/adminInventoryRoutes'));
app.use('/api/admin/customers', protect, adminOnly, requirePermission('manage_customers'), require('./routes/customerAdminRoutes'));
app.use('/api/admin/users', protect, adminOnly, requirePermission('manage_customers'), require('./routes/customerAdminRoutes'));
app.use('/api/admin', require('./routes/adminAuthRoutes'));
app.use('/api/admin/products', protect, adminOnly, requirePermission('manage_catalog', 'manage_inventory'), require('./routes/adminProductRoutes'));
app.use('/api/admin/categories', protect, adminOnly, requirePermission('manage_catalog'), require('./routes/categoryRoutes'));
app.use('/api/admin/orders', protect, adminOnly, requirePermission('manage_orders'), require('./routes/orderRoutes'));
app.use('/api/admin/coupons', protect, adminOnly, requirePermission('manage_marketing'), require('./routes/couponRoutes'));
app.use('/api/admin/banners', protect, adminOnly, requirePermission('manage_marketing'), require('./routes/bannerRoutes'));
app.use('/api/admin/reviews', protect, adminOnly, requirePermission('manage_support'), require('./routes/reviewRoutes'));
app.use('/api/admin/returns', protect, adminOnly, requirePermission('manage_support'), require('./routes/returnRoutes'));
app.use('/api/admin/settings', protect, adminOnly, requirePermission('manage_settings'), require('./routes/settingsRoutes'));
app.use('/api/admin/support', protect, adminOnly, requirePermission('manage_support'), require('./routes/adminSupportRoutes'));
app.use('/api/admin/uploads', protect, adminOnly, requirePermission('manage_catalog'), require('./routes/uploadRoutes'));
app.use('/api/admin/upload', protect, adminOnly, requirePermission('manage_catalog'), require('./routes/uploadRoutes'));
app.use('/api/admin/product-drafts', protect, adminOnly, requirePermission('manage_catalog'), require('./routes/productDraftRoutes'));
app.use('/api/admin/reel-imports', protect, adminOnly, requirePermission('manage_catalog'), rateLimit({
  scope: 'admin_reel_import',
  limit: 60,
  windowSeconds: 60,
  identifiers: [
    (req) => req.ip,
    (req) => req.user?._id ? String(req.user._id) : null,
  ],
}), require('./modules/reel-product-import/reelImport.routes'));
app.use('/api/admin/variant-groups', protect, adminOnly, requirePermission('manage_catalog'), require('./routes/variantGroupRoutes'));
app.use('/api/products', require('./routes/publicProductRoutes'));
app.use('/api/variant-groups', require('./routes/variantGroupRoutes'));
app.use('/api/categories', require('./routes/categoryRoutes'));
app.use('/api/cart', require('./routes/cartRoutes'));
app.use('/api/user/addresses', require('./routes/addressRoutes'));
app.use('/api/wishlist', require('./routes/wishlistRoutes'));
app.use('/api/orders', require('./routes/orderRoutes'));
app.use('/api/payments', rateLimit({
  scope: 'payment_api',
  limit: 40,
  windowSeconds: 10 * 60,
}), require('./routes/paymentRoutes'));
app.use('/api/invoices', require('./routes/invoiceRoutes'));
app.use('/api/support', require('./routes/supportRoutes'));

app.post('/api/create-order', protect, rateLimit({
  scope: 'payment_create_legacy',
  limit: 20,
  windowSeconds: 10 * 60,
  identifiers: [
    (req) => req.ip,
    (req) => String(req.user._id),
  ],
}), wrapPaymentHandler(paymentController.createPaymentOrder));
app.post('/api/verify-payment', protect, rateLimit({
  scope: 'payment_verify_legacy',
  limit: 40,
  windowSeconds: 10 * 60,
  identifiers: [
    (req) => req.ip,
    (req) => String(req.user._id),
  ],
}), wrapPaymentHandler(paymentController.verifyPayment));

app.use('/api/coupons', require('./routes/couponRoutes'));
app.use('/api/banners', require('./routes/bannerRoutes'));
app.use('/api/reviews', require('./routes/reviewRoutes'));
app.use('/api/returns', require('./routes/returnRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));

app.use(notFound);
app.use(errorHandler);

function sendImagePlaceholder(req, res, next) {
  const filename = String(req.params.filename || 'placeholder.jpg');
  if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(filename)) return next();

  const label = filename.toLowerCase().includes('placeholder') ? 'Samira Collection' : 'Image unavailable';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#fbf3ee"/>
          <stop offset="100%" stop-color="#f6d2bf"/>
        </linearGradient>
      </defs>
      <rect width="800" height="1000" fill="url(#bg)"/>
      <path d="M250 410c55-120 245-120 300 0" fill="none" stroke="#7b1f3a" stroke-width="34" stroke-linecap="round"/>
      <path d="M300 430c38-75 162-75 200 0" fill="none" stroke="#ff5f86" stroke-width="28" stroke-linecap="round"/>
      <text x="400" y="545" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" font-weight="800" fill="#17161a">Samira</text>
      <text x="400" y="600" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" font-weight="700" letter-spacing="8" fill="#7b1f3a">COLLECTION</text>
      <text x="400" y="690" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#6b7280">${label}</text>
    </svg>
  `;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.status(200).send(svg);
}

module.exports = app;
