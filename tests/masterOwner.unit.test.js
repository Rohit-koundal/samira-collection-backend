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
  const values = { NODE_ENV: 'production', OTP_MODE: 'demo', LOCAL_OWNER_DEMO: 'true', ALLOW_HOSTED_OWNER_DEMO: 'false', DEMO_OTP: '123456',
    JWT_SECRET: 'local-demo-unit-access', JWT_REFRESH_SECRET: 'local-demo-unit-refresh', OTP_RESEND_COOLDOWN_SECONDS: '60' };
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

function hostedDemoRequest(body = {}, extra = {}) {
  return {
    body, ip: 'hosted-demo-unit', socket: { remoteAddress: '10.0.0.2', localAddress: '10.0.0.3' },
    headers: { host: 'demo-store.example', origin: 'https://demo-shop.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.5' },
    ...extra,
  };
}

test('hosted owner demo requires both explicit settings and takes precedence over local binding', (t) => {
  enableLocalDemo(t);
  const demo = require('../config/localOwnerDemo');
  assert.equal(demo.getOwnerDemoProvider(hostedDemoRequest()), '');
  process.env.ALLOW_HOSTED_OWNER_DEMO = 'true';
  assert.equal(demo.isHostedOwnerDemoEnabled(), true);
  assert.equal(demo.isLocalOwnerDemoEnabled(), false);
  assert.equal(demo.getOwnerDemoProvider(hostedDemoRequest()), 'hosted-demo');
  assert.equal(demo.allowsOwnerDemoSession({ localOwnerDemo: true }, hostedDemoRequest()), false);
  assert.equal(demo.allowsOwnerDemoSession({ hostedOwnerDemo: true }, hostedDemoRequest()), true);
  assert.equal(demo.allowsOwnerDemoSession({ hostedOwnerDemo: true, localOwnerDemo: true }, hostedDemoRequest()), false);
  for (const mode of ['production', '', 'invalid']) {
    process.env.OTP_MODE = mode;
    assert.equal(demo.isHostedOwnerDemoEnabled(), false);
    assert.equal(demo.getOwnerDemoProvider(hostedDemoRequest()), '');
    assert.equal(demo.allowsOwnerDemoSession({ hostedOwnerDemo: true }, hostedDemoRequest()), false);
  }
  delete process.env.OTP_MODE;
  assert.equal(demo.isHostedOwnerDemoEnabled(), false);
});

