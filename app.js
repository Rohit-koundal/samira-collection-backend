const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const devFallback = require('./middleware/devFallbackMiddleware');
const { protect } = require('./middleware/authMiddleware');
const { adminOnly } = require('./middleware/adminMiddleware');
const { corsOptions, getAllowedOrigins } = require('./config/corsOptions');

const app = express();

app.set('trust proxy', 1);
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '30mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/uploads/:filename', sendImagePlaceholder);
app.get('/placeholder.jpg', sendImagePlaceholder);

app.get('/', (req, res) => res.json({ message: 'Samira Collection API is running' }));
app.get('/health', (req, res) => {
  const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    status: 'ok',
    database: dbStates[mongoose.connection.readyState] || 'unknown',
    environment: process.env.NODE_ENV || 'development',
    allowedOrigins: getAllowedOrigins(),
  });
});

app.use('/api', devFallback);

app.use('/api/auth', require('./routes/authRoutes'));
app.post('/api/admin/login', require('./controllers/authController').login);
app.use('/api/admin/customers', protect, adminOnly, require('./routes/customerAdminRoutes'));
app.use('/api/admin/users', protect, adminOnly, require('./routes/customerAdminRoutes'));
app.use('/api/admin', require('./routes/adminAuthRoutes'));
app.use('/api/admin/products', protect, adminOnly, require('./routes/productRoutes'));
app.use('/api/admin/categories', protect, adminOnly, require('./routes/categoryRoutes'));
app.use('/api/admin/orders', protect, adminOnly, require('./routes/orderRoutes'));
app.use('/api/admin/coupons', protect, adminOnly, require('./routes/couponRoutes'));
app.use('/api/admin/banners', protect, adminOnly, require('./routes/bannerRoutes'));
app.use('/api/admin/reviews', protect, adminOnly, require('./routes/reviewRoutes'));
app.use('/api/admin/returns', protect, adminOnly, require('./routes/returnRoutes'));
app.use('/api/admin/settings', protect, adminOnly, require('./routes/settingsRoutes'));
app.use('/api/admin/uploads', require('./routes/uploadRoutes'));
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/categories', require('./routes/categoryRoutes'));
app.use('/api/cart', require('./routes/cartRoutes'));
app.use('/api/user/addresses', require('./routes/addressRoutes'));
app.use('/api/wishlist', require('./routes/wishlistRoutes'));
app.use('/api/orders', require('./routes/orderRoutes'));
app.use('/api/payments', require('./routes/paymentRoutes'));
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
