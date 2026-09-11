// No listening server, database process, SMS or .env file is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const zlib = require('zlib');
const mongoose = require('mongoose');
const Configuration = require('../models/MasterConfiguration');
const Product = require('../models/Product');
const User = require('../models/User');
const Otp = require('../models/Otp');
const policy = require('../config/masterOwner');
const { DEFAULT_STRUCTURE, INDUSTRY_PRESETS } = require('../config/industryPresets');
const service = require('../services/masterConfigurationService');
const governance = require('../services/masterGovernanceService');
const projectGenerator = require('../services/projectGeneratorService');
const copy = (value) => JSON.parse(JSON.stringify(value));
const owner = () => policy.attachMasterSession({
  _id: '0123456789abcdef01234567', phone: '9816978086', role: 'admin', activeMode: 'admin',
  systemRole: 'MASTER_OWNER', isPhoneVerified: true, masterSessionVersion: 'fresh-owner-session',
}, { masterSessionVersion: 'fresh-owner-session' });
const configuration = (locked = false) => ({ _id: 'store', locked, revision: 2, history: [], structure: service.validateStructure(copy(DEFAULT_STRUCTURE)) });
const stubConfig = (t, value) => t.mock.method(Configuration, 'findById', () => ({ lean: async () => value }));
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} });

function readZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const filenameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const filenameStart = offset + 30;
    const dataStart = filenameStart + filenameLength + extraLength;
    const name = buffer.subarray(filenameStart, filenameStart + filenameLength).toString('utf8');
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? zlib.inflateRawSync(compressed) : Buffer.from(compressed));
    offset = dataStart + compressedSize;
  }
  return entries;
}

test('owner requires the pinned phone, verified DB identity, admin mode and a current signed session', () => {
  assert.equal(policy.isOwnerPhone('+91 9816978086'), true);
  assert.equal(policy.isMasterOwner(owner()), true);
  for (const changes of [
    { phone: '9999133567' }, { systemRole: 'USER' }, { role: 'customer' },
    { activeMode: 'customer' }, { isPhoneVerified: false }, { isBlocked: true },
    { offlineSession: true }, { $locals: {} },
  ]) assert.equal(policy.isMasterOwner({ ...owner(), ...changes }), false);
  assert.equal(policy.isMasterOwner(policy.attachMasterSession(owner(), { masterSessionVersion: 'old-session' })), false);
  assert.equal(policy.isMasterOwner(policy.attachMasterSession(owner(), {})), false);
});

test('master route middleware and controller handlers reject client admins before database work', async () => {
  const controller = require('../controllers/masterController');
  for (const action of ['workspace', 'previewProject', 'generateProject', 'updateInstallation', 'rotateInstallationKey', 'deployInstallation', 'createRelease', 'storePortfolio', 'storePortfolioOperations', 'exportStoreData', 'updateStoreProfile', 'updateStoreSubscription', 'grantStoreAccess', 'updateStoreLifecycle', 'createStoreMember', 'updateStoreMember', 'transferStoreOwner', 'previewStoreIndustry', 'storeIndustryAffectedProducts', 'convertStoreIndustry', 'storeMigrationProducts', 'updateStoreMigrationReview', 'completeStoreMigration', 'rollbackStoreIndustry', 'updateStorePlatform', 'update', 'configurationImpact', 'configurationImpactProducts', 'configurationHistory', 'configurationVersion', 'restoreConfigurationVersion', 'export', 'import', 'createPreset', 'updatePreset', 'duplicatePreset', 'deletePreset', 'presetUsage', 'provisionAdmin']) {
    let error;
    await controller[action]({ user: { role: 'admin', systemRole: 'USER' }, body: {}, params: {} }, response(), (err) => { error = err; });
    assert.equal(error?.statusCode, 403, action);
  }
  let error;
  policy.masterOnly({ user: { role: 'admin' } }, {}, (err) => { error = err; });
  assert.equal(error.statusCode, 403);
  const routes = require('../routes/masterRoutes');
  assert.equal(routes.stack[0].handle, require('../middleware/authMiddleware').protect);
  assert.equal(routes.stack[1].handle, policy.masterOnly);
  assert.equal(require('../routes/websiteCustomizationRoutes').stack[0].handle, policy.masterOnly);
});

test('service-level guard rejects direct configuration calls without a master session', async () => {
  await assert.rejects(service.updateConfiguration({ role: 'admin' }, { revision: 2, locked: false }), { statusCode: 403 });
});

test('all industry presets are independent, valid and have the intended sizing profile', () => {
  assert.deepEqual(
    INDUSTRY_PRESETS.map((preset) => preset.industry),
    ['fashion', 'mobile', 'electronics', 'jewellery', 'cosmetics', 'art', 'bakery', 'footwear', 'home'],
  );
  for (const preset of INDUSTRY_PRESETS) {
    const result = service.validateStructure({ ...copy(preset), clientPermissions: { content: true, payments: true } });
    assert.equal(result.features.sizing, preset.features.sizing);
    assert.ok(result.attributes.length >= 12, `${preset.industry} needs a complete product schema`);
    assert.ok(result.categoryDefinitions.length >= 5, `${preset.industry} needs category definitions`);
    assert.ok(result.filters.length >= 5, `${preset.industry} needs storefront filters`);
    assert.ok(result.sortingOptions.length >= 4, `${preset.industry} needs sort options`);
    assert.ok(result.productSections.length >= 6, `${preset.industry} needs product detail sections`);
    assert.ok(result.homepageSections.length >= 4, `${preset.industry} needs homepage sections`);
    assert.ok(result.attributes.every((field) => field.type && field.group && field.validation));
  }
  const electronics = service.validateStructure({ ...copy(INDUSTRY_PRESETS.find((preset) => preset.industry === 'electronics')), clientPermissions: { content: true, payments: true } });
  const mobiles = electronics.categoryDefinitions.find((category) => category.key === 'mobiles');
  assert.deepEqual(mobiles.variantAttributes, ['ram', 'storage', 'colour']);
  assert.ok(mobiles.attributes.some((field) => field.key === 'battery'));
  const mobileStore = service.validateStructure({ ...copy(INDUSTRY_PRESETS.find((preset) => preset.industry === 'mobile')), clientPermissions: { content: true, payments: true } });
  const smartphones = mobileStore.categoryDefinitions.find((category) => category.key === 'smartphones');
  const chargers = mobileStore.categoryDefinitions.find((category) => category.key === 'chargers');
  assert.deepEqual(smartphones.variantAttributes, ['ram', 'storage', 'colour']);
  assert.ok(smartphones.attributes.some((field) => field.key === 'charging_power'));
  assert.ok(chargers.attributes.some((field) => field.key === 'output_power'));
  assert.equal(mobileStore.attributes.some((field) => field.key === 'processor'), false);
  const bakery = INDUSTRY_PRESETS.find((preset) => preset.industry === 'bakery');
  assert.equal(bakery.inventory.trackExpiry, true);
  assert.ok(bakery.attributes.some((field) => field.key === 'batch_number' && field.required));
  assert.ok(bakery.attributes.some((field) => field.key === 'expiry_date' && field.required));
});

