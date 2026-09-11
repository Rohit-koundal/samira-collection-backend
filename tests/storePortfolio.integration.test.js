const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createMasterOwner } = require('./accessFixtures');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const StorePortfolioOperation = require('../models/StorePortfolioOperation');
const Product = require('../models/Product');
const Category = require('../models/Category');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

async function createStore(master, suffix = 'One') {
  const response = await request('/api/stores', {
    method: 'POST', token: master.token,
    body: {
      name: `Portfolio ${suffix}`,
      slug: `portfolio-${suffix.toLowerCase()}`,
      ownerName: `Owner ${suffix}`,
      ownerPhone: `9816978${String(100 + suffix.length).slice(-3)}`,
      industry: 'fashion',
      plan: 'PROFESSIONAL',
      licenseStatus: 'TRIAL',
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.store;
}

test('portfolio list is searchable, paginated and returns operational readiness without rollback data', async () => {
  const master = await createMasterOwner();
  const store = await createStore(master, 'Searchable');
  const result = await request('/api/master/stores?q=Searchable&page=1&limit=10', { token: master.token });
  assert.equal(result.status, 200);
  assert.equal(result.data.pagination.total, 1);
  assert.equal(result.data.stores[0].id, store.id);
  assert.equal(result.data.stores[0].readiness.ready, false);
  assert.equal(result.data.stores[0].migration.canRollback, false);
  assert.equal(Object.hasOwn(result.data.stores[0].migration, 'rollbackSnapshot'), false);

  const details = await request(`/api/master/stores/${store.id}/operations`, { token: master.token });
  assert.equal(details.status, 200);
  assert.equal(details.data.members.filter((member) => member.role === 'OWNER').length, 1);
  assert.deepEqual(details.data.related, { draftProducts: 0, activeCarts: 0, activeOrders: 0 });

  const exported = await request(`/api/master/stores/${store.id}/export`, {
    method: 'POST', token: master.token, body: { baseRevision: 0, reason: 'Client requested a portable backup' },
  });
  assert.equal(exported.status, 200);
  assert.equal(typeof exported.data, 'string');
  assert.match(exported.data, /"format":"samira-store-data"/);
  assert.match(exported.data, /"collection":"teamMemberships"/);
  assert.doesNotMatch(exported.data, /secretHash|secretSalt|passwordHash|refreshToken/i);
  const lines = exported.data.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].version, 2);
  const completion = lines.at(-1);
  assert.equal(completion.type, 'complete');
  assert.equal(completion.totalRecords, lines.length - 2);
  assert.match(completion.checksum.value, /^[a-f0-9]{64}$/);
  const payload = exported.data.split('\n').slice(0, -2).map((line) => `${line}\n`).join('');
  assert.equal(require('node:crypto').createHash('sha256').update(payload).digest('hex'), completion.checksum.value);
});

test('exact-store catalogue review never mixes products from another client', async () => {
  const master = await createMasterOwner();
  const first = await createStore(master, 'CatalogA');
  const second = await createStore(master, 'CatalogB');
  await Product.create({ storeId: first.id, name: 'First client product', slug: 'first-client-product', price: 100, stock: 1 });
  await Product.create({ storeId: second.id, name: 'Second client product', slug: 'second-client-product', price: 200, stock: 1 });
  await Product.create({ storeId: second.id, name: 'Second client extra product', slug: 'second-client-extra-product', price: 250, stock: 1 });
  await Category.create({ storeId: first.id, name: 'First client category', slug: 'first-client-category' });
  await Category.create({ storeId: second.id, name: 'Second client category', slug: 'second-client-category' });
  const result = await request(`/api/admin/products?admin=true&includeSummary=true&page=1&limit=10&storeId=${first.id}`, { token: master.token });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].name, 'First client product');

  const categories = await request(`/api/admin/categories?admin=true&storeId=${first.id}`, { token: master.token });
  assert.equal(categories.status, 200, JSON.stringify(categories.data));
  assert.ok(categories.data.some((item) => item.name === 'First client category'));
  assert.ok(categories.data.every((item) => String(item.storeId) === String(first.id)));
  assert.equal(categories.data.some((item) => item.name === 'Second client category'), false);

  const invalid = await request('/api/admin/products?admin=true&storeId=not-a-store', { token: master.token });
  assert.equal(invalid.status, 400);

  const highestUsage = await request('/api/master/stores?sort=usage&page=1&limit=10', { token: master.token });
  assert.equal(highestUsage.status, 200, JSON.stringify(highestUsage.data));
  assert.equal(highestUsage.data.stores[0].id, second.id);
});

test('tenant index migration repairs a same-name index with unsafe legacy options', async () => {
  const { ensureTenantIndexes } = require('../services/storeService');
  await Category.create({ name: 'Index seed', slug: 'index-seed' });
  await Category.collection.dropIndex('storeId_1_slug_1');
  await Category.collection.createIndex({ storeId: 1, slug: 1 }, { name: 'storeId_1_slug_1', unique: false });
  await ensureTenantIndexes();
  const index = (await Category.collection.indexes()).find((item) => item.name === 'storeId_1_slug_1');
  assert.equal(index.unique, true);
});

