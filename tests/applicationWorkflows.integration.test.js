const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment, getBaseUrl } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const { createMasterOwner, createProvisionedSeller } = require('./accessFixtures');
const Product = require('../models/Product');
const VariantGroup = require('../models/VariantGroup');
const Store = require('../models/Store');
const Cart = require('../models/Cart');
const Notification = require('../models/Notification');
const Order = require('../models/Order');
const Subscriber = require('../models/Subscriber');
const Banner = require('../models/Banner');
const Coupon = require('../models/Coupon');
const WebsiteTheme = require('../models/WebsiteTheme');
const { readConfiguration } = require('../services/masterConfigurationService');
test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => { await resetDatabase(); await setSettings(); });
async function call(method, route, body, token, status = 200, headers) {
  const result = await request(route, { method, body, token, headers });
  assert.equal(result.status, status, `${method} ${route}: ${JSON.stringify(result.data)}`);
  return result.data;
}
const get = (route, token, headers) => call('GET', route, undefined, token, 200, headers);

test('category create/read/update/hide/delete survives duplicate names and malformed IDs', async () => {
  const { token } = await createAdmin();
  const category = await call('POST', '/api/admin/categories', { name: 'Workflow Sarees', slug: 'workflow-sarees', image: '/uploads/category.jpg' }, token, 201);
  assert.equal((await get(`/api/admin/categories/${category._id}`, token)).name, 'Workflow Sarees');
  await call('POST', '/api/admin/categories', { name: 'Workflow Sarees', slug: category.slug }, token, 409);
  await call('GET', '/api/admin/categories/bad-id', undefined, token, 400);
  await call('PUT', `/api/admin/categories/${category._id}`, { name: '   ' }, token, 400);
  await call('PUT', `/api/admin/categories/${category._id}`, { name: 'Hidden Sarees', isActive: false }, token);
  assert.equal((await get('/api/admin/categories', token)).length, 1);
  assert.equal((await get('/api/categories?admin=true')).length, 0);
  await call('PATCH', `/api/admin/categories/${category._id}/status`, { isActive: true }, token);
  assert.equal((await get('/api/categories')).length, 1);
  await call('PATCH', `/api/admin/categories/${category._id}/archive`, {}, token);
  assert.equal((await get('/api/categories')).length, 0);
  await call('DELETE', `/api/admin/categories/${category._id}?confirm=wrong`, undefined, token, 400);
  await call('DELETE', `/api/admin/categories/${category._id}?confirm=Hidden%20Sarees`, undefined, token);
  assert.equal((await get('/api/admin/categories', token)).length, 0);
  await call('GET', `/api/admin/categories/${category._id}`, undefined, token, 404);
});

test('category dependencies are counted, protected and reassigned without deleting products', async () => {
  const { token } = await createAdmin();
  const source = await call('POST', '/api/admin/categories', { name: 'Occasion Wear' }, token, 201);
  const target = await call('POST', '/api/admin/categories', { name: 'Festive Wear' }, token, 201);
  const product = await call('POST', '/api/admin/products', {
    name: 'Rose occasion saree', sku: 'CAT-SAFE-1', category: source._id,
    price: 900, originalPrice: 1200, stock: 2, images: [{ url: '/uploads/saree.jpg', primary: true }],
  }, token, 201);
  const impact = await get(`/api/admin/categories/${source._id}/impact`, token);
  assert.equal(impact.productCount, 1);
  assert.equal(impact.canDelete, false);
  await call('PATCH', `/api/admin/categories/${source._id}/archive`, {}, token);
  await call('DELETE', `/api/admin/categories/${source._id}?confirm=Occasion%20Wear`, undefined, token, 409);
  const moved = await call('POST', `/api/admin/categories/${source._id}/reassign`, { targetCategoryId: target._id }, token);
  assert.equal(moved.moved.products, 1);
  assert.equal(String((await Product.findById(product._id).lean()).category), String(target._id));
  await call('DELETE', `/api/admin/categories/${source._id}?confirm=Occasion%20Wear`, undefined, token);
  assert.ok(await Product.exists({ _id: product._id, category: target._id }));
});

test('category hierarchy prevents cycles and keeps child visibility consistent with its parent', async () => {
  const { token } = await createAdmin();
  const parent = await call('POST', '/api/admin/categories', { name: 'Clothing', image: '/uploads/clothing.jpg' }, token, 201);
  const child = await call('POST', '/api/admin/categories', { name: 'Sarees', parent: parent._id, displayOrder: 7 }, token, 201);
  assert.equal(child.level, 1);
  assert.equal(String(child.parent), String(parent._id));
  await call('PUT', `/api/admin/categories/${parent._id}`, { parent: child._id }, token, 400);
  await call('PATCH', `/api/admin/categories/${parent._id}/status`, { isActive: false }, token);
  assert.equal((await get(`/api/admin/categories/${child._id}`, token)).isActive, false);
  await call('PATCH', `/api/admin/categories/${child._id}/status`, { isActive: true }, token, 400);
  await call('PUT', `/api/admin/categories/${parent._id}`, { image: '', slug: 'Clothing & Fashion' }, token);
  let updated = await get(`/api/admin/categories/${parent._id}`, token);
  assert.equal(updated.image, '/uploads/clothing.jpg');
  assert.equal(updated.slug, 'clothing-fashion');
  assert.ok(updated.previousSlugs.includes('clothing'));
  await call('PUT', `/api/admin/categories/${parent._id}`, { image: '', removeImage: true }, token);
  updated = await get(`/api/admin/categories/${parent._id}`, token);
  assert.equal(updated.image, '');
});

test('category partial edits preserve content and media until removal is explicitly requested', async () => {
  const { token } = await createAdmin();
  const category = await call('POST', '/api/admin/categories', {
    name: 'Premium Sarees',
    description: 'Original category description',
    image: '/uploads/category-main.jpg',
    socialImage: '/uploads/category-social.jpg',
    metaTitle: 'Original SEO title',
    metaDescription: 'Original SEO description',
    displayOrder: 9,
  }, token, 201);

  await call('PUT', `/api/admin/categories/${category._id}`, { name: 'Premium Silk Sarees' }, token);
  let updated = await get(`/api/admin/categories/${category._id}`, token);
  assert.equal(updated.description, 'Original category description');
  assert.equal(updated.image, '/uploads/category-main.jpg');
  assert.equal(updated.socialImage, '/uploads/category-social.jpg');
  assert.equal(updated.metaTitle, 'Original SEO title');
  assert.equal(updated.metaDescription, 'Original SEO description');
  assert.equal(updated.displayOrder, 9);

  await call('PUT', `/api/admin/categories/${category._id}`, { image: '', socialImage: '' }, token);
  updated = await get(`/api/admin/categories/${category._id}`, token);
  assert.equal(updated.image, '/uploads/category-main.jpg');
  assert.equal(updated.socialImage, '/uploads/category-social.jpg');

  await call('PUT', `/api/admin/categories/${category._id}`, { image: '', removeImage: true }, token);
  updated = await get(`/api/admin/categories/${category._id}`, token);
  assert.equal(updated.image, '');
  assert.equal(updated.socialImage, '/uploads/category-social.jpg');

  await call('PUT', `/api/admin/categories/${category._id}`, { socialImage: '', removeSocialImage: true }, token);
  updated = await get(`/api/admin/categories/${category._id}`, token);
  assert.equal(updated.socialImage, '');
});

test('banner creation, visibility-only editing, reactivation and deletion retain campaign content', async () => {
  const { token } = await createAdmin();
  const banner = await call('POST', '/api/admin/banners', { title: 'Festive Edit', subtitle: 'Celebration styles', buttonText: 'Shop now', link: '/products', image: '/uploads/banner.jpg', isActive: true }, token, 201);
  const hidden = await call('PUT', `/api/admin/banners/${banner._id}`, { isActive: false }, token);
  assert.equal(hidden.subtitle, banner.subtitle); assert.equal(hidden.buttonText, banner.buttonText); assert.equal(hidden.link, banner.link);
  assert.equal((await get('/api/admin/banners', token)).length, 1);
  assert.equal((await get('/api/banners?admin=true')).length, 0);
  await call('PUT', `/api/admin/banners/${banner._id}`, { isActive: true }, token);
  assert.equal((await get(`/api/admin/banners/${banner._id}`, token)).title, 'Festive Edit');
  assert.equal((await get('/api/banners')).length, 1);
  await call('GET', '/api/admin/banners/not-an-id', undefined, token, 400);
  await call('DELETE', `/api/admin/banners/${banner._id}`, undefined, token);
  await call('DELETE', `/api/admin/banners/${banner._id}`, undefined, token, 404);
});