test('standalone project generator creates a renamed isolated source package without private runtime data', async () => {
  const mobile = INDUSTRY_PRESETS.find((preset) => preset.industry === 'mobile');
  const input = { companyName: 'Rohit Mobiles', projectName: 'Rohit Mobile Commerce', projectSlug: 'rohit-mobiles', industry: 'mobile', includeAiWorker: false };
  const preview = await projectGenerator.previewProject(input, mobile);
  assert.equal(preview.downloadName, 'rohit-mobiles.zip');
  assert.ok(preview.sourceFiles > 100);
  const result = await projectGenerator.generateProject(input, mobile);
  assert.equal(result.buffer.readUInt32LE(0), 0x04034b50);
  const entries = readZip(result.buffer);
  const prefix = 'rohit-mobiles/';
  for (const name of ['package.json', 'backend/package.json', 'src/App.jsx', 'src/components/pwa/MobileAppCompanion.jsx', 'src/components/admin/OrderWorkflowActions.jsx', 'backend/services/orderWorkflowService.js', 'public/sw.js', 'public/offline.html', 'README.md', '.gitignore', '.env.example', 'backend/.env.example', 'backend/controllers/catalogConfigurationController.js', 'project-manifest.json']) assert.ok(entries.has(prefix + name), name);
  assert.equal(JSON.parse(entries.get(prefix + 'package.json')).name, 'rohit-mobiles');
  assert.equal(JSON.parse(entries.get(prefix + 'backend/package.json')).name, 'rohit-mobiles-backend');
  assert.match(entries.get(prefix + 'src/config/websiteCustomization.js').toString('utf8'), /Rohit Mobiles/);
  assert.match(entries.get(prefix + 'backend/services/storeService.js').toString('utf8'), /DEFAULT_STORE_SLUG = 'rohit-mobiles'/);
  assert.match(entries.get(prefix + 'backend/config/industryPresets.js').toString('utf8'), /"industry":"mobile"/);
  assert.doesNotMatch(entries.get(prefix + 'src/App.jsx').toString('utf8'), /MasterConfiguration|MasterRoute|PlatformStores|masterPages|isMaster/);
  assert.doesNotMatch(entries.get(prefix + 'src/App.jsx').toString('utf8'), /SellerSubscription|seller\/subscription/);
  assert.doesNotMatch(entries.get(prefix + 'src/components/seller/SellerLayout.jsx').toString('utf8'), /Plan & billing|seller\/subscription/);
  assert.doesNotMatch(entries.get(prefix + 'backend/routes/sellerRoutes.js').toString('utf8'), /subscription|requireActiveStoreLicenseForWrites|requireProductCapacity/);
  assert.doesNotMatch(entries.get(prefix + 'backend/controllers/orderController.js').toString('utf8'), /assertMonthlyOrderCapacity|assertStoreCanAcceptOrders/);
  assert.doesNotMatch(entries.get(prefix + 'backend/controllers/paymentController.js').toString('utf8'), /subscriptionService|CLIENT_PROJECT_REMOVE_SUBSCRIPTION/);
  assert.doesNotMatch(entries.get(prefix + 'src/components/admin/AdminSidebar.jsx').toString('utf8'), /Master configuration|Store portfolio|\/master/);
  assert.doesNotMatch(entries.get(prefix + 'backend/app.js').toString('utf8'), /\/api\/master|masterController/);
  assert.doesNotMatch(entries.get(prefix + 'backend/routes/websiteCustomizationRoutes.js').toString('utf8'), /masterOnly|unlocked/);
  assert.doesNotMatch(entries.get(prefix + 'src/pages/admin/WebsiteCustomizer.jsx').toString('utf8'), /Master configuration|\/master/);
  for (const name of ['src/pages/admin/MasterConfiguration.jsx', 'src/pages/admin/PlatformStores.jsx', 'src/pages/admin/PlatformStores.test.jsx', 'src/pages/seller/Subscription.jsx', 'src/components/layout/MasterRoute.jsx', 'backend/controllers/masterController.js', 'backend/controllers/subscriptionController.js', 'backend/models/SubscriptionPayment.js', 'backend/models/MasterConfigurationVersion.js', 'backend/models/StorePortfolioOperation.js', 'backend/models/SubscriptionPricing.js', 'backend/routes/masterRoutes.js', 'backend/services/masterGovernanceService.js', 'backend/services/projectGeneratorService.js', 'backend/services/storePortfolioService.js', 'backend/services/storeDataExportService.js', 'backend/services/subscriptionPricingService.js', 'backend/services/subscriptionService.js', 'backend/tests/storePortfolio.integration.test.js']) assert.ok(!entries.has(prefix + name), name);
  assert.ok(![...entries.keys()].some((name) => name.includes('/node_modules/') || name.includes('/uploads/') || name.includes('/.git/') || name.startsWith(prefix + 'ai-video-worker/')));
  assert.ok(!entries.has(prefix + '.env'));
  assert.ok(!entries.has(prefix + 'backend/.env'));
  const manifest = JSON.parse(entries.get(prefix + 'project-manifest.json'));
  assert.equal(manifest.dataIncluded, false);
  assert.equal(manifest.features.masterConfiguration, false);
  assert.equal(manifest.features.projectGenerator, false);
  assert.equal(manifest.features.installablePhoneApp, true);
  assert.equal(manifest.features.cartWishlistCheckout, true);
  assert.equal(manifest.features.backendTrustValidation, true);
  const generatedManifest = JSON.parse(entries.get(prefix + 'public/manifest.json'));
  assert.equal(generatedManifest.name, 'Rohit Mobiles');
  assert.ok(generatedManifest.shortcuts.some((shortcut) => shortcut.url.startsWith('/cart')));
  assert.match(entries.get(prefix + 'backend/config/corsOptions.js').toString('utf8'), /https:\/\/rohit-mobiles\.onrender\.com/);
  assert.doesNotMatch(entries.get(prefix + 'backend/config/corsOptions.js').toString('utf8'), /endsWith\('\.onrender\.com'\)/);
  assert.match(entries.get(prefix + '.env.example').toString('utf8'), /GENERATE_SOURCEMAP=false/);
});

