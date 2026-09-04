const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('website customization is admin-only and publishing controls the public theme', async () => {
  const anonymous = await request('/api/admin/customization');
  assert.equal(anonymous.status, 401);

  const { token: customerToken } = await createCustomer();
  const customer = await request('/api/admin/customization', { token: customerToken });
  assert.equal(customer.status, 403);

  const { token: adminToken } = await createAdmin();
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

test('theme history can restore a version to draft without silently changing the live store', async () => {
  const { token } = await createAdmin();
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
  const { token } = await createAdmin();
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
