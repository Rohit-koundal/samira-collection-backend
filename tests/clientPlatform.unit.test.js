const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const babelParser = require('@babel/parser');
const { INDUSTRY_PRESETS } = require('../config/industryPresets');
const projectGenerator = require('../services/projectGeneratorService');
const platform = require('../services/clientPlatformService');
const signatures = require('../services/licenseSignatureService');

function readZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const filenameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + filenameLength).toString('utf8');
    const start = offset + 30 + filenameLength + extraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? zlib.inflateRawSync(compressed) : compressed);
    offset = start + compressedSize;
  }
  return entries;
}

test('signed platform envelopes reject changes and verify the original entitlement', () => {
  const envelope = signatures.signPayload({ installationId: 'client_123', status: 'ACTIVE', limits: { products: 100 } });
  const publicKey = signatures.publicKeyBase64();
  assert.equal(signatures.verifyEnvelope(envelope, publicKey).status, 'ACTIVE');
  assert.equal(signatures.verifyEnvelope({ ...envelope, payload: `${envelope.payload}x` }, publicKey), null);
});

test('version comparison and per-installation limits are deterministic', () => {
  assert.equal(platform.compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(platform.compareVersions('2.0.0', '2.0.0'), 0);
  const summary = platform.effectivePlatform({
    plan: 'PROFESSIONAL', status: 'ACTIVE', billingCycle: 'LIFETIME',
    startsAt: new Date(), limitOverrides: { products: 25, ordersPerMonth: null },
    featureOverrides: [], disabledFeatures: [],
  });
  assert.equal(summary.limits.products, 25);
  assert.equal(summary.limits.ordersPerMonth, 2000);
});

test('managed project package contains only its one-time client identity and excludes control-plane source', async () => {
  const structure = INDUSTRY_PRESETS.find((item) => item.industry === 'mobile');
  const result = await projectGenerator.generateProject({ companyName: 'Client Mobile', projectName: 'Client Mobile', projectSlug: 'client-mobile', includeAiWorker: false }, structure, {
    installation: {
      controlPlaneUrl: 'https://control.example', installationId: 'client_test_123',
      licenseKey: 'one-time-private-key', signingPublicKey: 'public-signing-key', appVersion: '1.0.0',
    },
  });
  const entries = readZip(result.buffer);
  const prefix = 'client-mobile/';
  const credentials = JSON.parse(entries.get(`${prefix}client-installation.json`).toString('utf8'));
  assert.equal(credentials.CLIENT_INSTALLATION_ID, 'client_test_123');
  assert.equal(credentials.CLIENT_LICENSE_KEY, 'one-time-private-key');
  assert.equal(entries.get(`${prefix}project-manifest.json`).toString('utf8').includes('"managedInstallation": true'), true);
  for (const name of ['backend/models/ClientInstallation.js', 'backend/models/ClientInstallationOperation.js', 'backend/models/PlatformRelease.js', 'backend/models/InstallationPayment.js', 'backend/services/clientPlatformService.js', 'backend/routes/platformControlRoutes.js', 'src/pages/admin/ClientInstallations.jsx']) assert.equal(entries.has(prefix + name), false, name);
  for (const name of ['backend/models/StorePortfolioOperation.js', 'backend/models/SubscriptionPricing.js', 'backend/services/storePortfolioService.js', 'backend/services/storeDataExportService.js', 'backend/services/subscriptionPricingService.js']) assert.equal(entries.has(prefix + name), false, name);
  for (const name of [
    'backend/models/RuntimeLicense.js', 'backend/services/controlPlaneClient.js', 'backend/middleware/externalLicenseMiddleware.js',
    'backend/routes/clientSystemRoutes.js', 'src/pages/admin/SystemStatus.jsx',
    'backend/controllers/businessController.js', 'backend/routes/businessRoutes.js',
    'backend/services/businessOperationsService.js', 'src/pages/seller/BusinessCenter.jsx',
    'backend/models/Campaign.js', 'backend/controllers/campaignController.js',
    'backend/routes/campaignRoutes.js', 'src/pages/admin/CampaignBuilder.jsx',
    'backend/models/StoreContentVersion.js', 'backend/services/storeContentService.js',
    'backend/controllers/storeContentController.js', 'src/pages/admin/StoreContent.jsx',
    'src/pages/admin/StoreContent.css',
  ]) assert.equal(entries.has(prefix + name), true, name);
  assert.equal(entries.get(`${prefix}src/App.jsx`).toString('utf8').includes('ClientInstallations'), false);
  assert.match(entries.get(`${prefix}backend/services/controlPlaneClient.js`).toString('utf8'), /const MANAGED_CLIENT_BUILD = true/);
  assert.equal(entries.get(`${prefix}backend/app.js`).toString('utf8').includes('/api/platform'), false);
  assert.equal(entries.get(`${prefix}backend/app.js`).toString('utf8').includes('/api/system'), true);
  assert.match(entries.get(`${prefix}.gitignore`).toString('utf8'), /client-installation\.json/);
  for (const name of ['src/App.jsx', 'src/components/admin/AdminSidebar.jsx']) {
    assert.doesNotThrow(() => babelParser.parse(entries.get(prefix + name).toString('utf8'), { sourceType: 'module', plugins: ['jsx'] }), name);
  }
  assert.doesNotMatch(entries.get(`${prefix}render.yaml`).toString('utf8'), /LICENSE_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(entries.get(`${prefix}render.yaml`).toString('utf8'), /PLATFORM_CREDENTIAL_ENCRYPTION_KEY|DEPLOY_HOOK_ALLOWED_HOSTS/);
  assert.match(entries.get(`${prefix}render.yaml`).toString('utf8'), /CLIENT_INSTALLATION_ID/);
  for (const [name, contents] of entries) {
    if (name !== `${prefix}client-installation.json`) assert.equal(contents.toString('utf8').includes('one-time-private-key'), false, name);
  }
});
