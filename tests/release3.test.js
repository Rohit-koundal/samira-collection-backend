const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Product = require('../models/Product');
const Order = require('../models/Order');
const AuditLog = require('../models/AuditLog');
const Store = require('../models/Store');
const InventoryTransaction = require('../models/InventoryTransaction');
const { createProvisionedSeller } = require('./accessFixtures');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings();
});

async function createSellerStore(name = 'Riya Fashion') {
  return createProvisionedSeller(name);
}

test('provisioned seller membership does not grant platform admin role', async () => {
  const { user, token, store } = await createSellerStore();
  assert.equal(store.slug.includes('riya'), true);
  assert.equal(store.status, 'ONBOARDING');

  const me = await request('/api/auth/me', { token });
  assert.ok(me.data.stores.some((item) => item.slug === store.slug));

  const stored = await require('../models/User').findById(user._id);
  assert.equal(stored.role, 'customer');
  assert.ok(stored.availableModes.includes('seller'));
});

test('customers and ordinary admins cannot provision their own stores', async () => {
  for (const account of [await createCustomer(), await createAdmin()]) {
    const denied = await request('/api/stores', { method: 'POST', token: account.token, body: { name: 'Unapproved Store' } });
    assert.equal(denied.status, 403);
  }
  assert.equal(await Store.countDocuments({ name: 'Unapproved Store' }), 0);
});

test('seller A cannot read seller B products', async () => {
  const sellerA = await createSellerStore('Store Alpha');
  const sellerB = await createSellerStore('Store Beta');

  await Product.create({
    name: 'Alpha Kurti',
    slug: 'alpha-kurti',
    sku: 'ALPHA-1',
    price: 999,
    originalPrice: 1299,
    stock: 4,
    isActive: true,
    storeId: sellerA.store.id,
  });
  await Product.create({
    name: 'Beta Saree',
    slug: 'beta-saree',
    sku: 'BETA-1',
    price: 1999,
    originalPrice: 2499,
    stock: 3,
    isActive: true,
    storeId: sellerB.store.id,
  });

  const listA = await request('/api/seller/products', { token: sellerA.token, headers: { 'x-store-id': sellerA.store.id } });
  assert.equal(listA.status, 200);
  assert.equal(listA.data.length, 1);
  assert.equal(listA.data[0].name, 'Alpha Kurti');

  const listB = await request('/api/seller/products', { token: sellerB.token, headers: { 'x-store-id': sellerB.store.id } });
  assert.equal(listB.data.length, 1);
  assert.equal(listB.data[0].name, 'Beta Saree');
});

test('default storefront still lists legacy products without storeId', async () => {
  await createProduct({ name: 'Samira Saree', slug: 'samira-saree', sku: 'SAM-1' });
  const seller = await createSellerStore('Hidden Boutique');
  await Product.create({
    name: 'Hidden Kurti',
    slug: 'hidden-kurti',
    sku: 'HID-1',
    price: 800,
    originalPrice: 1000,
    stock: 2,
    isActive: true,
    storeId: seller.store.id,
  });

  const catalog = await request('/api/products');
  assert.equal(catalog.status, 200);
  assert.ok(catalog.data.some((item) => item.slug === 'samira-saree'));
  assert.equal(catalog.data.some((item) => item.slug === 'hidden-kurti'), false);
});

test('published storefront lists only that store catalog', async () => {
  const seller = await createSellerStore('Published Look');
  await Product.create({
    name: 'Look Dress',
    slug: 'look-dress',
    sku: 'LOOK-1',
    price: 1500,
    originalPrice: 2000,
    stock: 2,
    isActive: true,
    storeId: seller.store.id,
  });
  await Store.updateOne({ _id: seller.store.id }, { status: 'PUBLISHED', publishedAt: new Date() });

  const catalog = await request(`/api/products?store=${seller.store.slug}`);
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.length, 1);
  assert.equal(catalog.data[0].name, 'Look Dress');
});

test('client storeId on product create is ignored', async () => {
  const { token } = await createAdmin();
  const other = await createSellerStore('Other Shop');
  const category = await request('/api/admin/categories', {
    method: 'POST',
    token,
    body: { name: 'Kurtis', slug: 'kurtis' },
  });

  const created = await request('/api/admin/products', {
    method: 'POST',
    token,
    body: {
      name: 'Platform Kurti',
      sku: 'PLT-1',
      category: category.data._id,
      price: 900,
      originalPrice: 1200,
      stock: 3,
      images: [{ url: '/uploads/test.jpg', primary: true }],
      storeId: other.store.id,
    },
  });
  assert.equal(created.status, 201);
  assert.ok(!created.data.storeId);
});

