// No listening server, database process, SMS or .env file is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Configuration = require('../models/MasterConfiguration');
const Product = require('../models/Product');
const User = require('../models/User');
const Otp = require('../models/Otp');
const policy = require('../config/masterOwner');
const { DEFAULT_STRUCTURE, INDUSTRY_PRESETS } = require('../config/industryPresets');
const service = require('../services/masterConfigurationService');
const copy = (value) => JSON.parse(JSON.stringify(value));
const owner = () => policy.attachMasterSession({
  _id: '0123456789abcdef01234567', phone: '9816978086', role: 'admin', activeMode: 'admin',
  systemRole: 'MASTER_OWNER', isPhoneVerified: true, masterSessionVersion: 'fresh-owner-session',
}, { masterSessionVersion: 'fresh-owner-session' });
const configuration = (locked = false) => ({ _id: 'store', locked, revision: 2, history: [], structure: service.validateStructure(copy(DEFAULT_STRUCTURE)) });
const stubConfig = (t, value) => t.mock.method(Configuration, 'findById', () => ({ lean: async () => value }));
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} });

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
  for (const action of ['workspace', 'update', 'export', 'import', 'createPreset', 'deletePreset', 'provisionAdmin']) {
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
  for (const preset of INDUSTRY_PRESETS) {
    const result = service.validateStructure({ ...copy(preset), clientPermissions: { content: true, payments: true } });
    assert.equal(result.features.sizing, preset.industry === 'fashion');
    assert.ok(result.attributes.length >= 3);
  }
});

test('rejects malicious, duplicate and incomplete structural definitions', () => {
  for (const attributes of [
    [{ key: '__proto__', label: 'Bad' }], [{ key: 'constructor', label: 'Bad' }],
    [{ key: 'ram', label: 'RAM' }, { key: 'ram', label: 'Other' }],
    [{ key: 'ram', label: '' }], [{ key: 'ram', label: 'RAM', required: 'true' }],
  ]) assert.throws(() => service.validateStructure({ ...copy(DEFAULT_STRUCTURE), attributes }), { statusCode: 400 });
  assert.throws(() => service.validateStructure({ ...copy(DEFAULT_STRUCTURE), industry: 'unknown' }), { statusCode: 400 });
  assert.throws(() => service.validateStructure({ ...copy(DEFAULT_STRUCTURE), industry: 'electronics' }), { statusCode: 400 });
  assert.throws(() => service.validateStructure({ ...copy(DEFAULT_STRUCTURE), features: { sizing: true, specifications: false } }), { statusCode: 400 });
});

test('public configuration never includes lock history, owner identity or client permissions', () => {
  const result = service.publicStructure({ ...configuration(), updatedBy: 'owner', history: [{ actor: 'owner' }] });
  assert.deepEqual(Object.keys(result).sort(), ['attributes', 'features', 'industry', 'revision']);
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

test('conversion with an existing catalog is refused without deleting products', async (t) => {
  stubConfig(t, configuration());
  t.mock.method(Configuration, 'findOneAndUpdate', async () => ({}));
  t.mock.method(Product, 'exists', async () => ({ _id: 'existing' }));
  const structure = { ...copy(INDUSTRY_PRESETS.find((preset) => preset.industry === 'electronics')), clientPermissions: { content: true, payments: true } };
  await assert.rejects(service.updateConfiguration(owner(), { revision: 2, structure }), /archive incompatible products/);
});

test('used attribute definitions cannot be renamed or removed silently', async (t) => {
  const before = configuration();
  stubConfig(t, before);
  t.mock.method(Configuration, 'findOneAndUpdate', async () => ({}));
  t.mock.method(Product, 'exists', async () => ({ _id: 'existing' }));
  await assert.rejects(service.updateConfiguration(owner(), { revision: 2, structure: { ...before.structure, attributes: [] } }), /used by products/);
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
  config.structure = { ...copy(INDUSTRY_PRESETS.find((preset) => preset.industry === 'electronics')), clientPermissions: { content: true, payments: true } };
  stubConfig(t, config);
  const result = await service.applyProductStructure({ sizes: ['S'], sizingMode: 'sized', variants: [{ size: 'S' }], attributeValues: { ram: 8 } });
  assert.equal(result.sizingMode, 'free-size');
  assert.deepEqual(result.sizes, []);
  assert.deepEqual(result.variants, []);
  assert.equal(result.attributeValues.ram, '8');
  assert.equal(result.specifications[0].unit, 'GB');
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

test('handover blocks development, demo and implicit mock OTP provider configurations', async (t) => {
  const saved = { ...process.env };
  try {
    const { assertClientHandoverReady } = require('../services/clientHandoverService');
    process.env.NODE_ENV = 'production'; process.env.OTP_MODE = 'production'; process.env.SMS_PROVIDER = 'twilio';
    delete process.env.OTP_PROVIDER;
    await assert.rejects(assertClientHandoverReady(), /real SMS/);
    process.env.OTP_PROVIDER = 'twilio';
    stubConfig(t, configuration(false));
    await assert.rejects(assertClientHandoverReady(), /Lock/);
  } finally {
    for (const key of ['NODE_ENV', 'OTP_MODE', 'SMS_PROVIDER', 'OTP_PROVIDER']) {
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

test('real-delivery owner OTP flow grants master access only after verification and admin mode', async (t) => {
  const saved = { ...process.env };
  const previousState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  process.env.JWT_SECRET = 'isolated-unit-access-secret-not-a-real-key';
  process.env.JWT_REFRESH_SECRET = 'isolated-unit-refresh-secret-not-a-real-key';
  process.env.SMS_PROVIDER = 'twilio';
  process.env.OTP_MODE = 'demo';
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
  } finally {
    mongoose.connection.readyState = previousState;
    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'SMS_PROVIDER', 'OTP_MODE']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