test('banner schedules, safe links and engagement counters behave like real storefront campaigns', async () => {
  const { token } = await createAdmin();
  await call('POST', '/api/admin/banners', {
    title: 'Unsafe campaign', image: '/uploads/unsafe.jpg', destinationType: 'CUSTOM', link: 'javascript:alert(1)',
  }, token, 400);

  const scheduled = await call('POST', '/api/admin/banners', {
    title: 'Tomorrow campaign', image: '/uploads/tomorrow.jpg', mobileImage: '/uploads/tomorrow-mobile.jpg',
    position: 'Offer Strip', startsAt: new Date(Date.now() + 86400000).toISOString(), isActive: true,
  }, token, 201);
  assert.equal(scheduled.status, 'Scheduled');
  assert.equal((await get('/api/banners')).some((item) => item._id === scheduled._id), false);

  const live = await call('POST', '/api/admin/banners', {
    title: 'Live campaign', image: '/uploads/live.jpg', position: 'Cart - Bottom', campaignKey: 'cart-live',
    destinationType: 'COLLECTION', destinationValue: 'Wedding Edit', endsAt: new Date(Date.now() + 86400000).toISOString(), isActive: true,
  }, token, 201);
  assert.equal(live.link, '/products?collection=Wedding%20Edit');
  await call('POST', `/api/banners/${live._id}/events`, { event: 'impression', sessionId: 'campaign-session-1' }, undefined, 202);
  const duplicate = await call('POST', `/api/banners/${live._id}/events`, { event: 'impression', sessionId: 'campaign-session-1' }, undefined, 202);
  assert.equal(duplicate.duplicate, true);
  await call('POST', `/api/banners/${live._id}/events`, { event: 'click', sessionId: 'campaign-session-1' }, undefined, 202);
  const stored = await Banner.findById(live._id).lean();
  assert.equal(stored.impressions, 1);
  assert.equal(stored.clicks, 1);
});

test('seller banner management is isolated between stores', async () => {
  const sellerA = await createProvisionedSeller('Banner Store Alpha');
  const sellerB = await createProvisionedSeller('Banner Store Beta');
  const headersA = { 'x-store-id': sellerA.store.id };
  const headersB = { 'x-store-id': sellerB.store.id };
  const created = await call('POST', '/api/seller/banners', {
    title: 'Alpha home hero', image: '/uploads/alpha-hero.jpg', storeId: sellerB.store.id,
  }, sellerA.token, 201, headersA);
  assert.equal(String(created.storeId), String(sellerA.store.id));
  assert.equal((await get('/api/seller/banners', sellerA.token, headersA)).length, 1);
  assert.equal((await get('/api/seller/banners', sellerB.token, headersB)).length, 0);
  await call('GET', `/api/seller/banners/${created._id}`, undefined, sellerB.token, 404, headersB);
});

test('seller coupon targeting and option search never cross store boundaries', async () => {
  const sellerA = await createProvisionedSeller('Coupon Store Alpha');
  const sellerB = await createProvisionedSeller('Coupon Store Beta');
  await Store.updateMany({ _id: { $in: [sellerA.store.id, sellerB.store.id] } }, {
    $set: { plan: 'PREMIUM', 'license.status': 'ACTIVE' },
  });
  const headersA = { 'x-store-id': sellerA.store.id };
  const owned = await createProduct({ storeId: sellerA.store.id, name: 'Alpha Rose Saree', sku: 'ALPHA-ROSE' });
  const outsider = await createProduct({ storeId: sellerB.store.id, name: 'Beta Rose Saree', sku: 'BETA-ROSE' });

  await call('POST', '/api/seller/coupons', {
    code: 'ALPHA10', type: 'Percentage', discountValue: 10, applicableProducts: [outsider._id], isActive: true,
  }, sellerA.token, 400, headersA);
  const created = await call('POST', '/api/seller/coupons', {
    code: 'ALPHA10', type: 'Percentage', discountValue: 10, applicableProducts: [owned._id], isActive: true,
  }, sellerA.token, 201, headersA);
  assert.equal(String(created.storeId), String(sellerA.store.id));

  const options = await get('/api/seller/coupons/options?type=PRODUCT&search=rose', sellerA.token, headersA);
  assert.deepEqual(options.items.map((item) => item.id), [String(owned._id)]);
  assert.equal(options.items.some((item) => item.id === String(outsider._id)), false);
});

test('variant-group CRUD preserves membership on metadata edits and safely transfers products between groups', async () => {
  const { token } = await createAdmin();
  const first = await createProduct(), second = await createProduct(), hidden = await createProduct({ isActive: false });
  const groupA = (await call('POST', '/api/admin/variant-groups', { name: 'Color Family', productIds: [String(first._id), String(second._id), String(hidden._id)], colors: ['Rose','Wine'], sizes: ['M','L'] }, token, 201)).data;
  const renamed = (await call('PUT', `/api/admin/variant-groups/${groupA._id}`, { name: 'Premium Color Family' }, token)).data;
  assert.equal(renamed.products.length, 3); assert.deepEqual(renamed.colors, ['Red','Rose','Wine']);
  assert.equal((await get(`/api/variant-groups/${groupA._id}`)).data.products.length, 2);
  await call('POST', '/api/admin/variant-groups', { name: 'Second Family', productIds: [String(second._id)], isActive: false }, token, 409);
  const groupB = (await call('POST', '/api/admin/variant-groups', { name: 'Second Family', productIds: [String(second._id)], isActive: false, confirmTransfers: true }, token, 201)).data;
  assert.equal((await VariantGroup.findById(groupA._id)).products.some(id => String(id) === String(second._id)), false);
  await call('POST', `/api/admin/variant-groups/${groupA._id}/remove-products`, { productIds: [String(second._id)] }, token);
  assert.equal(String((await Product.findById(second._id)).variantGroupId), String(groupB._id));
  await call('POST', `/api/admin/variant-groups/${groupB._id}/add-products`, { productIds: [String(first._id)], confirmTransfers: true }, token);
  await call('POST', `/api/admin/variant-groups/${groupB._id}/remove-products`, { productIds: [String(first._id)] }, token);
  assert.equal((await Product.findById(first._id)).variantGroupId, undefined);
  await call('PUT', `/api/admin/variant-groups/${groupB._id}`, { isActive: false }, token);
  await call('GET', `/api/variant-groups/${groupB._id}`, undefined, undefined, 404);
  assert.equal((await get('/api/admin/variant-groups', token)).data.length, 2);
  assert.equal((await get('/api/variant-groups')).data.length, 0);
  await call('POST', '/api/admin/variant-groups', { name: 'Invalid', productIds: ['0123456789abcdef99999999'] }, token, 400);
  assert.equal(await VariantGroup.countDocuments({ name: 'Invalid' }), 0);
  await call('PATCH', `/api/admin/variant-groups/${groupA._id}/archive`, {}, token);
  await call('PATCH', `/api/admin/variant-groups/${groupB._id}/archive`, {}, token);
  await call('DELETE', `/api/admin/variant-groups/${groupA._id}?confirm=${encodeURIComponent(renamed.name)}`, undefined, token);
  await call('DELETE', `/api/admin/variant-groups/${groupB._id}?confirm=${encodeURIComponent(groupB.name)}`, undefined, token);
  assert.equal((await Product.findById(second._id)).variantGroupId, undefined);
});