test('rejects malicious, duplicate and incomplete structural definitions', () => {
  for (const attributes of [
    [{ key: '__proto__', label: 'Bad' }], [{ key: 'constructor', label: 'Bad' }],
    [{ key: 'ram', label: 'RAM' }, { key: 'ram', label: 'Other' }],
    [{ key: 'ram', label: '' }], [{ key: 'ram', label: 'RAM', required: 'true' }],
  ]) assert.throws(() => service.validateStructure({ ...copy(DEFAULT_STRUCTURE), attributes }), { statusCode: 400 });
  assert.equal(service.validateStructure({ ...copy(DEFAULT_STRUCTURE), id: 'custom-store', name: 'Custom Store', industry: 'custom-store' }).industry, 'custom-store');
  assert.throws(() => service.validateStructure({ ...copy(DEFAULT_STRUCTURE), industry: 'electronics' }), { statusCode: 400 });
  assert.throws(() => service.validateStructure({ ...copy(DEFAULT_STRUCTURE), features: { sizing: true, specifications: false } }), { statusCode: 400 });
});

test('strict schema validation rejects invalid defaults and dangling storefront references', () => {
  const base = copy(DEFAULT_STRUCTURE);
  const dropdown = { ...base.attributes[0], key: 'finish', label: 'Finish', type: 'dropdown', options: ['Matte'], defaultValue: 'Glossy' };
  assert.throws(() => service.validateStructure({ ...base, attributes: [...base.attributes, dropdown] }), /default value/);
  const numeric = { ...base.attributes[0], key: 'weight_value', label: 'Weight', type: 'number', validation: { min: 10 }, defaultValue: 5 };
  assert.throws(() => service.validateStructure({ ...base, attributes: [...base.attributes, numeric] }), /at least 10/);
  assert.throws(() => service.validateStructure({ ...base, filters: [...base.filters, { key: 'missing_field', label: 'Missing' }] }), /does not match/);
  assert.throws(() => service.validateStructure({ ...base, productCard: { ...base.productCard, attributeKeys: ['missing_field'] } }), /unknown attribute/);
  assert.throws(() => service.validateStructure({ ...base, seo: { ...base.seo, descriptionAttributes: ['missing_field'] } }), /unknown attribute/);
  assert.throws(() => service.validateStructure({ ...base, clientPermissions: { ...base.clientPermissions, shipping: 'yes' } }), /Shipping permission/);
});

test('configuration diff classifies destructive schema changes and binds review tokens to a revision', () => {
  const extra = { key: 'retired_field', label: 'Retired field', type: 'text', required: false, filterable: false, searchable: false, showOnCard: false, showOnDetail: true, showInSpecifications: true, variant: false, options: [], defaultValue: '', group: 'Legacy', validation: {} };
  const before = service.validateStructure({ ...copy(DEFAULT_STRUCTURE), attributes: [...copy(DEFAULT_STRUCTURE.attributes), extra] });
  const after = service.validateStructure(copy(DEFAULT_STRUCTURE));
  const changes = governance.listChanges(before, after);
  assert.ok(changes.some((item) => item.kind === 'REMOVED' && item.risk === 'BREAKING'));
  const token = governance.impactToken(2, after);
  assert.doesNotThrow(() => governance.assertImpactToken({ revision: 2 }, after, token));
  assert.throws(() => governance.assertImpactToken({ revision: 3 }, after, token), { statusCode: 400 });
});

test('affected product export returns exact records with migration reasons', async (t) => {
  const extra = { key: 'retired_field', label: 'Retired field', type: 'text', required: false, filterable: false, searchable: false, showOnCard: false, showOnDetail: true, showInSpecifications: true, variant: false, options: [], defaultValue: '', group: 'Legacy', validation: {} };
  const before = service.validateStructure({ ...copy(DEFAULT_STRUCTURE), attributes: [...copy(DEFAULT_STRUCTURE.attributes), extra] });
  const after = service.validateStructure(copy(DEFAULT_STRUCTURE));
  let capturedQuery;
  const row = { _id: 'product-1', name: 'Legacy saree', sku: 'SC-1', slug: 'legacy-saree', industry: 'fashion', categoryDefinitionKey: 'sarees', attributeValues: { retired_field: 'Old' }, specifications: [], variants: [], isActive: true, updatedAt: new Date('2026-09-11T00:00:00.000Z') };
  const chain = {
    select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, async lean() { return [row]; },
  };
  t.mock.method(Product, 'find', (query) => { capturedQuery = query; return chain; });
  t.mock.method(Product, 'countDocuments', async () => 1);
  const result = await governance.listAffectedProducts({ revision: 2, structure: before }, after, { page: 1, limit: 100 });
  assert.equal(capturedQuery.storeId, null);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].name, 'Legacy saree');
  assert.deepEqual(result.items[0].reasons, ['Removed attributes: retired_field']);
});

test('public configuration never includes lock history, owner identity or client permissions', () => {
  const result = service.publicStructure({ ...configuration(), updatedBy: 'owner', history: [{ actor: 'owner' }] });
  assert.equal(result.industry, 'fashion');
  assert.equal(result.revision, 2);
  assert.ok(result.categoryDefinitions.length > 0);
  assert.ok(result.variantConfig);
  assert.equal('clientPermissions' in result, false);
  assert.equal('history' in result, false);
  assert.equal('updatedBy' in result, false);
});

test('locked configuration cannot be edited, even by master, without a separate unlock', async (t) => {
  stubConfig(t, configuration(true));
  const write = t.mock.method(Configuration, 'findOneAndUpdate', async () => ({}));
  await assert.rejects(service.updateConfiguration(owner(), { revision: 2, structure: DEFAULT_STRUCTURE }), { statusCode: 403 });
  assert.equal(write.mock.callCount(), 1); // Only idempotent singleton initialization.
});