test('access grants are idempotent and stale store revisions are rejected', async () => {
  const master = await createMasterOwner();
  const store = await createStore(master, 'Grant');
  const body = { baseRevision: 0, plan: 'PREMIUM', billingCycle: 'MONTHLY', reason: 'Paid monthly access', idempotencyKey: 'grant:test:portfolio:001' };
  const granted = await request(`/api/master/stores/${store.id}/subscription/grants`, { method: 'POST', token: master.token, body });
  assert.equal(granted.status, 200, JSON.stringify(granted.data));
  assert.equal(granted.data.duplicate, false);
  assert.equal(granted.data.store.platform.id, 'PREMIUM');
  assert.equal(granted.data.store.platform.billingCycle, 'MONTHLY');
  assert.equal(granted.data.store.revision, 1);

  const replay = await request(`/api/master/stores/${store.id}/subscription/grants`, { method: 'POST', token: master.token, body });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.duplicate, true);
  assert.equal(await StorePortfolioOperation.countDocuments({ store: store.id, idempotencyKey: body.idempotencyKey }), 1);

  const stale = await request(`/api/master/stores/${store.id}/subscription`, {
    method: 'PATCH', token: master.token,
    body: { baseRevision: 0, plan: 'BASIC', licenseStatus: 'ACTIVE', billingCycle: 'MONTHLY', licenseEndsAt: '2030-01-01', reason: 'Stale update must fail' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'DUPLICATE_REQUEST');
});

test('team access, ownership transfer and lifecycle changes remain store scoped', async () => {
  const master = await createMasterOwner();
  const store = await createStore(master, 'Team');
  const added = await request(`/api/master/stores/${store.id}/members`, {
    method: 'POST', token: master.token,
    body: { baseRevision: 0, name: 'New Store Owner', phone: '9999999998', role: 'MANAGER', status: 'ACTIVE', reason: 'Prepare ownership handover' },
  });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal(added.data.store.revision, 1);

  const transferred = await request(`/api/master/stores/${store.id}/transfer-owner`, {
    method: 'POST', token: master.token,
    body: { baseRevision: 1, phone: '9999999998', reason: 'Client approved ownership handover' },
  });
  assert.equal(transferred.status, 200, JSON.stringify(transferred.data));
  assert.equal(transferred.data.store.owner.phone, '9999999998');
  assert.equal(transferred.data.store.revision, 2);
  assert.equal(await StoreMember.countDocuments({ store: store.id, role: 'OWNER', status: 'ACTIVE' }), 1);

  const paused = await request(`/api/master/stores/${store.id}/lifecycle`, {
    method: 'PATCH', token: master.token,
    body: { baseRevision: 2, action: 'DISABLE_CHECKOUT', reason: 'Temporary fulfilment pause' },
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.data.store.checkoutEnabled, false);
  const stored = await Store.findById(store.id).lean();
  assert.equal(stored.checkoutEnabled, false);

  const bypass = await request(`/api/master/stores/${store.id}/profile`, {
    method: 'PATCH', token: master.token,
    body: { baseRevision: 3, checkoutEnabled: true },
  });
  assert.equal(bypass.status, 400);
  assert.match(bypass.data.message, /lifecycle/i);
});

test('industry conversion requires the signed current preview and exposes a reversible migration', async () => {
  const master = await createMasterOwner();
  const store = await createStore(master, 'Industry');
  const preview = await request(`/api/master/stores/${store.id}/industry-impact?industry=jewellery`, { token: master.token });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.from.id, 'fashion');
  assert.equal(preview.data.to.id, 'jewellery');
  assert.ok(preview.data.impactToken);

  const converted = await request(`/api/master/stores/${store.id}/industry-conversion`, {
    method: 'POST', token: master.token,
    body: { industry: 'jewellery', baseRevision: preview.data.revision, impactToken: preview.data.impactToken, reviewNote: 'Move this empty catalogue to jewellery' },
  });
  assert.equal(converted.status, 200, JSON.stringify(converted.data));
  assert.equal(converted.data.store.industry, 'jewellery');
  assert.equal(converted.data.store.migration.canRollback, true);
  assert.equal(Object.hasOwn(converted.data.store.migration, 'rollbackSnapshot'), false);

  const stale = await request(`/api/master/stores/${store.id}/industry-conversion`, {
    method: 'POST', token: master.token,
    body: { industry: 'jewellery', baseRevision: preview.data.revision, impactToken: preview.data.impactToken, reviewNote: 'Replay old preview' },
  });
  assert.equal(stale.status, 409);

  const rolledBack = await request(`/api/master/stores/${store.id}/migration/rollback`, {
    method: 'POST', token: master.token,
    body: { baseRevision: converted.data.store.revision, reason: 'Restore original fashion catalogue' },
  });
  assert.equal(rolledBack.status, 200, JSON.stringify(rolledBack.data));
  assert.equal(rolledBack.data.store.industry, 'fashion');
  assert.equal(rolledBack.data.store.migration.status, 'ROLLED_BACK');
});