test('variant families isolate stores, hide internal product data and reject stale edits', async () => {
  const sellerA = await createProvisionedSeller('Variant Store Alpha');
  const sellerB = await createProvisionedSeller('Variant Store Beta');
  const storeAId = sellerA.store.id || sellerA.store._id;
  const storeBId = sellerB.store.id || sellerB.store._id;
  await Store.updateMany({ _id: { $in: [storeAId, storeBId] } }, { status: 'PUBLISHED', publishedAt: new Date() });
  const first = await createProduct({ storeId: storeAId, name: 'Alpha Rose Phone', slug: 'alpha-rose-phone', sku: 'ALPHA-ROSE', colors: ['Rose'], costPrice: 400, supplierName: 'Private Supplier' });
  const second = await createProduct({ storeId: storeAId, name: 'Alpha Black Phone', slug: 'alpha-black-phone', sku: 'ALPHA-BLACK', colors: ['Black'], publishAt: new Date(Date.now() + 86400000) });
  const outsider = await createProduct({ storeId: storeBId, name: 'Beta Phone', slug: 'beta-phone', sku: 'BETA-PHONE', colors: ['Blue'] });
  const headersA = { 'x-store-id': String(storeAId) };
  const headersB = { 'x-store-id': String(storeBId) };
  await call('POST', '/api/seller/variant-groups', {
    name: 'Invalid one-choice family', baseProduct: String(first._id), productIds: [String(first._id), String(second._id)],
    optionDefinitions: [{ key: 'color', label: 'Colour', displayType: 'swatch' }],
    members: [
      { product: String(first._id), optionValues: { color: 'Rose' }, isActive: true },
      { product: String(second._id), optionValues: { color: 'Black' }, isActive: false },
    ], isActive: true,
  }, sellerA.token, 400, headersA);
  const created = (await call('POST', '/api/seller/variant-groups', {
    name: 'Alpha Phone Colours', baseProduct: String(first._id), productIds: [String(first._id), String(second._id)],
    optionDefinitions: [{ key: 'color', label: 'Colour', displayType: 'swatch' }],
    members: [
      { product: String(first._id), optionValues: { color: 'Rose' }, swatch: '#d77b91' },
      { product: String(second._id), optionValues: { color: 'Black' }, swatch: '#111111' },
    ], isActive: true,
  }, sellerA.token, 201, headersA)).data;
  assert.equal(String((await VariantGroup.findById(created._id)).storeId), String(storeAId));
  assert.equal((await call('GET', '/api/seller/variant-groups?page=1', undefined, sellerB.token, 200, headersB)).data.length, 0);
  await call('GET', `/api/seller/variant-groups/${created._id}`, undefined, sellerB.token, 404, headersB);
  await call('PUT', `/api/seller/variant-groups/${created._id}`, { ...created, productIds: [String(first._id), String(outsider._id)], baseRevision: created.revision }, sellerA.token, 400, headersA);

  const publicFamily = (await get(`/api/variant-groups/${created._id}?store=${sellerA.store.slug}`)).data;
  assert.equal(publicFamily.products.length, 1);
  assert.equal(publicFamily.products[0].name, first.name);
  assert.equal(JSON.stringify(publicFamily).includes('Private Supplier'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicFamily.products[0], 'costPrice'), false);
  await call('GET', `/api/variant-groups/${created._id}?store=${sellerB.store.slug}`, undefined, undefined, 404);

  const renamed = (await call('PUT', `/api/seller/variant-groups/${created._id}`, {
    name: 'Alpha Premium Colours', baseProduct: String(first._id), productIds: [String(first._id), String(second._id)],
    optionDefinitions: created.optionDefinitions, members: created.members.map((member) => ({ product: member.productId, optionValues: member.optionValues, swatch: member.swatch })),
    isActive: true, baseRevision: created.revision,
  }, sellerA.token, 200, headersA)).data;
  assert.equal((await Product.findById(first._id)).variantName, 'Rose');
  await call('PUT', `/api/seller/variant-groups/${created._id}`, { name: 'Stale overwrite', baseRevision: created.revision }, sellerA.token, 409, headersA);
  await call('DELETE', `/api/seller/variant-groups/${created._id}?confirm=${encodeURIComponent(renamed.name)}`, undefined, sellerA.token, 400, headersA);
  await call('PATCH', `/api/seller/variant-groups/${created._id}/archive`, {}, sellerA.token, 200, headersA);
  await call('GET', `/api/variant-groups/${created._id}?store=${sellerA.store.slug}`, undefined, undefined, 404);
  await Product.updateOne({ _id: first._id }, { isArchived: true });
  const restored = (await call('PATCH', `/api/seller/variant-groups/${created._id}/restore`, {}, sellerA.token, 200, headersA)).data;
  assert.equal(String(restored.baseProduct._id), String(second._id));
  assert.equal(restored.isActive, false);
  await call('PATCH', `/api/seller/variant-groups/${created._id}/archive`, {}, sellerA.token, 200, headersA);
  await call('DELETE', `/api/seller/variant-groups/${created._id}?confirm=wrong`, undefined, sellerA.token, 400, headersA);
  await call('DELETE', `/api/seller/variant-groups/${created._id}?confirm=${encodeURIComponent(renamed.name)}`, undefined, sellerA.token, 200, headersA);
  assert.ok(await Product.exists({ _id: first._id }));
});

test('customer journey logs in, edits addresses, purchases, follows fulfilment, reviews and returns the item', async () => {
  const customer = await createCustomer({ phone: '9123456789' });
  const admin = await createAdmin(); const product = await createProduct({ stock: 7 });
  await call('POST', '/api/auth/send-otp', { phone: customer.user.phone });
  const login = await call('POST', '/api/auth/verify-otp', { phone: customer.user.phone, otp: '123456' });
  const token = login.token;
  assert.equal((await get('/api/auth/me', token)).phone, customer.user.phone);
  const refreshed = await call('POST', '/api/auth/refresh', { refreshToken: login.refreshToken });
  assert.ok(refreshed.token);
  let addresses = await call('POST', '/api/user/addresses', validAddress({ mobile: customer.user.phone }), token, 201);
  const firstAddressId = addresses[0]._id;
  addresses = await call('POST', '/api/user/addresses', validAddress({ mobile: customer.user.phone, addressType: 'Work', houseNo: 'Office 4' }), token, 201);
  const secondAddressId = addresses[1]._id;
  await call('PATCH', `/api/user/addresses/${secondAddressId}/default`, {}, token);
  await call('PUT', `/api/user/addresses/${secondAddressId}`, { ...addresses[1], houseNo: 'Office 8', isDefault: true }, token);
  await call('DELETE', `/api/user/addresses/${firstAddressId}`, undefined, token);
  addresses = await get('/api/user/addresses', token); assert.equal(addresses[0].houseNo, 'Office 8'); assert.equal(addresses[0].isDefault, true);
  await call('POST', `/api/wishlist/${product._id}`, {}, token);
  assert.equal((await get('/api/wishlist', token)).length, 1);
  const bag = await call('POST', '/api/cart', { product: String(product._id), size: 'M', color: 'Red', quantity: 1 }, token, 201);
  await call('POST', '/api/cart/selection', { itemIds: [bag.items[0]._id], selected: false }, token);
  assert.equal((await get('/api/cart', token)).items[0].selected, false);
  await call('POST', '/api/cart/selection', { itemIds: [bag.items[0]._id], selected: true }, token);
  assert.equal((await call('POST', '/api/wishlist/resolve', { ids: [String(product._id)] }))[0]._id, String(product._id));
  await call('PUT', `/api/cart/${bag.items[0]._id}`, { quantity: 2 }, token);
  const quote = await call('POST', '/api/orders/quote', { orderItems: [{ product: String(product._id), quantity: 2, size: 'M', color: 'Red' }], shippingAddress: addresses[0], paymentMethod: 'COD' }, token);
  const order = await call('POST', '/api/orders', { orderItems: [{ product: String(product._id), quantity: 2, size: 'M', color: 'Red' }], shippingAddress: addresses[0], paymentMethod: 'COD' }, token, 201);
  assert.equal(order.finalAmount, quote.totals.finalAmount);
  await call('POST', '/api/cart/remove-items', { itemIds: [bag.items[0]._id] }, token);
  await call('DELETE', `/api/wishlist/${product._id}`, undefined, token);
  for (const orderStatus of ['Confirmed', 'Packed']) await call('PUT', `/api/admin/orders/${order._id}/status`, { orderStatus }, admin.token);
  await call('PUT', `/api/admin/orders/${order._id}/shipment`, { courierName: 'Fixture Courier', trackingNumber: 'CUSTOMER-JOURNEY-001', trackingUrl: 'https://example.test/tracking/CUSTOMER-JOURNEY-001' }, admin.token);
  for (const orderStatus of ['Shipped', 'Out for Delivery', 'Delivered']) await call('PUT', `/api/admin/orders/${order._id}/status`, { orderStatus }, admin.token);
  await call('PUT', `/api/admin/orders/${order._id}/payment-status`, { paymentStatus: 'Paid', note: 'COD collected during delivery' }, admin.token);
  const detail = await get(`/api/orders/${order._id}`, token); assert.equal(detail.orderStatus, 'Delivered');
  assert.equal((await get('/api/orders/my-orders', token)).length, 1);
  assert.equal((await get(`/api/orders/${order._id}/receipt`, token)).finalAmount, order.finalAmount);
  const review = await call('POST', `/api/reviews/${product._id}`, { rating: 5, title: 'Lovely', comment: 'Good quality and the size fits well.' }, token, 201);
  assert.equal((await get(`/api/reviews/${product._id}/mine`, token)).rating, 5);
  await call('PUT', `/api/reviews/${review._id}`, { rating: 4, title: 'Great', comment: 'Updated review after wearing the product.' }, token);
  assert.equal((await get('/api/reviews/featured')).length, 1);
  assert.equal((await get('/api/admin/reviews', admin.token)).length, 1);
  await call('PATCH', `/api/admin/reviews/${review._id}/visibility`, { isVisible: false }, admin.token);
  assert.equal((await get('/api/reviews/featured')).length, 0);
  await call('PATCH', `/api/admin/reviews/${review._id}/visibility`, { isVisible: true }, admin.token);
  await call('PATCH', `/api/admin/reviews/management/${review._id}/archive`, { reason: 'Customer journey cleanup' }, admin.token);
  await call('DELETE', `/api/admin/reviews/management/${review._id}?confirm=PERMANENTLY_DELETE`, undefined, admin.token);
  assert.equal((await Product.findById(product._id)).numReviews, 0);
  const returns = await call('POST', '/api/returns', { order: order._id, product: String(product._id), orderItemId: order.orderItems[0]._id, quantity: 1, type: 'return', reason: 'Size issue' }, token, 201);
  assert.equal((await get('/api/admin/returns', admin.token)).length, 1);
  assert.equal((await get(`/api/returns/order/${order._id}`, token)).requests.length, 1);
  for (const body of [{status:'Approved'},{status:'Pickup Scheduled'},{status:'Received'},{status:'QC Passed',inventoryDisposition:'RESTOCK',receivedQuantity:1,qcNotes:'Sellable fixture return'},{status:'Refund Initiated',refundAmount:500},{status:'Refunded',refundAmount:500,refundReference:'workflow-refund-001'},{status:'Closed'}]) await call('PUT', `/api/admin/returns/${returns._id}/status`, body, admin.token);
  assert.equal((await Product.findById(product._id)).stock, 6);
  assert.equal((await get('/api/returns/my-requests', token)).length, 1);
  const notifications = await get('/api/notifications', token); assert.ok(notifications.length > 0);
  await call('PATCH', `/api/notifications/${notifications[0]._id}/read`, { read: true }, token);
  await call('PATCH', `/api/notifications/${notifications[0]._id}/read`, { read: false }, token);
  await call('PATCH', '/api/notifications/read-all', {}, token);
  assert.equal((await get('/api/notifications/summary', token)).unreadCount, 0);
  const replacement = await call('POST', '/api/cart', { product: String(product._id), size: 'M', color: 'Red', quantity: 1 }, token, 201);
  await call('DELETE', `/api/cart/${replacement.items[0]._id}`, undefined, token);
  await call('DELETE', '/api/cart', undefined, token);
  assert.equal((await get('/api/cart', token)).items.length, 0);
  await call('POST', '/api/auth/logout', {}, token);
  await call('GET', '/api/auth/me', undefined, token, 401);
  await call('POST', '/api/auth/refresh', { refreshToken: login.refreshToken }, undefined, 401);
});