test('stale revision fails before structural mutation', async (t) => {
  stubConfig(t, configuration());
  const write = t.mock.method(Configuration, 'findOneAndUpdate', async () => ({}));
  await assert.rejects(service.updateConfiguration(owner(), { revision: 1, locked: true }), { statusCode: 409 });
  assert.equal(write.mock.callCount(), 1);
});

test('lock uses compare-and-set, preserves structure and records bounded audit history', async (t) => {
  const before = configuration();
  stubConfig(t, before);
  const write = t.mock.method(Configuration, 'findOneAndUpdate', async () => ({ ...before, locked: true, revision: 3 }));
  const saved = await service.updateConfiguration(owner(), { revision: 2, locked: true });
  assert.equal(saved.locked, true);
  const [filter, mutation] = write.mock.calls[1].arguments;
  assert.deepEqual(filter, { _id: 'store', revision: 2 });
  assert.deepEqual(mutation.$set.structure, before.structure);
  assert.equal(mutation.$push.history.$slice, -30);
  assert.equal(mutation.$inc.revision, 1);
});

test('concurrent configuration write conflicts instead of silently overwriting', async (t) => {
  stubConfig(t, configuration());
  t.mock.method(Configuration, 'findOneAndUpdate', async () => null);
  await assert.rejects(service.updateConfiguration(owner(), { revision: 2, locked: true }), { statusCode: 409 });
});

test('conversion with an existing catalog requires confirmation and then preserves products', async (t) => {
  stubConfig(t, configuration());
  t.mock.method(Configuration, 'findOneAndUpdate', async () => ({}));
  const existing = t.mock.method(Product, 'exists', async () => ({ _id: 'existing' }));
  const structure = { ...copy(INDUSTRY_PRESETS.find((preset) => preset.industry === 'electronics')), clientPermissions: { content: true, payments: true } };
  await assert.rejects(service.updateConfiguration(owner(), { revision: 2, structure }), /archive incompatible products/);
  await assert.doesNotReject(service.updateConfiguration(owner(), { revision: 2, structure, confirmIndustryChange: true }));
  assert.equal(existing.mock.callCount(), 1);
});

test('used attribute definitions cannot be renamed or removed silently', async (t) => {
  const before = configuration();
  stubConfig(t, before);
  t.mock.method(Configuration, 'findOneAndUpdate', async () => ({}));
  t.mock.method(Product, 'exists', async () => ({ _id: 'existing' }));
  await assert.rejects(service.updateConfiguration(owner(), { revision: 2, structure: { ...before.structure, attributes: [], categoryDefinitions: [], filters: [{ key: 'category' }, { key: 'price' }, { key: 'availability' }], variantConfig: { enabled: false, attributes: [] }, productCard: { fields: ['name', 'price'], attributeKeys: [] }, seo: { titlePattern: '{product}', descriptionAttributes: [] } } }), /used by products/);
});

test('delegated seller permission middleware enforces master capability boundaries on the server', () => {
  const { requireStorePermission, requireAnyStorePermission } = require('../middleware/storeMiddleware');
  const denied = { user: { role: 'admin' }, storeMember: { role: 'OWNER' }, store: { catalogStructure: { clientPermissions: { catalog: false, inventory: true } } } };
  let error;
  requireStorePermission('catalog.write')(denied, response(), (value) => { error = value; });
  assert.equal(error?.statusCode, 403);
  error = undefined;
  requireAnyStorePermission('catalog.write', 'inventory.write')(denied, response(), (value) => { error = value; });
  assert.equal(error, undefined);
  let allowed = false;
  requireStorePermission('catalog.write')({ ...denied, user: owner() }, response(), (value) => { assert.equal(value, undefined); allowed = true; });
  assert.equal(allowed, true);
});

test('delegated settings updates enforce each granular master capability', async (t) => {
  const Settings = require('../models/Settings');
  const config = configuration(true);
  Object.assign(config.structure.clientPermissions, { branding: false, shipping: false, payments: false, returns: false, social: false });
  stubConfig(t, config);
  const current = { _id: 'settings', storeName: 'Store', logoUrl: '', deliveryCharge: 99, codEnabled: true, returnWindowDays: 7, socialLinks: {}, toObject() { return { ...this, toObject: undefined }; } };
  t.mock.method(Settings, 'findOne', async () => current);
  const write = t.mock.method(Settings, 'findOneAndUpdate', async () => assert.fail('Forbidden settings must not be written'));
  const controller = require('../controllers/settingsController');
  for (const body of [
    { logoUrl: 'https://example.com/logo.png' }, { deliveryCharge: 120 }, { codEnabled: false },
    { returnWindowDays: 14 }, { socialLinks: { instagram: 'https://instagram.com/example' } },
  ]) {
    let error;
    await controller.updateSettings({ user: { role: 'admin' }, body, tenantFilter: {} }, response(), (value) => { error = value; });
    assert.equal(error?.statusCode, 403, Object.keys(body)[0]);
  }
  assert.equal(write.mock.callCount(), 0);
});

test('fashion product sizes and variants remain unchanged and specifications use owner labels', async (t) => {
  stubConfig(t, configuration());
  const input = { name: 'Dress', sizes: ['S', 'M'], variants: [{ size: 'S' }], attributeValues: { material: 'Cotton' }, specifications: [{ label: 'Injected', value: 'Fake' }] };
  const result = await service.applyProductStructure(input);
  assert.deepEqual(result.sizes, input.sizes);
  assert.deepEqual(result.variants, input.variants);
  assert.equal(result.specifications[0].label, DEFAULT_STRUCTURE.attributes.find((field) => field.key === 'material').label);
  assert.equal(result.specifications[0].value, 'Cotton');
  assert.ok(!JSON.stringify(result.specifications).includes('Injected'));
});

test('nonfashion products have configured attributes and no garment size selection', async (t) => {
  const config = configuration();
  config.structure = { ...copy(INDUSTRY_PRESETS.find((preset) => preset.industry === 'mobile')), clientPermissions: { content: true, payments: true } };
  stubConfig(t, config);
  const result = await service.applyProductStructure({ categoryDefinitionKey: 'smartphones', subCategory: 'Android Phones', sizes: ['S'], sizingMode: 'sized', variants: [{ sku: 'PHONE-8-128-BLACK', optionValues: { ram: '8', storage: '128', colour: 'Black' }, stock: 2 }], attributeValues: { brand: 'Example', model: 'M1', condition: 'New', processor: 'Octa core', warranty: '1 year', ram: 8 } });
  assert.equal(result.sizingMode, 'free-size');
  assert.deepEqual(result.sizes, []);
  assert.equal(result.variants[0].optionValues.storage, '128');
  assert.equal(result.attributeValues.ram, '8');
  assert.equal(result.specifications.find((item) => item.key === 'ram').unit, 'GB');
  assert.equal(result.categoryDefinitionKey, 'smartphones_android_phones');
});

