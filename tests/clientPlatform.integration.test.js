const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { getBaseUrl, request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createMasterOwner } = require('./accessFixtures');
const platform = require('../services/clientPlatformService');
const { verifyEnvelope } = require('../services/licenseSignatureService');
const InstallationPayment = require('../models/InstallationPayment');
const ClientInstallation = require('../models/ClientInstallation');
const ClientInstallationOperation = require('../models/ClientInstallationOperation');

process.env.RAZORPAY_KEY_ID = 'rzp_test_client_platform';
process.env.RAZORPAY_KEY_SECRET = 'client_platform_test_secret';
process.env.RAZORPAY_MOCK = '1';

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

async function provision(name, slug) {
  const master = await createMasterOwner();
  return { master, ...(await platform.provisionInstallation({ companyName: name, projectName: name, projectSlug: slug, industry: 'fashion' }, master.user)) };
}

test('each generated client authenticates independently and receives a signed bounded entitlement', async () => {
  const first = await provision('First Client', 'first-client');
  const second = await provision('Second Client', 'second-client');
  const headers = { 'x-installation-id': first.credentials.installationId, 'x-license-key': first.credentials.licenseKey };
  const response = await request('/api/platform/validate', { method: 'POST', headers, body: { appVersion: '1.0.0' } });
  assert.equal(response.status, 200);
  const payload = verifyEnvelope(response.data, first.credentials.signingPublicKey);
  assert.equal(payload.installationId, first.credentials.installationId);
  assert.equal(payload.status, 'TRIAL');
  assert.equal(payload.limits.products, 1000);
  assert.ok(new Date(payload.validUntil) < new Date(payload.graceUntil));
  assert.doesNotMatch(JSON.stringify(response.data), new RegExp(first.credentials.licenseKey));

  const crossed = await request('/api/platform/validate', { method: 'POST', headers: { ...headers, 'x-installation-id': second.credentials.installationId }, body: { appVersion: '1.0.0' } });
  assert.equal(crossed.status, 401);
});