test('support and newsletter actions persist and the seller inbox closes a conversation without external delivery', async () => {
  const seller = await createProvisionedSeller('Workflow Boutique');
  await Store.updateOne({ _id: seller.store.id }, { status: 'PUBLISHED' });
  const headers = { 'x-store-id': seller.store.id };
  const customer = await createCustomer(); const admin = await createAdmin();
  const created = await call('POST', `/api/contact?store=${seller.store.slug}`, { name: 'Workflow Customer', email: customer.user.email, phone: customer.user.phone, subject: 'Sizing help', message: 'Please help me choose the correct product size.' }, customer.token, 201);
  const inbox = await get('/api/seller/inbox', seller.token, headers); assert.equal(inbox.length, 1);
  const opened = await get(`/api/seller/inbox/${inbox[0]._id}`, seller.token, headers); assert.equal(opened.messages.length, 1);
  await call('POST', `/api/seller/inbox/${inbox[0]._id}/reply`, { body: 'This is a stored fixture reply only.', status: 'PENDING' }, seller.token, 201, headers);
  await call('PUT', `/api/seller/inbox/${inbox[0]._id}/status`, { status: 'RESOLVED' }, seller.token, 200, headers);
  assert.equal((await get(`/api/seller/inbox/${inbox[0]._id}`, seller.token, headers)).messages.length, 2);
  await call('PUT', `/api/admin/contact/${created.id}/status`, { status: 'CLOSED', adminNote: 'Handled in fixture inbox' }, admin.token);
  assert.equal((await get('/api/admin/contact?status=CLOSED', admin.token)).length, 1);
  await call('POST', '/api/newsletter/subscribe', { email: ' workflow@isolated.test ' }, undefined, 201);
  await call('POST', '/api/newsletter/unsubscribe', { email: 'workflow@isolated.test' });
  assert.equal((await Subscriber.findOne({ email: 'workflow@isolated.test' })).isActive, false);
  await call('POST', '/api/newsletter/subscribe', { email: 'workflow@isolated.test' });
  assert.equal((await Subscriber.findOne({ email: 'workflow@isolated.test' })).isActive, true);
  assert.equal((await get('/api/admin/newsletter', admin.token)).length, 1);
});

test('master configuration round-trips a template, custom preset and locked state through guarded APIs', async () => {
  const master = await createMasterOwner(); const admin = await createAdmin();
  const workspace = await get('/api/master', master.token);
  const configuration = workspace.configuration.locked
    ? await call('PUT', '/api/master/configuration', { revision: workspace.configuration.revision, locked: false }, master.token)
    : workspace.configuration;
  const exported = await get('/api/master/export', master.token);
  assert.equal(exported.format, 'samira-store-template');
  const preset = await call('POST', '/api/master/presets', { name: 'Workflow Template', structure: exported.structure }, master.token, 201);
  const imported = await call('POST', '/api/master/import', { template: exported, revision: configuration.revision }, master.token);
  const locked = await call('PUT', '/api/master/configuration', { revision: imported.revision, locked: true }, master.token);
  assert.equal(locked.locked, true);
  await call('POST', '/api/master/import', { template: exported, revision: locked.revision }, master.token, 403);
  await call('PUT', '/api/master/configuration', { revision: locked.revision, locked: false }, master.token);
  await call('DELETE', `/api/master/presets/${preset._id}`, undefined, master.token);
  await call('GET', '/api/master', undefined, admin.token, 403);
  const settings = await get('/api/admin/settings', master.token);
  await call('PUT', '/api/admin/settings', { ...settings, storeName: 'Workflow Collection', deliveryCharge: 55 }, master.token);
  assert.equal((await get('/api/settings')).deliveryCharge, 55);
  assert.ok((await get('/api/catalog-configuration')).industry);
  assert.equal((await readConfiguration()).locked, false);
});

test('profile phone and email OTP verification persists edits, rejects reused identities and allows account deletion', async () => {
  const customer = await createCustomer();
  const token = customer.token;
  const nextPhone = '9123456790', nextEmail = 'updated@workflow.test';
  await call('POST', '/api/auth/profile/send-phone-change-otp', { phone: nextPhone }, token);
  const phone = await call('POST', '/api/auth/profile/verify-phone-change-otp', { phone: nextPhone, otp: '123456' }, token);
  const emailSent = await call('POST', '/api/auth/profile/send-email-change-otp', { email: nextEmail }, token);
  const email = await call('POST', '/api/auth/profile/verify-email-change-otp', { email: nextEmail, otp: emailSent.demoOtp || emailSent.devOtp }, token);
  const updated = await call('PUT', '/api/auth/profile', { name: 'Updated Customer', phone: nextPhone, email: nextEmail, phoneVerificationToken: phone.verificationToken, emailVerificationToken: email.verificationToken, alternatePhone: '9123456789', gender: 'female', birthDate: '1995-03-14', hintName: 'Near park' }, token);
  assert.equal(updated.phone, nextPhone); assert.equal(updated.email, nextEmail); assert.equal(updated.isEmailVerified, true);
  assert.equal((await get('/api/auth/profile', token)).alternatePhone, '9123456789');
  const stranger = await createCustomer();
  await call('POST', '/api/auth/profile/send-phone-change-otp', { phone: nextPhone }, stranger.token, 400);
  await call('POST', '/api/auth/profile/send-email-change-otp', { email: nextEmail }, stranger.token, 400);
  await call('DELETE', '/api/auth/profile', undefined, token);
  await call('GET', '/api/auth/me', undefined, token, 401);
});

