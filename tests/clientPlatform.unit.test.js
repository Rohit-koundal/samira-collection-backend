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

test('boutique client ZIP includes the complete rental runtime without master control or existing records', async () => {
  const boutique = INDUSTRY_PRESETS.find(item => item.id === 'boutique');
  assert.equal(boutique.commerce.mode, 'SALE_AND_RENTAL');
  const entries = readZip((await projectGenerator.generateProject({ companyName: 'Occasion Boutique', projectSlug: 'occasion-boutique', includeAiWorker: false }, boutique)).buffer);
  const prefix = 'occasion-boutique/';
  const manifest = JSON.parse(entries.get(prefix + 'project-manifest.json'));
  assert.equal(manifest.commerce.mode, 'SALE_AND_RENTAL'); assert.equal(manifest.features.rentalManagementEnabled, true); assert.equal(manifest.features.masterConfiguration, false); assert.equal(manifest.dataIncluded, false);
  for (const name of ['backend/models/Rental.js', 'backend/controllers/rentalController.js', 'backend/routes/rentalRoutes.js', 'backend/services/rentalAlgorithms.js', 'backend/services/rentalService.js', 'backend/services/rentalWorker.js', 'src/pages/admin/Rentals.jsx', 'src/pages/customer/MyRentals.jsx', 'src/pages/customer/RentalCheckout.jsx', 'src/components/rentals/RentalSettings.jsx', 'src/components/rentals/RentalCatalogueBrowser.jsx', 'src/components/rentals/RentalLabels.jsx', 'src/utils/rentalBarcode.js', 'backend/services/rentalDetailsAlgorithms.js', 'src/utils/rentalDetails.js', 'src/components/rentals/RentalBookingDetails.jsx', 'src/components/rentals/RentalBookingDetailsEditor.jsx', 'src/components/rentals/RentalPieceMeasurements.jsx']) {
    assert.ok(entries.has(prefix + name), name);
    assert.doesNotThrow(() => babelParser.parse(entries.get(prefix + name).toString('utf8'), { sourceType: 'unambiguous', plugins: ['jsx'] }), name);
  }
  assert.match(entries.get(prefix + 'backend/server.js').toString('utf8'), /rentalWorker.*startWorker/);
  assert.ok(entries.has(prefix + 'backend/services/commerceUsageService.js'));
  assert.ok(entries.has(prefix + 'src/components/rentals/RentalPaymentRecovery.jsx'));
  for (const feature of ['rentalTrialAvailabilityAndOutcomes', 'rentalMeasurementRevisionsAndWorkshopJobs', 'rentalDateFirstShoppingAndWaitlist', 'rentalRefundDeadlinesAndPiecePerformance', 'rentalStructuredAddressesAndAuthorisedContacts', 'rentalPieceMeasurementsAndAlterationLimits']) assert.equal(manifest.features[feature], true, feature);
  for (const name of ['backend/services/rentalStudioAlgorithms.js', 'backend/services/rentalStudioService.js', 'backend/services/rentalStudioWorker.js', 'backend/services/rentalAvailabilityService.js', 'backend/services/rentalPieceReportingService.js', 'src/components/rentals/RentalStudioSettings.jsx', 'src/components/rentals/RentalStudioWorkspace.jsx', 'src/components/rentals/RentalMeasurements.jsx', 'src/components/rentals/RentalTrialDesk.jsx', 'src/components/rentals/RentalWorkshop.jsx', 'src/components/rentals/RentalWaitlist.jsx', 'src/components/rentals/RentalDateSearch.jsx']) {
    assert.ok(entries.has(prefix + name), name);
    assert.doesNotThrow(() => babelParser.parse(entries.get(prefix + name).toString('utf8'), { sourceType: 'unambiguous', plugins: ['jsx'] }), name);
  }
  for (const name of ['backend/services/storefrontDiscoveryService.js', 'backend/controllers/storefrontDiscoveryController.js', 'src/components/storefront/ShoppingShortcuts.jsx', 'src/components/storefront/ShoppingDiscovery.css', 'src/hooks/useShoppingDiscovery.js', 'src/components/product/CompleteLook.jsx', 'src/components/admin/CompleteLookPicker.jsx']) {
    assert.ok(entries.has(prefix + name), name);
    if (!name.endsWith('.css')) assert.doesNotThrow(() => babelParser.parse(entries.get(prefix + name).toString('utf8'), { sourceType: 'unambiguous', plugins: ['jsx'] }), name);
  }
  assert.match(entries.get(prefix + 'backend/config/industryPresets.js').toString('utf8'), /SALE_AND_RENTAL/);
  assert.equal(entries.has(prefix + 'src/pages/admin/MasterConfiguration.jsx'), false);
  assert.equal(entries.has(prefix + 'backend/services/projectGeneratorService.js'), false);
  assert.equal(entries.has(prefix + 'backend/.env'), false);
});

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
  for (const name of ['src/components/ui/ApplicationTheme.jsx', 'src/styles/applicationTheme.css', 'src/config/themeTokens.js', 'src/components/admin/OrderAlertSettings.jsx', 'backend/models/OrderAlertConfiguration.js', 'backend/models/OrderAlertDelivery.js', 'backend/services/orderAlertService.js', 'backend/services/orderAlertProviders.js', 'backend/controllers/orderAlertController.js', 'backend/routes/orderAlertRoutes.js']) {
    assert.equal(entries.has(prefix + name), true, name);
    if (/\.jsx?$/.test(name)) assert.doesNotThrow(() => babelParser.parse(entries.get(prefix + name).toString('utf8'), { sourceType: 'unambiguous', plugins: ['jsx'] }), name);
  }
  const manifest = JSON.parse(entries.get(prefix + 'project-manifest.json'));
  assert.equal(manifest.features.applicationWideTheme, true);
  assert.equal(manifest.features.clientSubscriptionExpiryNotice, true);
  assert.equal(manifest.features.retrySafeMediaUploads, true);
  assert.equal(manifest.features.retrySafeRecordCreation, true);
  assert.equal(manifest.features.resumableGeneratedMedia, true);
  assert.equal(manifest.features.refreshSafeUploadRecovery, true);
  for (const name of ['backend/models/UploadOperation.js', 'backend/services/uploadRetryService.js', 'backend/services/mediaUploadService.js', 'backend/services/recordCreationService.js', 'backend/services/generatedMediaService.js', 'src/services/uploadRetry.js', 'src/services/retryDigest.js']) {
    assert.equal(entries.has(prefix + name), true, name);
    assert.doesNotThrow(() => babelParser.parse(entries.get(prefix + name).toString('utf8'), { sourceType: 'unambiguous' }), name);
  }
  for (const name of ['src/components/admin/ClientSubscriptionNotice.jsx', 'src/components/admin/ClientSubscriptionNotice.css', 'src/hooks/useClientSubscription.js', 'src/utils/subscriptionNotice.js']) {
    assert.equal(entries.has(prefix + name), true, name);
    if (/\.jsx?$/.test(name)) assert.doesNotThrow(() => babelParser.parse(entries.get(prefix + name).toString('utf8'), { sourceType: 'module', plugins: ['jsx'] }), name);
  }
  assert.equal(manifest.features.ownerEmailAndWhatsAppOrderAlerts, true);
  assert.equal(manifest.features.reviewedWorkflowSmartFill, true);
  assert.equal(manifest.features.privacyAwareTrafficAnalytics, true);
  assert.equal(manifest.features.trafficSettingsAndDigests, true);
  for (const name of ['backend/models/TrafficAnalytics.js', 'backend/controllers/trafficController.js', 'backend/routes/trafficSettingsRoutes.js', 'backend/services/trafficWorker.js', 'backend/services/trafficReportingService.js', 'backend/services/trafficAlgorithms.js', 'backend/services/trafficConfigurationService.js', 'backend/services/trafficSearchPrivacyService.js', 'backend/services/trafficDigestService.js', 'backend/utils/trafficContext.js', 'src/utils/trafficTracker.js', 'src/components/analytics/TrafficTracking.jsx', 'src/components/admin/TrafficReport.jsx', 'src/components/admin/TrafficSettings.jsx']) {
    assert.equal(entries.has(prefix + name), true, name);
    assert.doesNotThrow(() => babelParser.parse(entries.get(prefix + name).toString('utf8'), { sourceType: 'unambiguous', plugins: ['jsx'] }), name);
  }
  assert.deepEqual(manifest.features.smartFillWorkflows, ['catalog', 'category', 'banner', 'campaign', 'website', 'coupon', 'shipment', 'purchase', 'support', 'returns', 'store']);
  for (const name of ['backend/routes/workflowSmartFillRoutes.js', 'backend/services/workflowSmartFillService.js', 'backend/services/workflowSmartFillAlgorithms.js', 'backend/services/geminiJson.service.js', 'backend/services/productSmartFillMedia.js', 'src/components/admin/WorkflowSmartFill.jsx', 'src/components/admin/BulkCatalogSmartFill.jsx', 'src/components/admin/WorkflowSmartFill.css', 'src/utils/workflowSmartFill.js']) {
    assert.equal(entries.has(prefix + name), true, name);
    if (/\.jsx?$/.test(name)) assert.doesNotThrow(() => babelParser.parse(entries.get(prefix + name).toString('utf8'), { sourceType: 'unambiguous', plugins: ['jsx'] }), name);
  }
  assert.match(entries.get(prefix + 'backend/app.js').toString('utf8'), /\/api\/admin\/smart-fill/);
  assert.match(entries.get(prefix + 'backend/routes/sellerRoutes.js').toString('utf8'), /workflowSmartFillRoutes/);
  assert.equal(manifest.features.masterConfiguration, false);
  for (const name of ['backend/models/DeletedProductDraft.js', 'backend/services/productDeletionService.js', 'src/components/admin/ProductDeleteDialog.jsx', 'src/components/admin/ProductDeleteDialog.css']) {
    assert.equal(entries.has(prefix + name), true, name);
    if (/\.jsx?$/.test(name)) assert.doesNotThrow(() => babelParser.parse(entries.get(prefix + name).toString('utf8'), { sourceType: 'unambiguous', plugins: ['jsx'] }), name);
  }
  assert.match(entries.get(prefix + 'backend/server.js').toString('utf8'), /orderAlertService.*startWorker/);
  assert.doesNotMatch(entries.get(`${prefix}render.yaml`).toString('utf8'), /LICENSE_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(entries.get(`${prefix}render.yaml`).toString('utf8'), /PLATFORM_CREDENTIAL_ENCRYPTION_KEY|DEPLOY_HOOK_ALLOWED_HOSTS/);
  assert.match(entries.get(`${prefix}render.yaml`).toString('utf8'), /CLIENT_INSTALLATION_ID/);
  for (const [name, contents] of entries) {
    if (name !== `${prefix}client-installation.json`) assert.equal(contents.toString('utf8').includes('one-time-private-key'), false, name);
  }
});