test('attribute values reject unknown keys, missing required fields and oversized values', async (t) => {
  const config = configuration();
  config.structure.attributes = [{ key: 'serial', label: 'Serial number', required: true }];
  stubConfig(t, config);
  await assert.rejects(service.applyProductStructure({ attributeValues: { arbitrary: 'x' } }), /configured/);
  await assert.rejects(service.applyProductStructure({}), /Serial number/);
  await assert.rejects(service.applyProductStructure({ attributeValues: { serial: 'x'.repeat(501) } }), /500/);
  const result = await service.applyProductStructure({}, { attributeValues: new Map([['serial', 'keep-me']]) });
  assert.equal(result.attributeValues.serial, 'keep-me');
});

test('owner OTP is random even when customer demo mode is enabled', async (t) => {
  t.mock.method(crypto, 'randomInt', () => 654321);
  const previous = process.env.OTP_MODE;
  process.env.OTP_MODE = 'demo';
  try {
    const result = await require('../services/otpService').createOtp('9816978086', 'master_login');
    assert.equal(result.otp, '654321');
    assert.equal(result.record.purpose, 'master_login');
    assert.notEqual(result.record.trustedDelivery, true);
    await result.record.save();
    result.record.isUsed = true;
  } finally { if (previous === undefined) delete process.env.OTP_MODE; else process.env.OTP_MODE = previous; }
});

test('owner SMS cannot fall back to mock delivery', async () => {
  const previous = process.env.SMS_PROVIDER;
  process.env.SMS_PROVIDER = 'mock';
  try {
    const result = await require('../services/smsService').sendOtp('9816978086', '000000', { requireReal: true });
    assert.equal(result.success, false);
    assert.equal(result.devOtp, undefined);
  } finally { if (previous === undefined) delete process.env.SMS_PROVIDER; else process.env.SMS_PROVIDER = previous; }
});

test('owner session proof is absent from old tokens and excluded from default DB projections', () => {
  const jwt = require('jsonwebtoken');
  const tokens = require('../utils/generateToken');
  assert.equal(User.schema.path('masterSessionVersion').options.select, false);
  assert.equal(jwt.decode(tokens.generateToken(owner())).masterSessionVersion, 'fresh-owner-session');
  assert.equal(jwt.decode(tokens.generateRefreshToken(owner())).masterSessionVersion, 'fresh-owner-session');
  assert.equal(jwt.decode(tokens.generateToken({ ...owner(), $locals: {} })).masterSessionVersion, undefined);
});

test('owner cannot log in with offline/demo records or delete/reassign their identity', async () => {
  const controller = require('../controllers/authController');
  const res = response();
  await controller.sendOtp({ body: { phone: '9816978086' }, ip: 'unit-test' }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.demoOtp, undefined);
  const remove = response();
  await controller.deleteProfile({ user: owner() }, remove);
  assert.equal(remove.statusCode, 403);
  const change = response();
  await controller.sendProfilePhoneChangeOtp({ user: { phone: '9999133567' }, body: { phone: '9816978086' } }, change);
  assert.equal(change.statusCode, 403);
});

test('owner OTP redemption uses an atomic unused, unexpired, trusted record predicate', async (t) => {
  const previousState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  try {
    const otpService = require('../services/otpService');
    const record = { _id: 'otp-id', purpose: 'master_login', trustedDelivery: true, expiresAt: new Date(Date.now() + 60000), attempts: 0, maxAttempts: 5, otpHash: otpService.hashOtp('9816978086', '654321') };
    t.mock.method(Otp, 'findOne', () => ({ sort: async () => record }));
    const redeem = t.mock.method(Otp, 'findOneAndUpdate', async () => null);
    await assert.rejects(otpService.verifyOtp('9816978086', '654321'), /no longer available/);
    const predicate = redeem.mock.calls[0].arguments[0];
    assert.equal(predicate.isUsed, false);
    assert.equal(predicate.trustedDelivery, true);
    assert.deepEqual(predicate.attempts, { $lt: 5 });
    assert.ok(predicate.expiresAt.$gt instanceof Date);
  } finally { mongoose.connection.readyState = previousState; }
});