test('seller CRM, campaign analytics, manual shipment and reports agree with its purchased order', async () => {
  const seller = await createProvisionedSeller('Commerce Workflow');
  await Store.updateOne({ _id: seller.store.id }, { status: 'PUBLISHED' });
  const headers = { 'x-store-id': seller.store.id };
  const storefrontHeaders = { 'x-store-slug': seller.store.slug };
  const customer = await createCustomer();
  const product = await createProduct({ storeId: seller.store.id, stock: 8 });
  assert.equal((await get('/api/stores', seller.token)).length, 1);
  assert.ok(await get('/api/stores/me/current', seller.token, headers));
  assert.equal((await get(`/api/stores/${seller.store.slug}`)).slug, seller.store.slug);
  assert.ok(await get('/api/seller/audit-logs/options', seller.token, headers));
  assert.equal((await get('/api/seller/instagram', seller.token, headers)).status, 'DISCONNECTED');
  assert.equal((await call('POST', '/api/seller/instagram', { username: 'fixture-boutique' }, seller.token, 200, headers)).status, 'DISCONNECTED');
  const callback = await fetch(`${getBaseUrl()}/api/instagram/oauth/callback`, { redirect: 'manual' });
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get('location'), /\/seller\/instagram\?ig=error$/);
  for (const name of ['STORE_VIEW','PRODUCT_VIEW','ADD_TO_CART','BEGIN_CHECKOUT']) await call('POST', `/api/analytics/events?store=${seller.store.slug}`, { name, productId: String(product._id), sessionId: 'workflow-analytics-session', source: 'instagram', campaign: 'workflow-launch' }, customer.token, 202);
  const order = await call('POST', '/api/orders/cod', { orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }], shippingAddress: validAddress(), paymentMethod: 'COD', attribution: { source: 'instagram', campaign: 'workflow-launch' } }, customer.token, 201, storefrontHeaders);
  assert.equal((await get('/api/seller/inventory/history', seller.token, headers)).items[0].type, 'SALE');
  assert.equal((await get('/api/seller/orders', seller.token, headers)).length, 1);
  assert.equal((await get(`/api/seller/orders/${order._id}`, seller.token, headers))._id, order._id);
  for (const orderStatus of ['Confirmed', 'Packed']) await call('PUT', `/api/seller/orders/${order._id}/status`, { orderStatus }, seller.token, 200, headers);
  const shipment = await call('PUT', `/api/seller/orders/${order._id}/shipment`, { courierName: 'Fixture Courier', trackingNumber: 'FIXTURE-001', trackingUrl: 'https://example.test/tracking/FIXTURE-001' }, seller.token, 200, headers);
  assert.equal(shipment.trackingNumber, 'FIXTURE-001');
  const updated = await call('PUT', `/api/seller/crm/${customer.user._id}`, { tags: ['VIP'], notes: 'Fixture customer sizing preference', acquisition: 'Instagram', marketingConsent: true }, seller.token, 200, headers);
  assert.deepEqual(updated.tags, ['VIP']);
  assert.equal(updated.marketingConsent, true);
  const crm = await get('/api/seller/crm', seller.token, headers); assert.equal(crm.length, 1); assert.equal(crm[0].notes, updated.notes); assert.equal(crm[0].marketingConsent, true);
  const whatsapp = await call('POST', '/api/seller/business/customer-offers', { customerIds: [String(customer.user._id)], channel: 'WHATSAPP_LINK', title: 'Review before sending' }, seller.token, 200, headers);
  assert.equal(whatsapp.requiresReview, true); assert.equal(whatsapp.prepared, 1); assert.match(whatsapp.items[0].url, /^https:\/\/wa\.me\//);
  const whatsappDuplicate = await call('POST', '/api/seller/business/customer-offers', { customerIds: [String(customer.user._id)], channel: 'WHATSAPP_LINK', title: 'Review before sending' }, seller.token, 200, headers);
  assert.equal(whatsappDuplicate.prepared, 0); assert.equal(whatsappDuplicate.skipped, 1);
  const offer = await call('POST', '/api/seller/business/customer-offers', { customerIds: [String(customer.user._id)], channel: 'IN_APP', title: 'A private offer', message: 'Thank you for shopping with us.' }, seller.token, 200, headers);
  assert.equal(offer.sent, 1);
  assert.equal((await get('/api/notifications', customer.token)).some((item) => item.event === 'CRM_OFFER'), true);
  assert.equal((await call('POST', '/api/seller/business/customer-offers', { customerIds: [String(customer.user._id)], channel: 'IN_APP', title: 'A private offer' }, seller.token, 200, headers)).skipped, 1);
  const funnel = await get('/api/seller/analytics/funnel?range=30d', seller.token, headers);
  assert.equal(funnel.events.PRODUCT_VIEW, 1); assert.equal(funnel.attributedSales[0].revenue, order.finalAmount);
  const sales = await get('/api/seller/reports/sales?range=30d', seller.token, headers); assert.equal(sales.totals.orders, 1);
  const productReport = await get('/api/seller/reports/products?range=30d', seller.token, headers); assert.equal(productReport.bestSellers[0].sold, 1);
  assert.ok(await get('/api/seller/dashboard/stats', seller.token, headers));
  const other = await createProvisionedSeller('Unrelated Workflow');
  await call('GET', `/api/seller/orders/${order._id}`, undefined, other.token, 404, { 'x-store-id': other.store.id });
  for (const orderStatus of ['Shipped', 'Out for Delivery', 'Delivered']) await call('PUT', `/api/seller/orders/${order._id}/status`, { orderStatus }, seller.token, 200, headers);
  const returnRequest = await call('POST','/api/returns',{order:order._id,product:String(product._id),quantity:1,type:'return',reason:'Fixture return'},customer.token,201,storefrontHeaders);
  assert.equal((await get('/api/seller/returns',seller.token,headers)).length,1);
  await call('PUT',`/api/seller/returns/${returnRequest._id}/status`,{status:'Approved'},other.token,404,{'x-store-id':other.store.id});
  assert.equal((await Product.findById(product._id)).stock,7);
  await call('PUT',`/api/seller/returns/${returnRequest._id}/status`,{status:'Approved'},seller.token,200,headers);
  await call('PUT',`/api/seller/returns/${returnRequest._id}/status`,{status:'Received'},seller.token,200,headers);
  await call('PUT',`/api/seller/returns/${returnRequest._id}/status`,{status:'QC Passed',inventoryDisposition:'RESTOCK',receivedQuantity:1,qcNotes:'Sellable fixture return'},seller.token,200,headers);
  assert.equal((await Product.findById(product._id)).stock,8);
});

test('business center isolates abandoned carts, limits reminders, answers from live data and publishes campaign settings', async () => {
  const seller = await createProvisionedSeller('Business Center Workflow');
  const other = await createProvisionedSeller('Other Business Center Workflow');
  await Store.updateOne({ _id: seller.store.id }, {
    status: 'PUBLISHED', plan: 'PREMIUM', 'license.status': 'ACTIVE', logo: '/uploads/store-logo.jpg',
    whatsappNumber: '9123456789', paymentReady: true, shippingReady: true,
    pickupAddress: { fullName: 'Seller', mobile: '9123456789', pincode: '176001', city: 'Kangra', state: 'Himachal Pradesh', houseNo: '1', area: 'Market' },
  });
  const product = await createProduct({ storeId: seller.store.id, stock: 8, name: 'Recovery Workflow Product' });
  await Coupon.create({ storeId: seller.store.id, code: 'EVERGREEN10', type: 'Percentage', discountValue: 10, isActive: true });
  const customer = await createCustomer({ phone: '9234567890' });
  const olderOrder = await Order.create({
    storeId: seller.store.id, user: customer.user._id,
    orderItems: [{ product: product._id, name: product.name, quantity: 1, price: 400 }],
    finalAmount: 400, paymentStatus: 'Paid', paymentState: 'PAID', orderStatus: 'Delivered',
  });
  await Order.collection.updateOne({ _id: olderOrder._id }, { $set: { createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } });
  const recentOrder = await Order.create({
    storeId: seller.store.id, user: customer.user._id,
    orderItems: [{ product: product._id, name: product.name, quantity: 1, price: 800 }],
    finalAmount: 800, paymentStatus: 'Paid', paymentState: 'PAID', orderStatus: 'Delivered',
  });
  await Order.collection.updateOne({ _id: recentOrder._id }, { $set: { createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } });
  const bag = await call('POST', '/api/cart', { product: String(product._id), size: 'M', color: 'Red', quantity: 2 }, customer.token, 201, { 'x-store-slug': seller.store.slug });
  await Cart.updateOne({ _id: bag._id }, { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } }, { timestamps: false });
  const headers = { 'x-store-id': seller.store.id };
  const otherHeaders = { 'x-store-id': other.store.id };

  const settings = await get('/api/seller/settings', seller.token, headers);
  const savedSettings = await call('PUT', '/api/seller/settings', {
    storeName: 'Business Center Shop',
    brandIdentityEnabled: true,
    logoUrl: '/uploads/store-logo.jpg',
    deliveryCharge: 77,
    expectedUpdatedAt: new Date(settings.updatedAt).toISOString(),
  }, seller.token, 200, headers);
  assert.equal(savedSettings.storeId, seller.store.id);
  assert.equal((await get('/api/seller/settings', other.token, otherHeaders)).storeName, 'Samira Collection');
  assert.equal((await get(`/api/settings/payment-methods?store=${seller.store.slug}`)).deliveryCharge, 77);
  const storefrontConfig = await get(`/api/website-config?store=${seller.store.slug}`);
  assert.equal(storefrontConfig.config.branding.websiteName, 'Business Center Shop');
  assert.equal(storefrontConfig.config.branding.logo, '/uploads/store-logo.jpg');
  const design = await get('/api/seller/design', seller.token, headers);
  design.draftConfig.colors.primary = '#123456';
  const savedDesign = await call('PUT', '/api/seller/design', { config: design.draftConfig, expectedRevision: design.revision }, seller.token, 200, headers);
  await call('POST', '/api/seller/design/publish', { expectedRevision: savedDesign.revision }, seller.token, 200, headers);
  assert.equal((await get(`/api/website-config?store=${seller.store.slug}`)).config.colors.primary, '#123456');
  assert.notEqual((await get('/api/seller/design', other.token, otherHeaders)).draftConfig.colors.primary, '#123456');

  const overview = await get('/api/seller/business/overview', seller.token, headers);
  assert.equal(overview.store.id, seller.store.id);
  assert.equal(overview.platform.id, 'PREMIUM');
  assert.equal(overview.health.metrics.abandonedCarts, 1);
  assert.equal(overview.health.activeCoupons.some((coupon) => coupon.code === 'EVERGREEN10'), true);
  assert.equal(overview.health.performance.current.orders, 2);
  assert.equal(overview.health.performance.current.paidRevenue, 1200);
  assert.equal(overview.health.period.key, '30d');
  assert.equal(overview.health.priorities.some((item) => item.id === 'inventory'), true);
  const sevenDays = await get('/api/seller/business/overview?range=7d', seller.token, headers);
  assert.equal(sevenDays.health.performance.current.orders, 1);
  assert.equal(sevenDays.health.performance.previous.orders, 1);
  assert.equal(sevenDays.health.performance.change.paidRevenue, 100);
  const abandoned = await get('/api/seller/business/abandoned-carts', seller.token, headers);
  assert.equal(abandoned.total, 1);
  assert.equal(abandoned.items[0].items[0].productId, String(product._id));
  assert.equal((await get('/api/seller/business/abandoned-carts', other.token, otherHeaders)).total, 0);

  const reminder = await call('POST', `/api/seller/business/abandoned-carts/${bag._id}/reminder`, { channel: 'IN_APP' }, seller.token, 200, headers);
  assert.equal(reminder.sent, true);
  assert.equal(await Notification.countDocuments({ storeId: seller.store.id, event: 'ABANDONED_CART_REMINDER' }), 1);
  await call('POST', `/api/seller/business/abandoned-carts/${bag._id}/reminder`, { channel: 'IN_APP' }, seller.token, 409, headers);

  await Order.create({
    storeId: seller.store.id, user: customer.user._id,
    orderItems: [{ product: product._id, name: product.name, quantity: 1, price: 900 }],
    finalAmount: 900, paymentStatus: 'Paid', paymentState: 'PAID', orderStatus: 'Confirmed',
    attribution: { campaign: 'diwali' },
  });
  const recovered = await get('/api/seller/business/overview?range=7d', seller.token, headers);
  assert.equal(recovered.health.recovery.remindersSent, 1);
  assert.equal(recovered.health.recovery.recoveredOrders, 1);
  assert.equal(recovered.health.recovery.recoveredRevenue, 900);

  const assistant = await call('POST', '/api/seller/business/assistant', { question: 'What should I restock?' }, seller.token, 200, headers);
  assert.equal(assistant.source, 'live_store_data');
  assert.equal(assistant.facts.activeProducts, 1);
  assert.equal((await get('/api/seller/business/overview', seller.token, headers)).health.assistantHistory[0].question, 'What should I restock?');
  const endsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const campaign = await call('PUT', '/api/seller/business/festival', { enabled: true, preset: 'diwali', title: 'Diwali edit is live', badgeText: 'Festive offer', countdownEndsAt: endsAt, effects: true }, seller.token, 200, headers);
  assert.equal(campaign.enabled, true);
  assert.equal(campaign.campaignKey, 'diwali');
  assert.equal((await get(`/api/stores/${seller.store.slug}`)).festivalCampaign.title, 'Diwali edit is live');
  assert.equal((await get('/api/seller/business/overview?range=7d', seller.token, headers)).health.campaign.orders, 1);
});