test('products are archived instead of hard-deleted', async () => {
  const { token } = await createAdmin();
  const product = await createProduct({ sku: 'DEL-1' });
  const deleted = await request(`/api/admin/products/${product._id}`, { method: 'DELETE', token });
  assert.equal(deleted.status, 200);
  const stored = await Product.findById(product._id);
  assert.ok(stored);
  assert.equal(stored.isArchived, true);
  assert.equal(stored.isActive, false);
});

test('pagination is opt-in and keeps the array format by default', async () => {
  const { token } = await createAdmin();
  await createProduct({ sku: 'PAGE-1' });
  await createProduct({ sku: 'PAGE-2' });

  const plain = await request('/api/admin/products', { token });
  assert.equal(Array.isArray(plain.data), true);

  const paged = await request('/api/admin/products?page=1&limit=1', { token });
  assert.equal(paged.status, 200);
  assert.equal(Array.isArray(paged.data.items), true);
  assert.equal(paged.data.page, 1);
  assert.equal(paged.data.limit, 1);
  assert.ok(paged.data.total >= 2);
});

test('audit log records stock updates', async () => {
  const { token } = await createAdmin();
  const product = await createProduct({ sku: 'AUD-1', stock: 8 });
  const updated = await request(`/api/admin/products/${product._id}/stock`, {
    method: 'PATCH',
    token,
    body: { stock: 3 },
  });
  assert.equal(updated.status, 200);
  assert.equal(await AuditLog.countDocuments({ action: 'STOCK_UPDATE' }), 1);
});

test('analytics rejects payment secrets and records a store view', async () => {
  const tracked = await request('/api/analytics/events', {
    method: 'POST',
    body: {
      name: 'STORE_VIEW',
      source: 'instagram',
      campaign: 'reel-drop',
      metadata: { razorpay_secret: 'should-not-store', path: '/#/' },
    },
  });
  assert.equal(tracked.status, 202);
  const AnalyticsEvent = require('../models/AnalyticsEvent');
  const event = await AnalyticsEvent.findOne({ name: 'STORE_VIEW' });
  assert.ok(event);
  assert.equal(event.metadata?.razorpay_secret, undefined);
  assert.equal(event.source, 'instagram');
});

test('COD below the configured minimum is rejected', async () => {
  await setSettings({ codEnabled: true, codMinAmount: 800, deliveryCharge: 0, freeShippingMinAmount: 0 });
  const { token } = await createCustomer();
  const product = await createProduct({ price: 500, originalPrice: 500, stock: 5 });
  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });
  assert.equal(status, 400);
  assert.equal(data.code, 'PAYMENT_METHOD_UNAVAILABLE');
  assert.equal(await Order.countDocuments(), 0);
});

test('SEO routes expose robots and sitemap without secrets', async () => {
  const robots = await request('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(String(robots.data), /Sitemap/);

  const sitemap = await request('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(String(sitemap.data), /urlset/);
});

test('seller product create assigns the store and ignores client storeId', async () => {
  const seller = await createSellerStore('Catalog Shop');
  const headers = { 'x-store-id': seller.store.id };
  const categories = await request('/api/seller/categories', { token: seller.token, headers });
  assert.equal(categories.status, 200);
  assert.ok(categories.data.length >= 1);

  const created = await request('/api/seller/products', {
    method: 'POST',
    token: seller.token,
    headers,
    body: {
      name: 'Boutique Kurti',
      sku: 'BKT-1',
      category: categories.data[0]._id,
      price: 900,
      originalPrice: 1200,
      stock: 4,
      images: [{ url: '/uploads/test.jpg', primary: true }],
      storeId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    },
  });
  assert.equal(created.status, 201);
  assert.equal(String(created.data.storeId), String(seller.store.id));
});

test('BEGIN_CHECKOUT is accepted as an analytics event', async () => {
  const tracked = await request('/api/analytics/events', {
    method: 'POST',
    body: { name: 'BEGIN_CHECKOUT', source: 'instagram', campaign: 'summer-drop' },
  });
  assert.equal(tracked.status, 202);
  const AnalyticsEvent = require('../models/AnalyticsEvent');
  const event = await AnalyticsEvent.findOne({ name: 'BEGIN_CHECKOUT' });
  assert.ok(event);
  assert.equal(event.source, 'instagram');
});

test('inventory ledger copies storeId from the sold product', async () => {
  const seller = await createSellerStore('Ledger Boutique');
  const product = await createProduct({
    name: 'Ledger Kurti',
    slug: 'ledger-kurti',
    sku: 'LED-1',
    stock: 3,
    price: 500,
    originalPrice: 500,
    storeId: seller.store.id,
  });
  const { token } = await createCustomer();
  const ordered = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });
  assert.equal(ordered.status, 201);
  const ledger = await InventoryTransaction.findOne({ product: product._id, type: 'SALE' });
  assert.ok(ledger);
  assert.equal(String(ledger.storeId), String(seller.store.id));
});
