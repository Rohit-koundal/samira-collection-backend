const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings } = require('./factories');
const { createMasterOwner } = require('./accessFixtures');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('website customization is master-only and publishing controls the public theme', async () => {
  const anonymous = await request('/api/admin/customization');
  assert.equal(anonymous.status, 401);

  const { token: customerToken } = await createCustomer();
  const customer = await request('/api/admin/customization', { token: customerToken });
  assert.equal(customer.status, 403);

  const regularAdmin = await createAdmin();
  assert.equal((await request('/api/admin/customization', { token: regularAdmin.token })).status, 403);
  const { token: adminToken } = await createMasterOwner();
  const workspace = await request('/api/admin/customization', { token: adminToken });
  assert.equal(workspace.status, 200);
  assert.equal(workspace.data.themes.length, 1);
  assert.equal(workspace.data.selectedTheme.isActive, true);
  assert.ok(workspace.data.presets.some((preset) => preset.id === 'premium'));

  const created = await request('/api/admin/customization/themes', {
    method: 'POST',
    token: adminToken,
    body: { name: 'Autumn Premium', preset: 'premium' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.isActive, false);

  const draftConfig = created.data.draftConfig;
  draftConfig.colors.primary = '#123456';
  draftConfig.branding.websiteName = 'Samira Autumn';
  const hero = draftConfig.homepage.sections.find((section) => section.id === 'hero');
  hero.heading = 'Autumn Celebration';
  hero.buttonLink = 'javascript:alert(1)';
  draftConfig.footer.socialLinks.instagram = 'javascript:alert(1)';
  draftConfig.footer.menus.shopping = [{ label: 'Unsafe', path: 'javascript:alert(1)' }];

  const saved = await request(`/api/admin/customization/themes/${created.data._id}/draft`, {
    method: 'PUT',
    token: adminToken,
    body: { config: draftConfig },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.draftConfig.colors.primary, '#123456');
  assert.equal(saved.data.draftConfig.homepage.sections.find((section) => section.id === 'hero').buttonLink, '');
  assert.equal(saved.data.draftConfig.footer.socialLinks.instagram, '');
  assert.deepEqual(saved.data.draftConfig.footer.menus.shopping, []);

  const beforePublish = await request('/api/website-config');
  assert.equal(beforePublish.status, 200);
  assert.notEqual(beforePublish.data.config.colors.primary, '#123456');

  const lockedPublish = await request(`/api/admin/customization/themes/${created.data._id}/publish`, { method: 'POST', token: adminToken });
  assert.equal(lockedPublish.status, 403);
  assert.equal((await request('/api/master/configuration', { method: 'PUT', token: adminToken, body: { revision: 0, locked: false } })).status, 200);
  const published = await request(`/api/admin/customization/themes/${created.data._id}/publish`, {
    method: 'POST',
    token: adminToken,
    body: { note: 'Launch autumn theme' },
  });
  assert.equal(published.status, 200);
  assert.equal(published.data.version.version, 1);
  assert.equal(published.data.theme.isActive, true);

  const live = await request('/api/website-config');
  assert.equal(live.status, 200);
  assert.equal(live.data.config.colors.primary, '#123456');
  assert.equal(live.data.config.branding.websiteName, 'Samira Autumn');
  assert.equal(live.data.config.homepage.sections.find((section) => section.id === 'hero').heading, 'Autumn Celebration');
});

test('mobile storefront feed returns bounded card data and live customer policies', async () => {
  await setSettings({ freeShippingMinAmount: 1499, shippingFreeAboveEnabled: true, returnsEnabled: false, codEnabled: true });
  const product = await createProduct({
    name: 'Mobile Home Saree',
    slug: 'mobile-home-saree',
    isFeatured: true,
    showOnHomepage: true,
    images: [{ url: '/uploads/one.jpg' }, { url: '/uploads/two.jpg' }],
    rating: 4.7,
    numReviews: 12,
  });
  const response = await request(`/api/storefront/home?recent=${product._id}`);
  assert.equal(response.status, 200);
  assert.equal(response.data.settings.freeShippingMinAmount, 1499);
  assert.equal(response.data.settings.returnsEnabled, false);
  assert.ok(response.data.collections.featured.some((item) => item.slug === 'mobile-home-saree'));
  assert.equal(response.data.collections.featured.find((item) => item.slug === 'mobile-home-saree').images.length, 1);
  assert.equal(response.data.collections.featured.find((item) => item.slug === 'mobile-home-saree').images[0].publicId, undefined);
  assert.equal(response.data.collections.recentlyViewed[0].slug, 'mobile-home-saree');
  assert.equal(response.data.collections.featured[0].description, undefined);
  assert.match(response.headers.get('cache-control'), /stale-while-revalidate/);
});

test('mobile storefront feed does not truncate active categories needed by the home rail', async () => {
  const Category = require('../models/Category');
  await Category.insertMany(Array.from({ length: 14 }, (_, index) => ({
    name: index === 13 ? 'Sarees' : `Visible Category ${index + 1}`,
    slug: index === 13 ? 'sarees' : `visible-category-${index + 1}`,
    isActive: true,
    displayOrder: index,
  })));
  const response = await request('/api/storefront/home');
  assert.equal(response.status, 200);
  assert.ok(response.data.categories.length >= 14);
  assert.ok(response.data.categories.some((category) => category.name === 'Sarees'));
});

test('theme history can restore a version to draft without silently changing the live store', async () => {
  const { token } = await createMasterOwner();
  assert.equal((await request('/api/master/configuration', { method: 'PUT', token, body: { revision: 0, locked: false } })).status, 200);
  const workspace = await request('/api/admin/customization', { token });
  const theme = workspace.data.selectedTheme;

  const first = { ...theme.draftConfig, colors: { ...theme.draftConfig.colors, primary: '#112233' } };
  await request(`/api/admin/customization/themes/${theme._id}/draft`, { method: 'PUT', token, body: { config: first } });
  const publishedOne = await request(`/api/admin/customization/themes/${theme._id}/publish`, { method: 'POST', token, body: { note: 'Version one' } });

  const second = { ...first, colors: { ...first.colors, primary: '#445566' } };
  await request(`/api/admin/customization/themes/${theme._id}/draft`, { method: 'PUT', token, body: { config: second } });
  await request(`/api/admin/customization/themes/${theme._id}/publish`, { method: 'POST', token, body: { note: 'Version two' } });

  const restored = await request(`/api/admin/customization/themes/${theme._id}/history/${publishedOne.data.version._id}/restore`, { method: 'POST', token });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.theme.draftConfig.colors.primary, '#112233');

  const live = await request('/api/website-config');
  assert.equal(live.data.config.colors.primary, '#445566');

  const history = await request(`/api/admin/customization/themes/${theme._id}/history`, { token });
  assert.equal(history.status, 200);
  assert.deepEqual(history.data.map((version) => version.version), [2, 1]);
});

test('active themes are protected from deletion and unused themes can be removed', async () => {
  const { token } = await createMasterOwner();
  const workspace = await request('/api/admin/customization', { token });
  const activeTheme = workspace.data.selectedTheme;

  const duplicate = await request(`/api/admin/customization/themes/${activeTheme._id}/duplicate`, {
    method: 'POST',
    token,
    body: { name: 'Unused Copy' },
  });
  assert.equal(duplicate.status, 201);

  const activeDelete = await request(`/api/admin/customization/themes/${activeTheme._id}`, { method: 'DELETE', token });
  assert.equal(activeDelete.status, 409);

  const unusedDelete = await request(`/api/admin/customization/themes/${duplicate.data._id}`, { method: 'DELETE', token });
  assert.equal(unusedDelete.status, 200);
});