test('storefront catalog scope honors query and header navigation and never exposes hidden products', async () => {
  const main = await createProduct({ name: 'Main Workflow Saree' });
  const hidden = await createProduct({ name: 'Hidden Workflow Saree', isActive: false });
  const seller = await createProvisionedSeller('Scoped Workflow');
  const unpublished = await createProvisionedSeller('Not Published Workflow');
  await Store.updateOne({ _id: seller.store.id }, { status: 'PUBLISHED' });
  const sellerProduct = await createProduct({ storeId: seller.store.id, name: 'Scoped Workflow Saree' });
  const queryResult = await get(`/api/products?store=${seller.store.slug}`);
  const headerResult = await get('/api/products', undefined, { 'x-store-slug': seller.store.slug });
  assert.deepEqual(queryResult.map(p => p._id), [String(sellerProduct._id)]);
  assert.deepEqual(headerResult.map(p => p._id), [String(sellerProduct._id)]);
  assert.equal((await get('/api/products?admin=true')).some(p => p._id === String(hidden._id)), false);
  assert.equal((await get('/api/products?search=%5B')).length, 0);
  await call('GET', `/api/products/${hidden.slug}`, undefined, undefined, 404);
  await call('GET', `/api/products/${main.slug}?store=${seller.store.slug}`, undefined, undefined, 404);
  for (const endpoint of ['products','categories','banners']) {
    await call('GET', `/api/${endpoint}?store=${unpublished.store.slug}`, undefined, undefined, 404);
    await call('GET', `/api/${endpoint}`, undefined, undefined, 404, { 'x-store-slug': 'missing-workflow-store' });
  }
});

test('admin catalog editing, inventory actions, coupon lifecycle and dashboard all use persisted records', async () => {
  const admin = await createAdmin(); const customer = await createCustomer();
  const category = await call('POST', '/api/admin/categories', { name: 'Sarees', slug: 'workflow-sarees' }, admin.token, 201);
  const product = await call('POST', '/api/admin/products', { name: 'Workflow Silk Saree', sku: 'WORKFLOW-CRUD-1', category: category._id, price: 1000, originalPrice: 1600, stock: 5, images: [{ url: '/uploads/test.jpg', primary: true }], colors: ['Rose'], sizingMode: 'auto' }, admin.token, 201);
  const openingHistory = await get(`/api/admin/inventory/history?product=${product._id}&type=IMPORT`, admin.token);
  assert.equal(openingHistory.items.length, 1);
  assert.equal(openingHistory.items[0].stockBefore, 0);
  assert.equal(openingHistory.items[0].stockAfter, 5);
  await Product.updateOne({ _id: product._id }, { $unset: { inventoryRevision: 1 } });
  const saved = await call('PUT', `/api/admin/products/${product._id}`, { ...product, name: 'Edited Workflow Silk Saree', description: 'Updated catalog details.' }, admin.token);
  assert.equal(saved.name, 'Edited Workflow Silk Saree');
  assert.equal((await get(`/api/admin/products/${product._id}`, admin.token)).description, 'Updated catalog details.');
  await call('PATCH', `/api/admin/products/${product._id}/stock`, { stock: 3 }, admin.token);
  const inventoryHistory = await get('/api/admin/inventory/history?limit=10', admin.token);
  assert.equal(inventoryHistory.items[0].type, 'MANUAL_ADJUSTMENT');
  assert.equal(inventoryHistory.items[0].stockAfter, 3);
  assert.equal((await get('/api/admin/inventory/low-stock', admin.token)).length, 1);
  await call('PATCH', `/api/admin/products/${product._id}/mark-out-of-stock`, { confirm: true }, admin.token);
  assert.equal((await get(`/api/products/${saved.slug}`)).stock, 0);
  await call('PATCH', `/api/admin/products/${product._id}/stock`, { stock: 5 }, admin.token);
  await call('PATCH', `/api/admin/products/${product._id}/hide`, {}, admin.token);
  await call('GET', `/api/products/${saved.slug}`, undefined, undefined, 404);
  await call('PATCH', `/api/admin/products/${product._id}/status`, { isActive: true }, admin.token);
  const coupon = await call('POST', '/api/admin/coupons', { code: 'WORKFLOW50', type: 'Flat', discountValue: 50, minOrderAmount: 500, expiryDate: new Date(Date.now()+86400000).toISOString(), isActive: true, isPublic: true }, admin.token, 201);
  const updated = await call('PUT', `/api/admin/coupons/${coupon._id}`, { ...coupon, discountValue: 75 }, admin.token);
  assert.equal(updated.discountValue, 75);
  assert.equal((await get('/api/admin/coupons', admin.token)).length, 1);
  assert.equal((await call('POST', '/api/coupons/available', { cartTotal: 1000, paymentMethod: 'COD' }, customer.token)).bestCouponCode, coupon.code);
  assert.equal((await call('POST', '/api/coupons/apply', { code: coupon.code, cartTotal: 1000, paymentMethod: 'COD' }, customer.token)).discountAmount, 75);
  const order = await call('POST', '/api/orders/cod', { orderItems: [{ product: product._id, quantity: 1, color: 'Rose' }], coupon: { code: coupon.code }, shippingAddress: validAddress(), paymentMethod: 'COD' }, customer.token, 201);
  assert.equal(order.couponDiscount, 75);
  const automatic = await call('POST', '/api/admin/coupons', { code: 'AUTO-BUY-ONE', activationMode: 'AUTOMATIC', benefitType: 'BUY_X_GET_Y', type: 'Flat', discountValue: 0, buyQuantity: 1, getQuantity: 1, applicableProducts: [product._id], expiryDate: new Date(Date.now()+86400000).toISOString(), isActive: true, isPublic: true }, admin.token, 201);
  const automaticQuote = await call('POST', '/api/orders/quote', { orderItems: [{ product: product._id, quantity: 2, color: 'Rose' }], shippingAddress: validAddress(), paymentMethod: 'COD' }, customer.token);
  assert.equal(automaticQuote.totals.coupon.code, 'AUTO-BUY-ONE');
  assert.equal(automaticQuote.totals.couponDiscount, 1000);
  await call('DELETE', `/api/admin/coupons/${automatic._id}`, undefined, admin.token);
  await Order.updateOne({ _id: order._id }, { $set: { orderStatus: 'Delivered', deliveredAt: new Date() } });
  await call('PUT', `/api/admin/orders/${order._id}/payment-status`, { paymentStatus: 'Paid', note: 'COD received for workflow test' }, admin.token);
  const stats = await get('/api/admin/dashboard/stats', admin.token); assert.equal(stats.orders, 1); assert.equal(stats.revenue, order.finalAmount);
  assert.ok(await get('/api/admin/dashboard/overview', admin.token));
  assert.equal((await get('/api/admin/dashboard/recent-orders', admin.token)).length, 1);
  assert.equal((await call('DELETE', `/api/admin/coupons/${coupon._id}`, undefined, admin.token)).archived, true);
  assert.equal((await get('/api/coupons')).length, 0);
  await call('DELETE', `/api/admin/products/${product._id}`, undefined, admin.token);
  assert.equal((await Product.findById(product._id)).isArchived, true);
  assert.equal((await get(`/api/orders/${order._id}`, customer.token)).orderItems[0].name, saved.name);
  await call('DELETE', '/api/admin/products/malformed-id', undefined, admin.token, 400);
});