test('hosted demo works through a proxy and its OTPs and sessions stop working when disabled', async (t) => {
  enableLocalDemo(t);
  process.env.ALLOW_HOSTED_OWNER_DEMO = 'true'; process.env.DEMO_OTP = '654321';
  const previousState = mongoose.connection.readyState; mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = previousState; });
  const sms = t.mock.method(require('../services/providers/twilioSmsProvider'), 'sendOtp', async () => assert.fail('Hosted demo must not send SMS'));
  const controller = require('../controllers/authController');
  const { protect, optionalProtect } = require('../middleware/authMiddleware');
  const jwt = require('jsonwebtoken');
  let record;
  t.mock.method(Otp, 'findOne', () => ({ sort: async () => record && !record.isUsed ? record : null }));
  t.mock.method(Otp, 'updateMany', async () => {});
  t.mock.method(Otp, 'create', async value => {
    record = { ...value, _id: 'hosted-otp', isUsed: false, trustedDelivery: false, attempts: 0, createdAt: new Date(), save: async () => record };
    return record;
  });
  t.mock.method(Otp, 'updateOne', async () => { record.attempts += 1; });
  t.mock.method(Otp, 'findOneAndUpdate', async predicate => {
    assert.equal(predicate.purpose, 'master_demo_login'); assert.equal(predicate.trustedDelivery, false);
    assert.equal(predicate.provider, 'hosted-demo'); assert.deepEqual(predicate.attempts, { $lt: 5 });
    assert.ok(predicate.expiresAt.$gt instanceof Date);
    if (record.isUsed) return null;
    record.isUsed = true; return record;
  });
  const user = { _id: '0123456789abcdef01234567', phone: '9816978086', name: 'Owner', role: 'customer', save: async () => user };
  t.mock.method(User, 'findOne', async () => user);
  t.mock.method(User, 'findById', () => ({ select: async () => user }));
  const body = { phone: '9816978086' };
  const sent = response(); await controller.sendOtp(hostedDemoRequest(body), sent);
  assert.equal(sent.statusCode, 200); assert.equal(sent.body.demoOtp, '654321'); assert.equal(sent.body.otpMode, 'demo');
  assert.equal(record.provider, 'hosted-demo'); assert.equal(record.trustedDelivery, false);
  const earlyResend = response(); await controller.resendOtp(hostedDemoRequest(body), earlyResend); assert.equal(earlyResend.statusCode, 429);
  const wrong = response(); await controller.verifyOtp(hostedDemoRequest({ ...body, otp: '000000' }), wrong);
  assert.equal(wrong.statusCode, 400); assert.equal(record.attempts, 1);
  process.env.ALLOW_HOSTED_OWNER_DEMO = 'false';
  const disabledOtp = response(); await controller.verifyOtp(hostedDemoRequest({ ...body, otp: '654321' }), disabledOtp);
  assert.equal(disabledOtp.statusCode, 403); assert.equal(record.isUsed, false);
  process.env.ALLOW_HOSTED_OWNER_DEMO = 'true';
  const verified = response(); await controller.verifyOtp(hostedDemoRequest({ ...body, otp: '654321' }), verified);
  assert.equal(verified.statusCode, 200); assert.equal(verified.body.user.systemRole, 'MASTER_OWNER');
  assert.equal(jwt.decode(verified.body.token).hostedOwnerDemo, true);
  assert.equal(jwt.decode(verified.body.token).localOwnerDemo, undefined);
  const switched = response(); await controller.switchMode({ user, body: { mode: 'admin' }, query: {} }, switched);
  assert.equal(policy.isMasterOwner(user), true); assert.equal(jwt.decode(switched.body.token).hostedOwnerDemo, true);
  const accessReq = hostedDemoRequest({}, { headers: { ...hostedDemoRequest().headers, authorization: `Bearer ${switched.body.token}` } });
  let authorized = false; await protect(accessReq, response(), () => { authorized = true; }); assert.equal(authorized, true);
  const refreshed = response(); await controller.refresh(hostedDemoRequest({ refreshToken: switched.body.refreshToken }), refreshed);
  assert.equal(refreshed.statusCode, 200); assert.equal(jwt.decode(refreshed.body.token).hostedOwnerDemo, true);
  const replay = response(); await controller.verifyOtp(hostedDemoRequest({ ...body, otp: '654321' }), replay); assert.equal(replay.statusCode, 400);
  await assert.rejects(require('../services/clientHandoverService').assertClientHandoverReady(), /production OTP/);
  for (const mode of ['disabled', 'production']) {
    process.env.ALLOW_HOSTED_OWNER_DEMO = mode === 'disabled' ? 'false' : 'true';
    process.env.OTP_MODE = mode === 'production' ? 'production' : 'demo';
    const rejectedAccess = response(); await protect(accessReq, rejectedAccess, () => assert.fail('Disabled demo access must fail'));
    assert.equal(rejectedAccess.statusCode, 401);
    const optionalReq = hostedDemoRequest({}, { headers: accessReq.headers });
    await optionalProtect(optionalReq, response(), () => {}); assert.equal(optionalReq.user, undefined);
    const rejectedRefresh = response(); await controller.refresh(hostedDemoRequest({ refreshToken: refreshed.body.refreshToken }), rejectedRefresh);
    assert.equal(rejectedRefresh.statusCode, 401);
  }
  assert.equal(sms.mock.callCount(), 0);
  assert.equal(policy.isMasterOwner(policy.attachMasterSession(user, { masterSessionVersion: user.masterSessionVersion })), false);
  const realSms = t.mock.method(require('../services/providers/twilioSmsProvider'), 'sendOtp', async () => ({ success: true, provider: 'twilio' }));
  const savedSmsProvider = process.env.SMS_PROVIDER;
  process.env.SMS_PROVIDER = 'twilio';
  t.after(() => { if (savedSmsProvider === undefined) delete process.env.SMS_PROVIDER; else process.env.SMS_PROVIDER = savedSmsProvider; });
  const liveOtp = response(); await controller.sendOtp(hostedDemoRequest(body), liveOtp);
  assert.equal(liveOtp.statusCode, 200); assert.equal(liveOtp.body.otpMode, 'production');
  assert.equal(liveOtp.body.demoOtp, undefined); assert.equal(realSms.mock.callCount(), 1);
  assert.equal(record.purpose, 'master_login'); assert.equal(record.trustedDelivery, true);
});