test('master changes and subscription payments affect only the selected installation', async () => {
  const first = await provision('Paid Client', 'paid-client');
  const second = await provision('Other Client', 'other-client');
  const masterHeaders = { token: first.master.token };
  const changed = await request(`/api/master/installations/${first.installation._id}`, {
    method: 'PATCH', ...masterHeaders,
    body: { plan: 'BASIC', limitOverrides: { products: 12, ordersPerMonth: 30 }, grant: 'MONTHLY' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.installation.limits.products, 12);
  assert.equal(changed.data.installation.status, 'ACTIVE');

  const checkout = await request('/api/platform/subscription/checkout', {
    method: 'POST',
    headers: { 'x-installation-id': first.credentials.installationId, 'x-license-key': first.credentials.licenseKey },
    body: { plan: 'PROFESSIONAL', billingCycle: 'YEARLY', amount: 1 },
  });
  assert.equal(checkout.status, 200);
  assert.equal(checkout.data.amount, 19990 * 100);
  const paymentId = 'pay_client_platform';
  const signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${checkout.data.orderId}|${paymentId}`).digest('hex');
  const verification = await request('/api/platform/subscription/verify', {
    method: 'POST',
    headers: { 'x-installation-id': first.credentials.installationId, 'x-license-key': first.credentials.licenseKey },
    body: { razorpay_order_id: checkout.data.orderId, razorpay_payment_id: paymentId, razorpay_signature: signature },
  });
  assert.equal(verification.status, 200);
  assert.equal(await InstallationPayment.countDocuments({ installation: first.installation._id, status: 'PAID' }), 1);

  const other = await platform.validateInstallation({ installationId: second.credentials.installationId, secret: second.credentials.licenseKey, appVersion: '1.0.0' });
  assert.equal(verifyEnvelope(other, second.credentials.signingPublicKey).status, 'TRIAL');
});

test('staged key rotation keeps the previous key until the replacement checks in', async () => {
  const first = await provision('Rotated Client', 'rotated-client');
  const previousEncryptionKey = process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY;
  process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY = 'test-only-client-platform-encryption-key';
  try {
    const response = await request(`/api/master/installations/${first.installation._id}/rotate-key`, { method: 'POST', token: first.master.token, body: { baseRevision: 0, reason: 'Scheduled credential maintenance', idempotencyKey: 'key:test:rotation:001' } });
    assert.equal(response.status, 200);
    assert.notEqual(response.data.credentials.CLIENT_LICENSE_KEY, first.credentials.licenseKey);
    const oldBeforeCheckIn = await request('/api/platform/validate', { method: 'POST', headers: { 'x-installation-id': first.credentials.installationId, 'x-license-key': first.credentials.licenseKey }, body: { appVersion: '1.0.0' } });
    assert.equal(oldBeforeCheckIn.status, 200);
    const newKey = await request('/api/platform/validate', { method: 'POST', headers: { 'x-installation-id': first.credentials.installationId, 'x-license-key': response.data.credentials.CLIENT_LICENSE_KEY }, body: { appVersion: '1.0.0' } });
    assert.equal(newKey.status, 200);
    const oldAfterCheckIn = await request('/api/platform/validate', { method: 'POST', headers: { 'x-installation-id': first.credentials.installationId, 'x-license-key': first.credentials.licenseKey }, body: { appVersion: '1.0.0' } });
    assert.equal(oldAfterCheckIn.status, 401);
    assert.doesNotMatch(JSON.stringify(newKey.data), new RegExp(response.data.credentials.CLIENT_LICENSE_KEY));
  } finally {
    if (previousEncryptionKey === undefined) delete process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY = previousEncryptionKey;
  }
});

test('staged key rotation cannot silently replace another live pending key', async () => {
  const client = await provision('Protected Rotation Client', 'protected-rotation-client');
  const previousEncryptionKey = process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY;
  process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY = 'test-only-client-platform-encryption-key';
  try {
    const first = await request(`/api/master/installations/${client.installation._id}/rotate-key`, {
      method: 'POST', token: client.master.token,
      body: { baseRevision: 0, reason: 'Scheduled credential rotation', idempotencyKey: 'key:test:protected:001' },
    });
    assert.equal(first.status, 200);
    const replacement = await request(`/api/master/installations/${client.installation._id}/rotate-key`, {
      method: 'POST', token: client.master.token,
      body: { baseRevision: 1, reason: 'Accidental second credential rotation', idempotencyKey: 'key:test:protected:002' },
    });
    assert.equal(replacement.status, 409);
    assert.equal(replacement.data.code, 'DUPLICATE_REQUEST');
    const recovered = await request(`/api/master/installations/${client.installation._id}/rotate-key`, {
      method: 'POST', token: client.master.token,
      body: { baseRevision: 1, reason: 'Scheduled credential rotation', idempotencyKey: 'key:test:protected:001' },
    });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.duplicate, true);
    assert.equal(recovered.data.credentials.CLIENT_LICENSE_KEY, first.data.credentials.CLIENT_LICENSE_KEY);
  } finally {
    if (previousEncryptionKey === undefined) delete process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY = previousEncryptionKey;
  }
});

test('generated backend enforces the signed product limit even when a browser bypasses UI checks', async () => {
  const client = await provision('Limited Client', 'limited-client');
  await platform.updateInstallation(client.installation._id, { plan: 'BASIC', limitOverrides: { products: 0, ordersPerMonth: 10 }, grant: 'MONTHLY' });
  Object.assign(process.env, {
    CONTROL_PLANE_URL: getBaseUrl(),
    CLIENT_INSTALLATION_ID: client.credentials.installationId,
    CLIENT_LICENSE_KEY: client.credentials.licenseKey,
    LICENSE_SIGNING_PUBLIC_KEY: client.credentials.signingPublicKey,
    APP_VERSION: '1.0.0',
  });
  try {
    const business = await request('/api/admin/business/overview', { token: client.master.token });
    assert.equal(business.status, 200);
    assert.equal(business.data.platform.id, 'BASIC');
    assert.equal(business.data.platform.managed, true);
    const blockedCampaign = await request('/api/admin/business/festival', {
      method: 'PUT', token: client.master.token,
      body: { enabled: true, preset: 'diwali', title: 'Browser bypass' },
    });
    assert.equal(blockedCampaign.status, 403);
    assert.equal(blockedCampaign.data.code, 'PLAN_FEATURE_REQUIRED');
    const response = await request('/api/admin/products', { method: 'POST', token: client.master.token, body: { name: 'Bypassed browser check' } });
    assert.equal(response.status, 409);
    assert.equal(response.data.code, 'PLAN_LIMIT_REACHED');
  } finally {
    for (const key of ['CONTROL_PLANE_URL', 'CLIENT_INSTALLATION_ID', 'CLIENT_LICENSE_KEY', 'LICENSE_SIGNING_PUBLIC_KEY', 'APP_VERSION']) delete process.env[key];
  }
});

test('a published release can target one eligible client without changing another client', async () => {
  const first = await provision('Update Client', 'update-client');
  const second = await provision('Stable Client', 'stable-client');
  const release = await request('/api/master/releases', { method: 'POST', token: first.master.token, body: { version: '1.2.0', channel: 'stable', eligibleIndustries: ['fashion'], notes: 'Verified release' } });
  assert.equal(release.status, 201);
  const assigned = await request(`/api/master/installations/${first.installation._id}`, { method: 'PATCH', token: first.master.token, body: { targetVersion: '1.2.0' } });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.installation.updateAvailable, true);
  const firstEnvelope = await platform.validateInstallation({ installationId: first.credentials.installationId, secret: first.credentials.licenseKey, appVersion: '1.0.0' });
  const secondEnvelope = await platform.validateInstallation({ installationId: second.credentials.installationId, secret: second.credentials.licenseKey, appVersion: '1.0.0' });
  assert.equal(verifyEnvelope(firstEnvelope, first.credentials.signingPublicKey).targetVersion, '1.2.0');
  assert.equal(verifyEnvelope(secondEnvelope, second.credentials.signingPublicKey).targetVersion, '1.0.0');
});

test('client control searches installations and returns isolated profile, feature, usage and activity data', async () => {
  const client = await provision('North Fashion Client', 'north-fashion-client');
  await platform.validateInstallation({
    installationId: client.credentials.installationId,
    secret: client.credentials.licenseKey,
    appVersion: '1.0.0',
    telemetry: { products: 17, ordersPerMonth: 9, databaseStatus: 'CONNECTED', serviceStatus: 'HEALTHY' },
  });
  const changed = await request(`/api/master/installations/${client.installation._id}`, {
    method: 'PATCH', token: client.master.token,
    body: {
      plan: 'BASIC', grant: 'MONTHLY', featureOverrides: ['businessAssistant'], disabledFeatures: ['coupons'],
      contact: { ownerName: 'Asha Sharma', phone: '9811111111', email: 'ASHA@example.com' }, tags: ['priority', 'north'],
    },
  });
  assert.equal(changed.status, 200);
  assert.ok(changed.data.installation.features.includes('businessAssistant'));
  assert.ok(!changed.data.installation.features.includes('coupons'));
  assert.equal(changed.data.installation.usage.products, 17);

  const list = await request('/api/master/clients?q=asha&plan=BASIC', { token: client.master.token });
  assert.equal(list.status, 200);
  assert.equal(list.data.pagination.total, 1);
  assert.equal(list.data.installations[0].contact.email, 'asha@example.com');
  assert.equal(list.data.installations[0].health.status, 'ONLINE');

  const operations = await request(`/api/master/installations/${client.installation._id}/operations`, { token: client.master.token });
  assert.equal(operations.status, 200);
  assert.equal(operations.data.installation.usage.ordersPerMonth, 9);
  assert.equal(operations.data.paymentTotal, 0);
  assert.ok(operations.data.activity.some((entry) => entry.action === 'CLIENT_INSTALLATION_UPDATE'));
});

test('client attention reports live risks without treating inactive clients as offline', async () => {
  const risk = await provision('Risk Client', 'risk-client');
  const inactive = await provision('Inactive Client', 'inactive-client');
  await ClientInstallation.updateOne({ _id: risk.installation._id }, {
    $set: {
      status: 'ACTIVE', billingCycle: 'LIFETIME', endsAt: null, lastSeenAt: null,
      'billingReview.required': true, 'billingReview.reason': 'Verify a refunded payment',
      'limitOverrides.products': 10, 'usage.products': 9,
    },
  });
  await ClientInstallation.updateOne({ _id: inactive.installation._id }, { $set: { status: 'REVOKED', lastSeenAt: null } });

  const workspace = await platform.clientControlWorkspace({ attention: 'risks' });
  assert.equal(workspace.pagination.total, 1);
  assert.equal(workspace.installations[0].companyName, 'Risk Client');
  assert.ok(workspace.installations[0].attention.some((item) => item.code === 'OFFLINE'));
  assert.ok(workspace.installations[0].attention.some((item) => item.code === 'BILLING_REVIEW'));
  assert.ok(workspace.installations[0].attention.some((item) => item.code === 'LIMIT_PRODUCTS'));
  assert.equal(workspace.summary.needsAttention, 1);

  const all = await platform.clientControlWorkspace({});
  const revoked = all.installations.find((item) => item.companyName === 'Inactive Client');
  assert.ok(revoked);
  assert.ok(!revoked.attention.some((item) => item.code === 'OFFLINE'));
});

test('section saves are revision checked and never apply unrelated unsaved fields', async () => {
  const client = await provision('Safe Save Client', 'safe-save-client');
  const profile = await request(`/api/master/installations/${client.installation._id}/profile`, {
    method: 'PATCH', token: client.master.token,
    body: { baseRevision: 0, contact: { ownerName: 'Safe Owner', phone: '9811111111', email: 'safe@example.com' }, tags: 'priority, north', notes: 'Profile only' },
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.installation.revision, 1);
  assert.equal(profile.data.installation.plan, 'PROFESSIONAL');
  assert.equal(profile.data.installation.contact.email, 'safe@example.com');

  const stale = await request(`/api/master/installations/${client.installation._id}/entitlements`, {
    method: 'PATCH', token: client.master.token,
    body: { baseRevision: 0, reason: 'Stale feature update', featureOverrides: ['businessAssistant'], disabledFeatures: [], limitOverrides: {} },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'DUPLICATE_REQUEST');
  const stored = await ClientInstallation.findById(client.installation._id);
  assert.deepEqual(stored.featureOverrides, []);
});

test('manual access grants are reasoned and idempotent', async () => {
  const client = await provision('Grant Client', 'grant-client');
  const body = { baseRevision: 0, plan: 'PROFESSIONAL', billingCycle: 'MONTHLY', source: 'MANUAL_PAYMENT', reference: 'cash-001', reason: 'Payment received outside gateway', idempotencyKey: 'grant:test:client:001' };
  const first = await request(`/api/master/installations/${client.installation._id}/subscription/grants`, { method: 'POST', token: client.master.token, body });
  assert.equal(first.status, 200);
  assert.equal(first.data.duplicate, false);
  const firstEnd = first.data.installation.endsAt;
  const repeated = await request(`/api/master/installations/${client.installation._id}/subscription/grants`, { method: 'POST', token: client.master.token, body });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.duplicate, true);
  assert.equal(repeated.data.installation.endsAt, firstEnd);
  assert.equal(await ClientInstallationOperation.countDocuments({ installation: client.installation._id, type: 'ACCESS_GRANT' }), 1);
});

test('lifecycle actions require a reason and restore only a valid access period', async () => {
  const client = await provision('Lifecycle Client', 'lifecycle-client');
  const missingReason = await request(`/api/master/installations/${client.installation._id}/lifecycle`, { method: 'PATCH', token: client.master.token, body: { baseRevision: 0, action: 'SUSPEND' } });
  assert.equal(missingReason.status, 400);
  const suspended = await request(`/api/master/installations/${client.installation._id}/lifecycle`, { method: 'PATCH', token: client.master.token, body: { baseRevision: 0, action: 'SUSPEND', reason: 'Manual compliance review' } });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.data.installation.status, 'SUSPENDED');
  const restored = await request(`/api/master/installations/${client.installation._id}/lifecycle`, { method: 'PATCH', token: client.master.token, body: { baseRevision: 1, action: 'RESTORE', reason: 'Review completed successfully' } });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.installation.status, 'TRIAL');
});

test('a full refund of the latest client payment suspends access for billing review', async () => {
  const client = await provision('Refund Client', 'refund-client');
  const payment = await InstallationPayment.create({ installation: client.installation._id, installationId: client.credentials.installationId, plan: 'PROFESSIONAL', billingCycle: 'MONTHLY', amount: 1999, baseAmount: 1694, taxAmount: 305, currency: 'INR', status: 'PAID', receipt: 'client_refund_test', razorpayOrderId: 'order_client_refund', razorpayPaymentId: 'pay_client_refund', paidAt: new Date() });
  await ClientInstallation.updateOne({ _id: client.installation._id }, { $set: { status: 'ACTIVE', billingCycle: 'MONTHLY', endsAt: new Date(Date.now() + 20 * 86400000), lastPayment: { orderId: payment.razorpayOrderId, paymentId: payment.razorpayPaymentId, amount: payment.amount, currency: 'INR', paidAt: new Date() } } });
  const result = await platform.handleRefundWebhook({ razorpayPaymentId: payment.razorpayPaymentId, refundId: 'refund_client_full', refundedAmount: 1999 });
  assert.equal(result.outcome, 'REFUNDED');
  assert.equal(result.installation.status, 'SUSPENDED');
  assert.equal(result.installation.billingReview.required, true);
  const repeated = await platform.handleRefundWebhook({ razorpayPaymentId: payment.razorpayPaymentId, refundId: 'refund_client_full', refundedAmount: 1999 });
  assert.equal(repeated.duplicate, true);
  assert.equal((await InstallationPayment.findById(payment._id)).refunds.length, 1);
});

test('release rollout state is revision checked and can be paused and resumed', async () => {
  const client = await provision('Release Owner', 'release-owner');
  const created = await request('/api/master/releases', { method: 'POST', token: client.master.token, body: { version: '2.0.0', channel: 'stable', rolloutPercent: 20, notes: 'Canary release', artifact: { repository: 'owner/repository', commitSha: 'abcdef1234567', minimumProtocol: 1 } } });
  assert.equal(created.status, 201);
  const paused = await request(`/api/master/releases/${created.data.release._id}`, { method: 'PATCH', token: client.master.token, body: { baseRevision: 0, action: 'PAUSE', reason: 'Observe canary metrics' } });
  assert.equal(paused.status, 200);
  assert.equal(paused.data.release.rolloutStatus, 'PAUSED');
  const stale = await request(`/api/master/releases/${created.data.release._id}`, { method: 'PATCH', token: client.master.token, body: { baseRevision: 0, action: 'RESUME', rolloutPercent: 50, reason: 'Stale request' } });
  assert.equal(stale.status, 409);
  const resumed = await request(`/api/master/releases/${created.data.release._id}`, { method: 'PATCH', token: client.master.token, body: { baseRevision: 1, action: 'RESUME', rolloutPercent: 50, reason: 'Canary health is stable' } });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.release.rolloutPercent, 50);
  assert.equal(resumed.data.release.rolloutStatus, 'ACTIVE');
});

test('deployment hooks are encrypted, hidden from responses and trigger only the selected client build', async () => {
  const client = await provision('Deploy Client', 'deploy-client');
  const received = [];
  const hookServer = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url });
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{"accepted":true}');
  });
  await new Promise((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
  const hookUrl = `http://127.0.0.1:${hookServer.address().port}/private-deploy-token`;
  const previousEncryptionKey = process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY;
  process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY = 'test-only-client-platform-encryption-key';
  try {
    const connected = await request(`/api/master/installations/${client.installation._id}`, {
      method: 'PATCH', token: client.master.token, body: { deployHookUrl: hookUrl },
    });
    assert.equal(connected.status, 200);
    assert.equal(connected.data.installation.deployment.hasHook, true);
    assert.doesNotMatch(JSON.stringify(connected.data), /private-deploy-token/);

    const stored = await ClientInstallation.findById(client.installation._id).select('+deployHookCiphertext +deployHookIv +deployHookTag');
    assert.ok(stored.deployHookCiphertext);
    assert.ok(stored.deployHookIv);
    assert.ok(stored.deployHookTag);
    assert.equal(stored.deployHookCiphertext.includes('private-deploy-token'), false);

    const deployed = await request(`/api/master/installations/${client.installation._id}/deploy`, {
      method: 'POST', token: client.master.token, body: {},
    });
    assert.equal(deployed.status, 200);
    assert.equal(deployed.data.installation.deployment.last.status, 'SUCCEEDED');
    assert.deepEqual(received, [{ method: 'POST', url: '/private-deploy-token' }]);
    assert.doesNotMatch(JSON.stringify(deployed.data), /private-deploy-token/);
  } finally {
    if (previousEncryptionKey === undefined) delete process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY = previousEncryptionKey;
    await new Promise((resolve) => hookServer.close(resolve));
  }
});