test('store content edits update published wording and reject stale saves without changing layout', async () => {
  const master = await createMasterOwner();
  await get('/api/admin/customization', master.token);
  const current = await get('/api/admin/store-content', master.token);
  assert.equal(current.available, true);
  const before = await get('/api/website-config');
  const saved = await call('PUT', '/api/admin/store-content', { revision: current.revision, content: { ...current.content, websiteName: 'Workflow Collection' }, sections: current.sections }, master.token);
  assert.ok(saved.revision);
  const published = await get('/api/website-config');
  assert.equal(published.config.branding.websiteName, 'Workflow Collection');
  assert.deepEqual(published.config.colors, before.config.colors);
  await call('PUT', '/api/admin/store-content', { revision: current.revision, content: current.content, sections: current.sections }, master.token, 409);
});

test('content studio drafts, reviews, publishes and restores wording without replacing design data', async () => {
  const master = await createMasterOwner();
  await get('/api/admin/customization', master.token);
  const initial = await get('/api/admin/store-content', master.token);
  const publicBefore = await get('/api/website-config');
  const draftContent = structuredClone(initial.draft);
  draftContent.sections[0].heading = 'Content Studio festive edit';

  const draftSaved = await call('PUT', '/api/admin/store-content/draft', { revision: initial.revision, content: draftContent }, master.token);
  assert.equal((await get('/api/website-config')).config.homepage.sections[0].heading, publicBefore.config.homepage.sections[0].heading);
  const review = await call('POST', '/api/admin/store-content/preflight', { revision: draftSaved.revision, content: draftContent }, master.token);
  assert.ok(review.changes.some((item) => item.path === 'sections.hero.heading'));
  await call('POST', '/api/admin/store-content/preflight', { revision: draftSaved.revision, content: { ...draftContent, colors: { primary: '#000000' } } }, master.token, 403);

  const published = await call('POST', '/api/admin/store-content/publish', { revision: draftSaved.revision, content: draftContent, note: 'Festive copy release' }, master.token);
  assert.equal(published.version, 2);
  const publicAfter = await get('/api/website-config');
  assert.equal(publicAfter.config.homepage.sections[0].heading, 'Content Studio festive edit');
  assert.deepEqual(publicAfter.config.colors, publicBefore.config.colors);
  assert.deepEqual(publicAfter.config.homepage.sectionProductIds, publicBefore.config.homepage.sectionProductIds);

  const versions = await get('/api/admin/store-content/history', master.token);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].note, 'Festive copy release');
  assert.equal(versions[1].kind, 'BASELINE');
  const latest = await get('/api/admin/store-content', master.token);
  const changedAgain = structuredClone(latest.draft);
  changedAgain.sections[0].heading = 'Unpublished replacement';
  const changedDraft = await call('PUT', '/api/admin/store-content/draft', { revision: latest.revision, content: changedAgain }, master.token);
  const restored = await call('POST', `/api/admin/store-content/history/${versions[0]._id}/restore`, { revision: changedDraft.revision }, master.token);
  assert.equal(restored.draft.sections[0].heading, 'Content Studio festive edit');
  assert.equal((await get('/api/website-config')).config.homepage.sections[0].heading, 'Content Studio festive edit');
});

test('scheduled content saves the draft and publishes through the background release worker', async () => {
  const master = await createMasterOwner();
  await get('/api/admin/customization', master.token);
  const initial = await get('/api/admin/store-content', master.token);
  const content = structuredClone(initial.draft);
  content.sections[0].heading = 'Worker published collection';
  const future = new Date(Date.now() + 5 * 60000).toISOString();
  const scheduled = await call('POST', '/api/admin/store-content/schedule', { revision: initial.revision, content, scheduledFor: future, note: 'Worker release', timezone: 'Asia/Kolkata' }, master.token);
  assert.equal(scheduled.draft.sections[0].heading, 'Worker published collection');
  assert.equal(scheduled.scheduledStatus, 'SCHEDULED');
  await call('POST', '/api/admin/store-content/schedule', { revision: scheduled.revision, content, scheduledFor: future }, master.token, 409);

  await WebsiteTheme.updateOne({ isActive: true }, { $set: { scheduledContentFor: new Date(Date.now() - 1000), scheduledContentStatus: 'SCHEDULED' } });
  const processed = await require('../services/storeContentService').processDueContentReleases();
  assert.equal(processed, 1);
  const publicAfter = await get('/api/website-config');
  assert.equal(publicAfter.config.homepage.sections[0].heading, 'Worker published collection');
  const workspace = await get('/api/admin/store-content', master.token);
  assert.equal(workspace.scheduledFor, null);
  const history = await get('/api/admin/store-content/history?paged=1&page=1&limit=20', master.token);
  assert.equal(history.items[0].kind, 'SCHEDULED');
  assert.equal(history.items[0].state, 'PUBLISHED');
  assert.equal(history.pagination.total, 2);
});

test('failed content releases wait before automatic retry instead of exhausting every attempt', async () => {
  const master = await createMasterOwner();
  await get('/api/admin/customization', master.token);
  const workspace = await get('/api/admin/store-content', master.token);
  const invalidContent = structuredClone(workspace.draft);
  invalidContent.sections[0].buttonLink = 'https://outside.example/products';
  await WebsiteTheme.updateOne({ isActive: true }, { $set: {
    scheduledContent: invalidContent,
    scheduledContentId: 'retry-backoff-release',
    scheduledContentFor: new Date(Date.now() - 1000),
    scheduledContentStatus: 'SCHEDULED',
    scheduledContentAttempts: 0,
  } });
  const releases = require('../services/storeContentService');
  assert.equal(await releases.processDueContentReleases(), 1);
  let theme = await WebsiteTheme.findOne({ isActive: true }).lean();
  assert.equal(theme.scheduledContentStatus, 'FAILED');
  assert.equal(theme.scheduledContentAttempts, 1);
  assert.match(theme.scheduledContentError, /safe store path/i);
  assert.equal(await releases.processDueContentReleases(), 0);
  theme = await WebsiteTheme.findOne({ isActive: true }).lean();
  assert.equal(theme.scheduledContentAttempts, 1);
});

test('seller content studio is isolated per store and updates only that storefront', async () => {
  const master = await createMasterOwner();
  await get('/api/admin/customization', master.token);
  const sellerA = await createProvisionedSeller('Content Store Alpha');
  const sellerB = await createProvisionedSeller('Content Store Beta');
  await Store.updateMany({ _id: { $in: [sellerA.store.id, sellerB.store.id] } }, { $set: { status: 'PUBLISHED', publishedAt: new Date() } });
  const headersA = { 'x-store-id': sellerA.store.id };
  const headersB = { 'x-store-id': sellerB.store.id };
  const currentA = await get('/api/seller/content', sellerA.token, headersA);
  const currentB = await get('/api/seller/content', sellerB.token, headersB);
  const alphaContent = structuredClone(currentA.draft);
  alphaContent.sections[0].heading = 'Alpha private storefront copy';
  const saved = await call('PUT', '/api/seller/content/draft', { expectedRevision: currentA.revision, content: alphaContent }, sellerA.token, 200, headersA);
  await call('POST', '/api/seller/content/publish', { expectedRevision: saved.revision, content: alphaContent }, sellerA.token, 200, headersA);
  const publicA = await get('/api/website-config', undefined, { 'x-store-slug': sellerA.store.slug });
  const publicB = await get('/api/website-config', undefined, { 'x-store-slug': sellerB.store.slug });
  assert.equal(publicA.config.homepage.sections[0].heading, 'Alpha private storefront copy');
  assert.equal(publicB.config.homepage.sections[0].heading, currentB.published.sections[0].heading);
  assert.notEqual(publicB.config.homepage.sections[0].heading, 'Alpha private storefront copy');
});

