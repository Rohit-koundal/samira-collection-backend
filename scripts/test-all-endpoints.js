#!/usr/bin/env node
/**
 * Smoke-test all major API endpoints against a running local server.
 * Usage: node scripts/test-all-endpoints.js [baseUrl]
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BASE = (process.argv[2] || `http://localhost:${process.env.SERVER_PORT || 5001}`).replace(/\/$/, '');
const API = `${BASE}/api`;

const results = { pass: [], fail: [], skip: [] };

function record(name, ok, detail = '') {
  const entry = { name, detail };
  if (ok) results.pass.push(entry);
  else results.fail.push(entry);
}

function skip(name, detail = '') {
  results.skip.push({ name, detail });
}

async function request(method, url, { token, body, formData, origin } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body && !formData) headers['content-type'] = 'application/json';
  if (origin) headers.origin = origin;

  const options = { method, headers };
  if (formData) options.body = formData;
  else if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}

async function expectStatus(name, method, url, expectedStatuses, options = {}) {
  try {
    const res = await request(method, url, options);
    const expected = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
    const ok = expected.includes(res.status);
    record(name, ok, `expected ${expected.join('|')}, got ${res.status}`);
    return res;
  } catch (error) {
    record(name, false, error.message);
    return null;
  }
}

async function loginAdmin() {
  const res = await request('POST', `${API}/admin/login`, {
    body: { email: 'admin@samiracollection.com', password: 'Admin@123' },
  });
  if (res.status === 200 && res.data?.token) return res.data.token;
  return null;
}

async function loginCustomerPassword() {
  const res = await request('POST', `${API}/auth/login`, {
    body: { email: 'customer@test.com', password: 'Customer@123' },
  });
  if (res.status === 200 && res.data?.token) return res.data.token;
  return null;
}

async function loginCustomer() {
  const phone = process.env.ADMIN_PHONE_NUMBERS?.split(',')[0]?.trim() || '9816978086';
  await request('POST', `${API}/auth/send-otp`, { body: { phone } });
  const verify = await request('POST', `${API}/auth/verify-otp`, {
    body: { phone, otp: process.env.OTP_DEV_CODE || '123456' },
  });
  if (verify.status === 200 && verify.data?.token) return verify.data.token;
  return loginCustomerPassword();
}

async function run() {
  console.log(`Testing API at ${API}\n`);

  // Root & health
  await expectStatus('GET /', 'GET', `${BASE}/`, 200);
  const health = await expectStatus('GET /health', 'GET', `${BASE}/health`, 200);
  if (health?.data?.imageStorage) {
    record('health imageStorage present', true, health.data.imageStorage);
  }

  // CORS
  const cors = await request('OPTIONS', `${API}/products`, {
    origin: 'http://localhost:3006',
  });
  record('CORS localhost:3006', cors.headers.get('access-control-allow-origin') === 'http://localhost:3006', cors.headers.get('access-control-allow-origin') || 'missing');

  // Public reads
  await expectStatus('GET /api/products', 'GET', `${API}/products`, 200);
  const products = await request('GET', `${API}/products`);
  const productList = Array.isArray(products.data) ? products.data : [];
  record('products returns array', Array.isArray(products.data), `count=${productList.length}`);

  await expectStatus('GET /api/categories', 'GET', `${API}/categories`, 200);
  await expectStatus('GET /api/banners', 'GET', `${API}/banners`, 200);
  await expectStatus('GET /api/settings', 'GET', `${API}/settings`, 200);
  await expectStatus('GET /api/coupons', 'GET', `${API}/coupons`, 200);

  const slug = productList[0]?.slug;
  if (slug) {
    await expectStatus('GET /api/products/:slug', 'GET', `${API}/products/${slug}`, 200);
  } else {
    skip('GET /api/products/:slug', 'no products in database');
  }

  // Auth - unauthenticated
  await expectStatus('GET /api/auth/me (no token)', 'GET', `${API}/auth/me`, 401);
  await expectStatus('GET /api/cart (no token)', 'GET', `${API}/cart`, 401);
  await expectStatus('GET /api/wishlist (no token)', 'GET', `${API}/wishlist`, 401);

  // Auth endpoints shape
  await expectStatus('POST /api/auth/send-otp (invalid)', 'POST', `${API}/auth/send-otp`, [400, 422, 500], {
    body: { phone: '123' },
  });

  const adminToken = await loginAdmin();
  if (adminToken) {
    record('admin login', true, 'token received');
    await expectStatus('GET /api/auth/me (admin)', 'GET', `${API}/auth/me`, 200, { token: adminToken });
    await expectStatus('GET /api/admin/dashboard/stats', 'GET', `${API}/admin/dashboard/stats`, 200, { token: adminToken });
    await expectStatus('GET /api/admin/products', 'GET', `${API}/admin/products`, 200, { token: adminToken });
    await expectStatus('GET /api/admin/categories', 'GET', `${API}/admin/categories`, 200, { token: adminToken });
    await expectStatus('GET /api/admin/orders', 'GET', `${API}/admin/orders`, 200, { token: adminToken });
    await expectStatus('GET /api/admin/customers', 'GET', `${API}/admin/customers`, 200, { token: adminToken });
    await expectStatus('GET /api/admin/settings', 'GET', `${API}/admin/settings`, 200, { token: adminToken });
    await expectStatus('GET /api/admin/dashboard/recent-orders', 'GET', `${API}/admin/dashboard/recent-orders`, 200, { token: adminToken });
    await expectStatus('GET /api/admin/dashboard/low-stock', 'GET', `${API}/admin/dashboard/low-stock`, 200, { token: adminToken });
    await expectStatus('GET /api/admin/reports/sales', 'GET', `${API}/admin/reports/sales`, 200, { token: adminToken });
    await expectStatus('GET /api/admin/reports/products', 'GET', `${API}/admin/reports/products`, 200, { token: adminToken });
  } else {
    skip('admin protected routes', 'admin login failed — seed admin user or check credentials');
  }

  const customerToken = await loginCustomer();
  if (customerToken) {
    record('customer OTP login', true, 'token received');
    await expectStatus('GET /api/cart', 'GET', `${API}/cart`, 200, { token: customerToken });
    await expectStatus('GET /api/wishlist', 'GET', `${API}/wishlist`, 200, { token: customerToken });
    await expectStatus('GET /api/user/addresses', 'GET', `${API}/user/addresses`, 200, { token: customerToken });
    await expectStatus('GET /api/orders/my-orders', 'GET', `${API}/orders/my-orders`, 200, { token: customerToken });
    await expectStatus('GET /api/returns/my-requests', 'GET', `${API}/returns/my-requests`, 200, { token: customerToken });

    if (productList[0]?._id || productList[0]?.id) {
      const productId = productList[0]._id || productList[0].id;
      await expectStatus('GET /api/reviews/:productId', 'GET', `${API}/reviews/${productId}`, 200);
    }
  } else {
    skip('customer protected routes', 'OTP login failed — check SMS/OTP config');
  }

  // Upload tests
  await expectStatus('POST /api/admin/uploads (empty)', 'POST', `${API}/admin/uploads`, 400);
  const sampleImage = path.join(__dirname, '..', 'uploads', '1781033987445-sarees-premium-style-1-under-2mb.jpg');
  if (fs.existsSync(sampleImage)) {
    const form = new FormData();
    const buffer = fs.readFileSync(sampleImage);
    form.append('images', new Blob([buffer], { type: 'image/jpeg' }), 'test-upload.jpg');
    const upload = await request('POST', `${API}/admin/uploads`, { formData: form });
    const uploadOk = upload.status === 201 && upload.data?.files?.[0]?.url;
    record('POST /api/admin/uploads (image)', uploadOk, `status=${upload.status}, url=${upload.data?.files?.[0]?.url?.slice(0, 60) || 'none'}`);
    if (uploadOk && upload.data.files[0].variants) {
      record('upload returns variants', Boolean(upload.data.files[0].variants.card), Object.keys(upload.data.files[0].variants).join(','));
    }
    await expectStatus('POST /api/admin/uploads (tiny image)', 'POST', `${API}/admin/uploads`, 400, {
      formData: (() => {
        const tiny = path.join(__dirname, '..', 'uploads', '1781033552961-test.png');
        if (!fs.existsSync(tiny)) return undefined;
        const f = new FormData();
        f.append('images', new Blob([fs.readFileSync(tiny)], { type: 'image/png' }), 'tiny.png');
        return f;
      })(),
    });
  } else {
    skip('POST /api/admin/uploads', 'sample image missing');
  }

  // Coupon apply
  await expectStatus('POST /api/coupons/apply', 'POST', `${API}/coupons/apply`, [200, 400], {
    body: { code: 'SAMIRA10', orderAmount: 1000 },
  });

  // Payments (requires auth + razorpay keys optional)
  const paymentToken = customerToken || adminToken;
  if (paymentToken) {
    await expectStatus('POST /api/payments/create-order', 'POST', `${API}/payments/create-order`, [200, 400, 503], {
      token: paymentToken,
      body: { orderItems: [], coupon: null },
    });
    await expectStatus('POST /api/payments/failure', 'POST', `${API}/payments/failure`, 202, {
      token: paymentToken,
      body: { reason: 'test' },
    });
  } else {
    await expectStatus('POST /api/payments/create-order (no token)', 'POST', `${API}/payments/create-order`, 401, {
      body: { amount: 100 },
    });
  }

  // 404
  await expectStatus('GET unknown route', 'GET', `${API}/does-not-exist-route`, 404);

  // Summary
  console.log('\n========== RESULTS ==========');
  console.log(`PASS: ${results.pass.length}`);
  results.pass.forEach((item) => console.log(`  ✓ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`));

  if (results.skip.length) {
    console.log(`\nSKIP: ${results.skip.length}`);
    results.skip.forEach((item) => console.log(`  ○ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`));
  }

  if (results.fail.length) {
    console.log(`\nFAIL: ${results.fail.length}`);
    results.fail.forEach((item) => console.log(`  ✗ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`));
    process.exit(1);
  }

  console.log('\nAll executed endpoint checks passed.');
}

run().catch((error) => {
  console.error('Test runner failed:', error.message);
  process.exit(1);
});