test('handover blocks demo and mock SMS provider configurations', async (t) => {
  const saved = { ...process.env };
  try {
    const { assertClientHandoverReady } = require('../services/clientHandoverService');
    process.env.NODE_ENV = 'production'; process.env.OTP_MODE = 'production'; process.env.SMS_PROVIDER = 'mock';
    await assert.rejects(assertClientHandoverReady(), /real SMS/);
    process.env.SMS_PROVIDER = 'twilio';
    stubConfig(t, configuration(false));
    await assert.rejects(assertClientHandoverReady(), /Lock/);
  } finally {
    for (const key of ['NODE_ENV', 'OTP_MODE', 'SMS_PROVIDER']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('client content API rejects structural changes even with a matching revision', async (t) => {
  const Theme = require('../models/WebsiteTheme');
  const { DEFAULT_WEBSITE_CONFIG } = require('../config/websiteCustomization');
  stubConfig(t, configuration(true));
  const date = new Date();
  t.mock.method(Theme, 'findOne', async () => ({ updatedAt: date, publishedConfig: DEFAULT_WEBSITE_CONFIG }));
  const controller = require('../controllers/storeContentController');
  for (const body of [
    { content: { websiteName: 'Client' }, structure: { industry: 'electronics' } },
    { content: { websiteName: 'Client', theme: 'injected' } },
    { content: { websiteName: 'Client' }, sections: [{ id: 'hero', visible: false }] },
  ]) {
    let error;
    await controller.update({ user: { role: 'admin' }, body: { ...body, revision: date.toISOString() } }, response(), (err) => { error = err; });
    assert.equal(error?.statusCode, 403);
  }
});

test('disabled client content permission blocks reads and writes', async (t) => {
  const config = configuration(true);
  config.structure.clientPermissions.content = false;
  stubConfig(t, config);
  const controller = require('../controllers/storeContentController');
  for (const action of ['get', 'update']) {
    let error;
    await controller[action]({ user: { role: 'admin' }, body: {} }, response(), (err) => { error = err; });
    assert.equal(error?.statusCode, 403);
  }
});

test('both product create and edit enforce configured values and forward errors to Express', async (t) => {
  stubConfig(t, configuration());
  t.mock.method(Product, 'findOne', async () => ({ _id: 'product' }));
  const insert = t.mock.method(Product, 'create', async () => { throw new Error('Must not insert'); });
  const update = t.mock.method(Product, 'findByIdAndUpdate', async () => { throw new Error('Must not update'); });
  const controller = require('../controllers/productController');
  for (const action of ['createProduct', 'updateProduct']) {
    let error;
    await controller[action]({ body: { attributeValues: { unknown: 'injected' } }, params: { id: 'product' }, user: { role: 'admin', activeMode: 'admin' } }, response(), (err) => { error = err; });
    assert.equal(error?.statusCode, 400, action);
    assert.match(error.message, /configured/);
  }
  assert.equal(insert.mock.callCount(), 0);
  assert.equal(update.mock.callCount(), 0);
});

test('draft publication validates required configured attributes before any product insert', async (t) => {
  const config = configuration();
  config.structure.attributes = [{ key: 'serial', label: 'Serial number', required: true }];
  stubConfig(t, config);
  const Draft = require('../models/ProductDraft');
  const draftId = '64b000000000000000000001';
  t.mock.method(Draft, 'find', () => ({ populate: async () => [{ _id: draftId, name: 'Draft' }] }));
  const insert = t.mock.method(Product, 'create', async () => { throw new Error('Must not insert'); });
  let error;
  await require('../controllers/productDraftController').publishSelected({ body: { ids: [draftId] } }, response(), (err) => { error = err; });
  assert.equal(error?.statusCode, 400);
  assert.match(error.message, /Serial number/);
  assert.equal(insert.mock.callCount(), 0);
});

test('normal verified owner profile omits session proof from JSON', async () => {
  const res = response();
  await require('../controllers/authController').profile({ user: owner() }, res);
  assert.equal(res.body.systemRole, 'MASTER_OWNER');
  assert.equal(res.body.masterSessionVersion, undefined);
});

test('owner phone cannot be changed through a profile payload, including forged roles', async (t) => {
  t.mock.method(User, 'findOne', () => ({ select: async () => null }));
  const res = response();
  await require('../controllers/authController').updateProfile({
    user: owner(), body: { phone: '9999133567', systemRole: 'USER', role: 'customer', masterSessionVersion: 'injected' },
  }, res);
  assert.equal(res.statusCode, 403);
});

test('theme publication and activation require a separate owner unlock', async (t) => {
  stubConfig(t, configuration(true));
  const routes = require('../routes/websiteCustomizationRoutes');
  for (const path of ['/themes/:id/publish', '/themes/:id/activate']) {
    const route = routes.stack.find((layer) => layer.route?.path === path).route;
    let error;
    await route.stack[0].handle({ user: owner() }, response(), (err) => { error = err; });
    assert.equal(error?.statusCode, 403, path);
  }
});

test('hybrid OTP sends real owner SMS while customer demo uses 123456 without SMS', async (t) => {
  const saved = { ...process.env };
  const previousState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  process.env.JWT_SECRET = 'isolated-unit-access-secret-not-a-real-key';
  process.env.JWT_REFRESH_SECRET = 'isolated-unit-refresh-secret-not-a-real-key';
  process.env.SMS_PROVIDER = 'twilio';
  process.env.OTP_MODE = 'demo';
  process.env.DEMO_OTP = '123456';
  process.env.ALLOW_HOSTED_OWNER_DEMO = 'false';
  try {
    let record;
    t.mock.method(crypto, 'randomInt', () => 765432);
    t.mock.method(Otp, 'findOne', () => ({ sort: async () => record && !record.isUsed ? record : null }));
    t.mock.method(Otp, 'updateMany', async () => {});
    t.mock.method(Otp, 'create', async (value) => {
      record = { ...value, _id: 'test-otp', attempts: 0, createdAt: new Date(), save: async () => record };
      return record;
    });
    t.mock.method(Otp, 'findOneAndUpdate', async () => { if (record.isUsed) return null; record.isUsed = true; return record; });
    const delivery = t.mock.method(require('../services/providers/twilioSmsProvider'), 'sendOtp', async () => ({ success: true, provider: 'twilio' }));
    const user = { _id: '0123456789abcdef01234567', phone: '9816978086', name: 'Owner', role: 'customer', save: async () => user };
    t.mock.method(User, 'findOne', async () => user);
    const controller = require('../controllers/authController');
    const sent = response();
    await controller.sendOtp({ body: { phone: '9816978086' }, ip: 'unit-success' }, sent);
    assert.equal(sent.body.otpMode, 'production');
    assert.equal(sent.body.demoOtp, undefined);
    assert.equal(sent.body.devOtp, undefined);
    assert.equal(record.trustedDelivery, true);
    assert.equal(delivery.mock.callCount(), 1);
    const verified = response();
    await controller.verifyOtp({ body: { phone: '9816978086', otp: '765432' } }, verified);
    assert.equal(verified.body.user.systemRole, 'MASTER_OWNER');
    assert.equal(verified.body.user.masterSessionVersion, undefined);
    assert.equal(policy.isMasterOwner(user), false); // Still in customer mode.
    const switched = response();
    await controller.switchMode({ user, body: { mode: 'admin' }, query: {} }, switched);
    assert.equal(policy.isMasterOwner(user), true);
    const replay = response();
    await controller.verifyOtp({ body: { phone: '9816978086', otp: '765432' } }, replay);
    assert.equal(replay.statusCode, 400);

    const customerSent = response();
    await controller.sendOtp({ body: { phone: '9876543210' }, ip: 'unit-customer-demo' }, customerSent);
    assert.equal(customerSent.statusCode, 200);
    assert.equal(customerSent.body.otpMode, 'demo');
    assert.equal(customerSent.body.demoOtp, '123456');
    assert.equal(record.provider, 'demo');
    assert.equal(delivery.mock.callCount(), 1);
  } finally {
    mongoose.connection.readyState = previousState;
    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'SMS_PROVIDER', 'OTP_MODE', 'DEMO_OTP', 'ALLOW_HOSTED_OWNER_DEMO']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('explicit hosted demo lets the owner use 123456 without Twilio and invalidates the session when demo mode is disabled', async (t) => {
  const saved = { ...process.env };
  const previousState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  Object.assign(process.env, {
    NODE_ENV: 'production', OTP_MODE: 'demo', DEMO_OTP: '123456', ALLOW_HOSTED_OWNER_DEMO: 'true',
    JWT_SECRET: 'hosted-demo-unit-access', JWT_REFRESH_SECRET: 'hosted-demo-unit-refresh', OTP_RESEND_COOLDOWN_SECONDS: '0',
  });
  try {
    const sms = t.mock.method(require('../services/providers/twilioSmsProvider'), 'sendOtp', async () => assert.fail('Hosted demo must not send SMS'));
    let record;
    t.mock.method(Otp, 'findOne', () => ({ sort: async () => record && !record.isUsed ? record : null }));
    t.mock.method(Otp, 'updateMany', async () => {});
    t.mock.method(Otp, 'create', async value => {
      record = { ...value, _id: 'hosted-demo-otp', isUsed: false, trustedDelivery: false, attempts: 0, createdAt: new Date(), save: async () => record };
      return record;
    });
    t.mock.method(Otp, 'findOneAndUpdate', async predicate => {
      assert.equal(predicate.purpose, 'master_demo_login');
      assert.equal(predicate.provider, 'hosted-demo');
      if (record.isUsed) return null;
      record.isUsed = true; return record;
    });
    const user = { _id: '0123456789abcdef01234567', phone: '9816978086', name: 'Owner', role: 'customer', save: async () => user };
    t.mock.method(User, 'findOne', async () => user);
    t.mock.method(User, 'findById', () => ({ select: async () => user }));
    const controller = require('../controllers/authController');
    const { protect } = require('../middleware/authMiddleware');
    const jwt = require('jsonwebtoken');
    const req = body => ({ body, ip: 'hosted-demo-unit', headers: { host: 'samira.example', origin: 'https://samira.example' } });

    const sent = response(); await controller.sendOtp(req({ phone: '9816978086' }), sent);
    assert.equal(sent.statusCode, 200);
    assert.equal(sent.body.otpMode, 'demo');
    assert.equal(sent.body.demoOtp, '123456');
    assert.equal(record.provider, 'hosted-demo');
    assert.equal(sms.mock.callCount(), 0);

    const verified = response(); await controller.verifyOtp(req({ phone: '9816978086', otp: '123456' }), verified);
    assert.equal(verified.statusCode, 200);
    assert.equal(jwt.decode(verified.body.token).hostedOwnerDemo, true);
    const switched = response(); await controller.switchMode({ user, body: { mode: 'admin' }, query: {} }, switched);
    assert.equal(policy.isMasterOwner(user), true);

    const accessReq = { headers: { authorization: `Bearer ${switched.body.token}` } };
    let authorized = false;
    await protect(accessReq, response(), () => { authorized = true; });
    assert.equal(authorized, true);

    process.env.OTP_MODE = 'production';
    const rejected = response();
    await protect({ headers: { authorization: `Bearer ${switched.body.token}` } }, rejected, () => assert.fail('Hosted demo token must stop working'));
    assert.equal(rejected.statusCode, 401);
  } finally {
    mongoose.connection.readyState = previousState;
    for (const key of ['NODE_ENV', 'OTP_MODE', 'DEMO_OTP', 'ALLOW_HOSTED_OWNER_DEMO', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'OTP_RESEND_COOLDOWN_SECONDS']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

function localDemoRequest(body = {}, extra = {}) {
  return {
    body, ip: 'local-demo-unit',
    app: { locals: { localOwnerDemo: true } },
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
    headers: { host: 'localhost:5000', origin: 'http://localhost:3000' },
    ...extra,
  };
}

function enableLocalDemo(t) {
  const values = { NODE_ENV: 'production', OTP_MODE: 'demo', LOCAL_OWNER_DEMO: 'true', DEMO_OTP: '123456',
    ALLOW_HOSTED_OWNER_DEMO: 'false', JWT_SECRET: 'local-demo-unit-access', JWT_REFRESH_SECRET: 'local-demo-unit-refresh', OTP_RESEND_COOLDOWN_SECONDS: '60' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => Object.keys(values).forEach(key => {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }));
}

test('local owner demo requires explicit opt-in, a loopback listener and direct local requests', (t) => {
  enableLocalDemo(t);
  const { isLocalOwnerDemoRequest } = require('../config/localOwnerDemo');
  assert.equal(isLocalOwnerDemoRequest(localDemoRequest()), true);
  for (const extra of [
    { app: { locals: {} } },
    { socket: { remoteAddress: '192.168.1.2', localAddress: '127.0.0.1' } },
    { headers: { host: 'samira.example', origin: 'https://samira.example' } },
    { headers: { host: 'localhost:5000', origin: 'https://untrusted.example' } },
    { headers: { host: 'localhost.evil.example:5000' } },
    { headers: { host: 'localhost:5000', 'x-forwarded-for': '127.0.0.1' } },
    { headers: { host: 'localhost:5000', forwarded: 'for=127.0.0.1' } },
  ]) assert.equal(isLocalOwnerDemoRequest(localDemoRequest({}, extra)), false);
  process.env.OTP_MODE = 'production';
  assert.equal(isLocalOwnerDemoRequest(localDemoRequest()), false);
  process.env.OTP_MODE = 'demo'; delete process.env.LOCAL_OWNER_DEMO;
  assert.equal(isLocalOwnerDemoRequest(localDemoRequest()), false);
});

test('local demo completes OTP, admin mode and refresh without SMS, while replay and remote sessions fail', async (t) => {
  enableLocalDemo(t);
  const previousState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = previousState; });
  const sms = t.mock.method(require('../services/providers/twilioSmsProvider'), 'sendOtp', async () => assert.fail('Local demo must not send SMS'));
  const controller = require('../controllers/authController');
  const { protect, optionalProtect } = require('../middleware/authMiddleware');
  const jwt = require('jsonwebtoken');
  let record;
  t.mock.method(Otp, 'findOne', () => ({ sort: async () => record && !record.isUsed ? record : null }));
  t.mock.method(Otp, 'updateMany', async () => {});
  t.mock.method(Otp, 'create', async value => {
    record = { ...value, _id: 'local-otp', isUsed: false, trustedDelivery: false, attempts: 0, createdAt: new Date(), save: async () => record };
    return record;
  });
  t.mock.method(Otp, 'updateOne', async () => { record.attempts += 1; });
  t.mock.method(Otp, 'findOneAndUpdate', async predicate => {
    assert.equal(predicate.purpose, 'master_demo_login');
    assert.equal(predicate.trustedDelivery, false);
    assert.equal(predicate.provider, 'local-demo');
    if (record.isUsed) return null;
    record.isUsed = true; return record;
  });
  const user = { _id: '0123456789abcdef01234567', phone: '9816978086', name: 'Owner', role: 'customer', save: async () => user };
  t.mock.method(User, 'findOne', async () => user);
  t.mock.method(User, 'findById', () => ({ select: async () => user }));
  const body = { phone: '9816978086' };
  const sent = response(); await controller.sendOtp(localDemoRequest(body), sent);
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.body.otpMode, 'demo'); assert.equal(sent.body.demoOtp, '123456');
  assert.equal(record.purpose, 'master_demo_login'); assert.equal(record.trustedDelivery, false);
  const earlyResend = response(); await controller.resendOtp(localDemoRequest(body), earlyResend);
  assert.equal(earlyResend.statusCode, 429);
  const wrong = response(); await controller.verifyOtp(localDemoRequest({ ...body, otp: '000000' }), wrong);
  assert.equal(wrong.statusCode, 400); assert.equal(record.attempts, 1);
  const remoteVerify = response(); await controller.verifyOtp(localDemoRequest({ ...body, otp: '123456' }, { headers: { host: 'live.example' } }), remoteVerify);
  assert.equal(remoteVerify.statusCode, 403); assert.equal(record.isUsed, false);
  const verified = response(); await controller.verifyOtp(localDemoRequest({ ...body, otp: '123456' }), verified);
  assert.equal(verified.statusCode, 200); assert.equal(verified.body.user.systemRole, 'MASTER_OWNER');
  assert.equal(jwt.decode(verified.body.token).localOwnerDemo, true);
  const switched = response(); await controller.switchMode({ user, body: { mode: 'admin' }, query: {} }, switched);
  assert.equal(policy.isMasterOwner(user), true);
  assert.equal(jwt.decode(switched.body.token).localOwnerDemo, true);
  const accessReq = localDemoRequest({}, { headers: { ...localDemoRequest().headers, authorization: `Bearer ${switched.body.token}` } });
  let authorized = false;
  await protect(accessReq, response(), () => { authorized = true; }); assert.equal(authorized, true);
  const refreshed = response(); await controller.refresh(localDemoRequest({ refreshToken: switched.body.refreshToken }), refreshed);
  assert.equal(refreshed.statusCode, 200); assert.equal(jwt.decode(refreshed.body.token).localOwnerDemo, true);
  const remoteReq = { headers: { host: 'live.example', authorization: `Bearer ${refreshed.body.token}` } };
  const rejectedAccess = response(); await protect(remoteReq, rejectedAccess, () => assert.fail('Must reject remote demo access'));
  assert.equal(rejectedAccess.statusCode, 401);
  await optionalProtect(remoteReq, response(), () => {}); assert.equal(remoteReq.user, undefined);
  const rejectedRefresh = response(); await controller.refresh({ body: { refreshToken: refreshed.body.refreshToken } }, rejectedRefresh);
  assert.equal(rejectedRefresh.statusCode, 401);
  const replay = response(); await controller.verifyOtp(localDemoRequest({ ...body, otp: '123456' }), replay);
  assert.equal(replay.statusCode, 400);
  await assert.rejects(require('../services/clientHandoverService').assertClientHandoverReady(), /production OTP/);
  assert.equal(sms.mock.callCount(), 0);
  // Neither a guessed marker nor an old token may promote an existing session.
  assert.equal(policy.isMasterOwner(policy.attachMasterSession(user, { masterSessionVersion: user.masterSessionVersion })), false);
});

test('local demo OTP expiry and attempt limits remain enforced', async (t) => {
  enableLocalDemo(t);
  const previousState = mongoose.connection.readyState; mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = previousState; });
  const otpService = require('../services/otpService');
  const record = { purpose: 'master_demo_login', provider: 'local-demo', otpHash: otpService.hashOtp('9816978086', '123456'),
    expiresAt: new Date(Date.now() - 1000), attempts: 0, maxAttempts: 5, save: async () => record };
  t.mock.method(Otp, 'findOne', () => ({ sort: async () => record }));
  await assert.rejects(otpService.verifyOtp('9816978086', '123456', localDemoRequest()), /OTP expired/);
  assert.equal(record.isUsed, true);
  record.isUsed = false; record.expiresAt = new Date(Date.now() + 60000); record.attempts = 5;
  await assert.rejects(otpService.verifyOtp('9816978086', '123456', localDemoRequest()), /Maximum OTP attempts/);
});

test('hosted owner demo sessions require the explicit switch and demo OTP mode', (t) => {
  const previousMode = process.env.OTP_MODE;
  const previousSwitch = process.env.ALLOW_HOSTED_OWNER_DEMO;
  t.after(() => {
    if (previousMode === undefined) delete process.env.OTP_MODE; else process.env.OTP_MODE = previousMode;
    if (previousSwitch === undefined) delete process.env.ALLOW_HOSTED_OWNER_DEMO; else process.env.ALLOW_HOSTED_OWNER_DEMO = previousSwitch;
  });
  const { allowsOwnerDemoSession } = require('../config/localOwnerDemo');
  process.env.OTP_MODE = 'demo'; process.env.ALLOW_HOSTED_OWNER_DEMO = 'true';
  assert.equal(allowsOwnerDemoSession({ hostedOwnerDemo: true }, {}), true);
  process.env.ALLOW_HOSTED_OWNER_DEMO = 'false';
  assert.equal(allowsOwnerDemoSession({ hostedOwnerDemo: true }, {}), false);
  process.env.ALLOW_HOSTED_OWNER_DEMO = 'true'; process.env.OTP_MODE = 'production';
  assert.equal(allowsOwnerDemoSession({ hostedOwnerDemo: true }, {}), false);
});