test('owner-controlled client admin handover and role switching retain guarded permissions', async (t) => {
  const master = await createMasterOwner(); const customer = await createCustomer();
  const keys = ['NODE_ENV','OTP_MODE','SMS_PROVIDER'];
  const previous = Object.fromEntries(keys.map(key => [key,process.env[key]]));
  t.after(() => keys.forEach(key => { if(previous[key]===undefined) delete process.env[key]; else process.env[key]=previous[key]; }));
  Object.assign(process.env,{NODE_ENV:'production',OTP_MODE:'production',SMS_PROVIDER:'twilio'});
  const provisioned = await call('POST','/api/master/client-admins',{name:'Provisioned Fixture Admin',phone:'9123456791'},master.token,201);
  assert.equal(provisioned.role,'admin'); assert.equal(provisioned.systemRole,'USER');
  const promoted = await call('PATCH',`/api/admin/customers/${customer.user._id}/promote-admin`,{},master.token);
  assert.equal(promoted.role,'admin');
  await call('PATCH',`/api/admin/customers/${customer.user._id}/demote-admin`,{},master.token);
  await call('PATCH',`/api/admin/customers/${customer.user._id}/block`,{isBlocked:true},master.token);
  await call('GET','/api/auth/me',undefined,customer.token,401);
  await call('PATCH',`/api/admin/customers/${customer.user._id}/block`,{isBlocked:false},master.token);
  assert.ok((await get('/api/admin/customers',master.token)).some(user=>String(user._id)===String(customer.user._id)));
  assert.ok((await get('/api/admin/audit-logs/options',master.token)).actions.length > 0);
  const admin = await createAdmin();
  let mode = await call('POST','/api/auth/switch-mode',{mode:'customer'},admin.token);
  assert.equal(mode.user.activeMode,'customer');
  mode = await call('POST','/api/auth/switch-mode',{mode:'admin'},mode.token);
  assert.equal(mode.user.activeMode,'admin');
  assert.ok(await get('/api/admin/profile',mode.token));
});

test('theme listing, draft discard and activation complete without publishing discarded content', async () => {
  const master = await createMasterOwner();
  const config = await readConfiguration();
  if(config.locked) await call('PUT','/api/master/configuration',{revision:config.revision,locked:false},master.token);
  const workspace = await get('/api/admin/customization',master.token);
  const original = workspace.selectedTheme;
  assert.ok((await get('/api/admin/customization/presets',master.token)).length > 0);
  assert.equal((await get('/api/admin/customization/themes',master.token)).length,1);
  const draft = await get(`/api/admin/customization/themes/${original._id}`,master.token);
  const configDraft = {...draft.draftConfig,branding:{...draft.draftConfig.branding,websiteName:'Discard this title'}};
  const changed = await call('PUT',`/api/admin/customization/themes/${original._id}/draft`,{config:configDraft,expectedUpdatedAt:draft.updatedAt},master.token);
  const discarded = await call('POST',`/api/admin/customization/themes/${original._id}/discard`,{expectedUpdatedAt:changed.updatedAt},master.token);
  assert.notEqual(discarded.draftConfig.branding.websiteName,'Discard this title');
  await call('POST',`/api/admin/customization/themes/${original._id}/activate`,{expectedUpdatedAt:discarded.updatedAt},master.token);
  assert.equal((await get('/api/website-config')).config.branding.websiteName,original.publishedConfig.branding.websiteName);
});

test('legacy payment aliases create and verify the same signed persisted gateway order', async (t) => {
  const keys=['RAZORPAY_KEY_ID','RAZORPAY_KEY_SECRET','RAZORPAY_MOCK'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>keys.forEach(key=>{if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}));
  Object.assign(process.env,{RAZORPAY_KEY_ID:'rzp_test_workflow_fixture',RAZORPAY_KEY_SECRET:'workflow-fixture-signing-secret',RAZORPAY_MOCK:'1'});
  await setSettings({razorpayEnabled:true});
  const customer=await createCustomer(),product=await createProduct({stock:3});
  const payment=await call('POST','/api/create-order',{checkoutAttemptId:'legacy_checkout_alias_001',orderItems:[{product:String(product._id),quantity:1,size:'M',color:'Red'}],shippingAddress:validAddress(),paymentMethod:'UPI'},customer.token);
  const paymentId='pay_workflow_fixture';
  const payload={razorpay_order_id:payment.razorpayOrderId,razorpay_payment_id:paymentId,razorpay_signature:require('node:crypto').createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(`${payment.razorpayOrderId}|${paymentId}`).digest('hex')};
  await call('POST','/api/verify-payment',payload,customer.token);
  await call('POST','/api/verify-payment',payload,customer.token);
  assert.equal((await get(`/api/orders/${payment.orderId}`,customer.token)).paymentStatus,'Paid');
  assert.equal((await Product.findById(product._id)).stock,2);
});

test('inventory operations protect stale counts, receive supplier stock and preserve a reversible ledger', async () => {
  const admin = await createAdmin();
  const product = await createProduct({ name: 'Inventory workflow kurta', sku: 'INV-WORKFLOW-1', stock: 5, costPrice: 400, lowStockAlert: 4 });
  await Product.updateOne({ _id: product._id }, { $unset: { inventoryRevision: 1 } });

  const catalog = await get('/api/admin/inventory/catalog?page=1&limit=25&q=INV-WORKFLOW-1', admin.token);
  assert.equal(catalog.total, 1);
  assert.equal(catalog.items[0].available, 5);
  assert.equal(catalog.items[0].inventoryStatus, 'HEALTHY');

  const adjustment = await call('POST', '/api/admin/inventory/adjustments', {
    productId: product._id, mode: 'ADD', bucket: 'SELLABLE', quantity: 3,
    expectedStock: 5, expectedRevision: 0, reasonCode: 'CORRECTION',
    note: 'Counted at demo fixture', idempotencyKey: 'inventory-workflow-adjustment',
  }, admin.token);
  assert.equal(adjustment.product.stock, 8);
  assert.equal(adjustment.movement.stockBefore, 5);
  assert.equal(adjustment.movement.stockAfter, 8);

  await call('POST', '/api/admin/inventory/adjustments', {
    productId: product._id, mode: 'SET', bucket: 'SELLABLE', quantity: 9,
    expectedStock: 5, expectedRevision: 0, reasonCode: 'STOCK_COUNT',
  }, admin.token, 409);
  assert.equal((await Product.findById(product._id)).stock, 8);

  const purchase = await call('POST', '/api/admin/inventory/purchase-orders', {
    supplier: { name: 'Workflow Textiles', phone: '9816978086', email: 'supplier@example.com' },
    items: [{ productId: product._id, quantity: 10, unitCost: 390 }], notes: 'Demo restock',
  }, admin.token, 201);
  assert.equal(purchase.remaining, 10);

  const received = await call('POST', `/api/admin/inventory/purchase-orders/${purchase._id}/receive`, {
    revision: 0, items: [{ itemId: purchase.items[0]._id, quantity: 6, damagedQuantity: 1 }], note: 'One unit damaged in transit',
  }, admin.token);
  assert.equal(received.status, 'PARTIALLY_RECEIVED');
  assert.equal(received.remaining, 3);
  let stored = await Product.findById(product._id).lean();
  assert.equal(stored.stock, 14);
  assert.equal(stored.nonSellableStock.damaged, 1);

  const history = await get(`/api/admin/inventory/history?product=${product._id}&limit=25`, admin.token);
  const correction = history.items.find((item) => item.reasonCode === 'CORRECTION');
  assert.equal(correction.reversible, true);
  await call('POST', `/api/admin/inventory/adjustments/${correction._id}/reverse`, { note: 'Correction was entered twice' }, admin.token);
  stored = await Product.findById(product._id).lean();
  assert.equal(stored.stock, 11);
  assert.equal((await get(`/api/admin/inventory/history?product=${product._id}&type=REVERSAL`, admin.token)).items.length, 1);

  const summary = await get('/api/admin/inventory/summary', admin.token);
  assert.equal(summary.sellable, 11);
  assert.equal(summary.incoming, 3);
  assert.equal(summary.damaged, 1);
});

test('concurrent purchase receiving applies a supplier delivery exactly once', async () => {
  const admin = await createAdmin();
  const product = await createProduct({ name: 'Concurrent receiving product', sku: 'INV-RECEIVE-LOCK', stock: 1 });
  const purchase = await call('POST', '/api/admin/inventory/purchase-orders', {
    supplier: { name: 'Safe Supplier' }, items: [{ productId: product._id, quantity: 4, unitCost: 100 }],
  }, admin.token, 201);
  const options = { method: 'POST', token: admin.token, body: { revision: 0, items: [{ itemId: purchase.items[0]._id, quantity: 4, damagedQuantity: 0 }] } };
  const responses = await Promise.all([
    request(`/api/admin/inventory/purchase-orders/${purchase._id}/receive`, options),
    request(`/api/admin/inventory/purchase-orders/${purchase._id}/receive`, options),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await Product.findById(product._id)).stock, 5);
  const history = await get(`/api/admin/inventory/history?product=${product._id}&type=PURCHASE_RECEIPT`, admin.token);
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].quantity, 4);
});
