const crypto = require('crypto');
const ClientInstallation = require('../models/ClientInstallation');
const PlatformRelease = require('../models/PlatformRelease');
const InstallationPayment = require('../models/InstallationPayment');
const ClientInstallationOperation = require('../models/ClientInstallationOperation');
const { ApiError } = require('../utils/apiError');
const { createRazorpayOrder, isRazorpayConfigured } = require('./razorpayService');
const { verifyRazorpaySignature } = require('../utils/paymentUtils');
const { priceFor, readPlanPricing } = require('./subscriptionPricingService');
const { signPayload, publicKeyBase64, signingReady } = require('./licenseSignatureService');
const { optionalEmail, optionalIndianMobile, optionalString, requireString } = require('../utils/validators');
const { runInTransaction } = require('../utils/transaction');
const {
  BILLING_CYCLES, LICENSE_STATUSES, LIMIT_KEYS, PLAN_IDS, STORE_PLANS,
  nextPeriodEnd, normalizeBillingCycle, normalizePlan, planSummary,
} = require('../config/storePlans');

const INSTALLATION_STATUSES = [...LICENSE_STATUSES, 'REVOKED'];
const PAID_CYCLES = ['MONTHLY', 'YEARLY', 'LIFETIME'];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FEATURE_IDS = [...new Set(Object.values(STORE_PLANS).flatMap((plan) => plan.features))];

function installationStoreShape(installation) {
  const rawLimits = installation.limitOverrides instanceof Map
    ? Object.fromEntries(installation.limitOverrides)
    : (typeof installation.limitOverrides?.toObject === 'function' ? installation.limitOverrides.toObject() : installation.limitOverrides || {});
  const limitOverrides = Object.fromEntries(Object.entries(rawLimits).filter(([, value]) => value !== null && value !== undefined && value !== ''));
  return {
    plan: installation.plan,
    license: {
      status: installation.status,
      billingCycle: installation.billingCycle,
      startsAt: installation.startsAt,
      trialEndsAt: installation.trialEndsAt,
      endsAt: installation.endsAt,
      limitOverrides,
      featureOverrides: installation.featureOverrides,
      disabledFeatures: installation.disabledFeatures,
      renewalMessage: installation.renewalMessage,
      lastPayment: installation.lastPayment,
    },
  };
}

function effectivePlatform(installation, now = new Date()) {
  if (installation.status === 'REVOKED') {
    const source = typeof installation.toObject === 'function' ? installation.toObject() : installation;
    const summary = planSummary(installationStoreShape({ ...source, status: 'SUSPENDED' }), now);
    return { ...summary, status: 'REVOKED' };
  }
  return planSummary(installationStoreShape(installation), now);
}

async function planCatalog() { return (await readPlanPricing()).plans; }

function hashSecret(secret, salt) {
  return crypto.scryptSync(secret, salt, 64).toString('hex');
}

function hashSecretAsync(secret, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(String(secret || ''), salt, 64, (error, value) => {
    if (error) reject(error); else resolve(value.toString('hex'));
  }));
}

function credentialEncryptionKey() {
  const configured = String(process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  if (!configured) throw new ApiError('SERVICE_UNAVAILABLE', 'Platform credential encryption is not configured');
  return crypto.createHash('sha256').update(configured).digest();
}

function encryptCredential(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptCredential(record) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', credentialEncryptionKey(), Buffer.from(record.deployHookIv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.deployHookTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.deployHookCiphertext, 'base64')), decipher.final()]).toString('utf8');
}

function decryptEncrypted(ciphertext, iv, tag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', credentialEncryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function validDeployHook(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new ApiError('VALIDATION_ERROR', 'Enter a valid deployment hook URL'); }
  const localDevelopment = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(localDevelopment && url.protocol === 'http:')) throw new ApiError('VALIDATION_ERROR', 'Deployment hooks must use HTTPS');
  const allowedHosts = new Set(['api.render.com', 'api.vercel.com', 'api.netlify.com', 'hooks.netlify.com', ...String(process.env.DEPLOY_HOOK_ALLOWED_HOSTS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)]);
  if (!localDevelopment && !allowedHosts.has(url.hostname.toLowerCase())) throw new ApiError('VALIDATION_ERROR', 'This deployment-hook host is not allowed');
  return url.toString();
}

async function matchesSecret(installation, candidate, { pending = false } = {}) {
  const salt = pending ? installation.pendingSecretSalt : installation.secretSalt;
  const hash = pending ? installation.pendingSecretHash : installation.secretHash;
  if (!salt || !hash) return false;
  const actual = Buffer.from(String(hash || ''), 'hex');
  const expected = Buffer.from(await hashSecretAsync(String(candidate || ''), salt), 'hex');
  return actual.length === expected.length && actual.length > 0 && crypto.timingSafeEqual(actual, expected);
}

function versionParts(version) {
  return String(version || '0.0.0').split('-', 1)[0].split('.').map((part) => Number(part) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left); const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

function safeVersion(value, fallback = '1.0.0') {
  const version = String(value || fallback).trim();
  if (!VERSION_PATTERN.test(version)) throw new ApiError('VALIDATION_ERROR', 'Use a semantic version such as 1.2.0');
  return version;
}

function requireRevision(installation, value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) throw new ApiError('VALIDATION_ERROR', 'A valid client revision is required');
  if (revision !== Number(installation.revision || 0)) throw new ApiError('DUPLICATE_REQUEST', 'This client changed in another session. Reload before saving.', { details: { currentRevision: Number(installation.revision || 0), updatedAt: installation.updatedAt } });
  return revision;
}

async function saveRevision(installation, revision, session) {
  installation.revision = revision + 1;
  installation.$where = revision === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision };
  try { return await installation.save({ ...(session ? { session } : {}) }); }
  catch (error) {
    if (error?.name === 'DocumentNotFoundError' || error?.code === 112) throw new ApiError('DUPLICATE_REQUEST', 'This client changed in another session. Reload before saving.');
    throw error;
  } finally { installation.$where = undefined; }
}

function changeReason(value, label) {
  const reason = String(value || '').trim();
  if (reason.length < 3) throw new ApiError('VALIDATION_ERROR', `Add a reason for this ${label}`);
  if (reason.length > 500) throw new ApiError('VALIDATION_ERROR', 'Reason must be 500 characters or fewer');
  return reason;
}

function operationSnapshot(installation) {
  const platform = effectivePlatform(installation);
  return {
    revision: Number(installation.revision || 0), status: platform.status, plan: platform.id,
    billingCycle: platform.billingCycle, startsAt: platform.startsAt, endsAt: platform.endsAt,
    features: platform.features, limits: platform.limits, targetVersion: installation.targetVersion,
    updateChannel: installation.updateChannel,
  };
}

async function recordOperation(installation, { actor, type, reason, idempotencyKey, before, after, metadata, source = 'MASTER', session }) {
  return ClientInstallationOperation.create([{
    installation: installation._id, installationId: installation.installationId, actor: actor?._id || actor,
    type, reason, idempotencyKey: idempotencyKey || undefined, before, after, metadata, source,
  }], { ordered: true, ...(session ? { session } : {}) });
}

function normalizedPublicUrl(value, label = 'deployment URL') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw new ApiError('VALIDATION_ERROR', `Enter a valid ${label}`); }
  const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new ApiError('VALIDATION_ERROR', `${label} must use HTTPS`);
  if (url.username || url.password) throw new ApiError('VALIDATION_ERROR', `${label} cannot contain credentials`);
  return url.toString().slice(0, 500);
}

function normalizedRepository(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^(?:https:\/\/[^\s]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.test(raw)) throw new ApiError('VALIDATION_ERROR', 'Enter a repository URL or owner/repository');
  return raw.slice(0, 300);
}

async function provisionInstallation(input = {}, actor) {
  if (!signingReady()) throw new ApiError('SERVICE_UNAVAILABLE', 'Configure platform licence signing before generating managed projects');
  const rawSecret = crypto.randomBytes(32).toString('base64url');
  const salt = crypto.randomBytes(18).toString('hex');
  const installationId = `client_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = new Date();
  const trialDays = Math.max(1, Number.parseInt(process.env.SUBSCRIPTION_TRIAL_DAYS || '30', 10) || 30);
  const trialEndsAt = new Date(now.getTime() + trialDays * 86400000);
  const appVersion = safeVersion(process.env.APP_VERSION || '1.0.0');
  const installation = await ClientInstallation.create({
    installationId,
    companyName: String(input.companyName || '').trim(),
    projectName: String(input.projectName || input.companyName || '').trim(),
    projectSlug: String(input.projectSlug || '').trim(),
    industry: String(input.industry || '').trim().toLowerCase(),
    status: 'TRIAL', plan: 'PROFESSIONAL', billingCycle: 'TRIAL',
    startsAt: now, trialEndsAt, endsAt: trialEndsAt,
    secretSalt: salt, secretHash: hashSecret(rawSecret, salt),
    appVersion, targetVersion: appVersion, updateChannel: 'stable',
    createdBy: actor?._id,
  });
  return {
    installation,
    credentials: {
      installationId,
      licenseKey: rawSecret,
      controlPlaneUrl: String(process.env.CONTROL_PLANE_PUBLIC_URL || process.env.PUBLIC_API_URL || 'http://localhost:5000').replace(/\/+$/, ''),
      signingPublicKey: publicKeyBase64(),
      appVersion,
    },
  };
}

async function authenticateInstallation(installationId, secret) {
  if (!installationId || !secret) throw new ApiError('UNAUTHORIZED', 'Installation credentials are required');
  const installation = await ClientInstallation.findOne({ installationId: String(installationId) })
    .select('+secretSalt +secretHash +pendingSecretSalt +pendingSecretHash +pendingSecretCiphertext +pendingSecretIv +pendingSecretTag');
  if (!installation) throw new ApiError('UNAUTHORIZED', 'Installation credentials are invalid');
  const activeMatch = await matchesSecret(installation, secret);
  const pendingAllowed = installation.keyRotation?.status === 'PENDING'
    && installation.keyRotation?.expiresAt && new Date(installation.keyRotation.expiresAt) > new Date();
  const pendingMatch = !activeMatch && pendingAllowed ? await matchesSecret(installation, secret, { pending: true }) : false;
  if (!activeMatch && !pendingMatch) throw new ApiError('UNAUTHORIZED', 'Installation credentials are invalid');
  if (pendingMatch) {
    installation.secretSalt = installation.pendingSecretSalt;
    installation.secretHash = installation.pendingSecretHash;
    installation.pendingSecretSalt = undefined;
    installation.pendingSecretHash = undefined;
    installation.pendingSecretCiphertext = undefined;
    installation.pendingSecretIv = undefined;
    installation.pendingSecretTag = undefined;
    installation.keyRotation.status = 'CONFIRMED';
    installation.keyRotation.confirmedAt = new Date();
    installation.keyRotation.pendingLastUsedAt = new Date();
    await installation.save();
    await recordOperation(installation, {
      type: 'KEY_ROTATION_CONFIRM', source: 'CLIENT', reason: 'The client confirmed the pending credential by checking in.',
      after: { confirmedAt: installation.keyRotation.confirmedAt },
    }).catch(() => null);
  } else if (installation.keyRotation) installation.keyRotation.activeLastUsedAt = new Date();
  return installation;
}

async function latestReleaseFor(installation) {
  const releases = await PlatformRelease.find({
    status: 'PUBLISHED', channel: installation.updateChannel || 'stable', rolloutStatus: { $ne: 'PAUSED' },
    $or: [{ eligibleIndustries: { $size: 0 } }, { eligibleIndustries: installation.industry }],
  }).sort('-publishedAt').limit(100).lean();
  const bucket = Number.parseInt(crypto.createHash('sha256').update(installation.installationId).digest('hex').slice(0, 8), 16) % 100;
  return releases.filter((release) => bucket < Number(release.rolloutPercent ?? 100)
    && Number(release.artifact?.minimumProtocol || 1) <= Number(installation.lastProtocolVersion || 1))
    .sort((left, right) => compareVersions(right.version, left.version))[0] || null;
}

function installationView(installation, release = null) {
  const platform = effectivePlatform(installation);
  const latestVersion = release?.version || installation.targetVersion || installation.appVersion;
  const lastSeen = installation.lastSeenAt ? new Date(installation.lastSeenAt) : null;
  const age = lastSeen ? Date.now() - lastSeen.getTime() : Infinity;
  const databaseStatus = installation.runtime?.databaseStatus || 'UNKNOWN';
  const connectionStatus = databaseStatus === 'DISCONNECTED' ? 'ERROR' : age <= 30 * 60000 ? 'ONLINE' : age <= 24 * 3600000 ? 'STALE' : 'OFFLINE';
  const deployment = installation.lastDeployment || null;
  const deploymentPhase = !deployment ? null : deployment.status === 'FAILED' ? 'FAILED'
    : installation.lastValidatedVersion === deployment.version && lastSeen && deployment.requestedAt && lastSeen >= new Date(deployment.requestedAt) ? 'LIVE' : 'BUILDING';
  const attention = [];
  const accessIsLive = ['ACTIVE', 'TRIAL'].includes(platform.status);
  if (accessIsLive && (connectionStatus === 'ERROR' || connectionStatus === 'OFFLINE')) attention.push({ code: 'OFFLINE', severity: 'HIGH', label: 'Client backend is offline' });
  if (installation.billingReview?.required) attention.push({ code: 'BILLING_REVIEW', severity: 'HIGH', label: 'Billing review required' });
  if (deploymentPhase === 'FAILED') attention.push({ code: 'DEPLOYMENT_FAILED', severity: 'HIGH', label: 'Latest deployment failed' });
  if (accessIsLive && platform.endsAt && new Date(platform.endsAt).getTime() - Date.now() <= 7 * 86400000) attention.push({ code: 'EXPIRING', severity: 'MEDIUM', label: 'Access expires within 7 days' });
  for (const key of LIMIT_KEYS) if (Number(platform.limits[key]) > 0 && Number(installation.usage?.[key] || 0) / Number(platform.limits[key]) >= 0.8) attention.push({ code: `LIMIT_${key.toUpperCase()}`, severity: Number(installation.usage?.[key] || 0) >= Number(platform.limits[key]) ? 'HIGH' : 'MEDIUM', label: `${key} usage is near its limit` });
  return {
    id: String(installation._id), installationId: installation.installationId, revision: Number(installation.revision || 0),
    companyName: installation.companyName, projectName: installation.projectName, projectSlug: installation.projectSlug,
    industry: installation.industry, status: platform.status, plan: platform.id, billingCycle: platform.billingCycle,
    startsAt: platform.startsAt, endsAt: platform.endsAt, daysRemaining: platform.daysRemaining,
    features: platform.features, limits: platform.limits, limitOverrides: platform.limitOverrides,
    featureOverrides: [...(installation.featureOverrides || [])], disabledFeatures: [...(installation.disabledFeatures || [])],
    appVersion: installation.appVersion, targetVersion: installation.targetVersion,
    latestVersion, updateChannel: installation.updateChannel,
    updateAvailable: compareVersions(installation.lastValidatedVersion || installation.appVersion, installation.targetVersion || latestVersion) < 0,
    lastValidatedVersion: installation.lastValidatedVersion || null, lastProtocolVersion: Number(installation.lastProtocolVersion || 1), lastSeenAt: installation.lastSeenAt || null,
    deploymentUrl: installation.deploymentUrl || '', notes: installation.notes || '', createdAt: installation.createdAt,
    contact: installation.contact?.toObject?.() || installation.contact || {}, tags: [...(installation.tags || [])],
    statusReason: installation.statusReason || '', statusChangedAt: installation.statusChangedAt || null,
    renewalMessage: installation.renewalMessage || '', lastPayment: platform.lastPayment || null,
    billingReview: installation.billingReview?.toObject?.() || installation.billingReview || null,
    usage: installation.usage?.toObject?.() || installation.usage || {},
    health: {
      status: connectionStatus, databaseStatus, serviceStatus: installation.runtime?.serviceStatus || 'UNKNOWN',
      lastError: installation.runtime?.lastError || '', reportedAt: installation.runtime?.reportedAt || null,
      databaseLatencyMs: installation.runtime?.databaseLatencyMs ?? null, uptimeSeconds: installation.runtime?.uptimeSeconds ?? null,
      memoryRssMb: installation.runtime?.memoryRssMb ?? null, nodeVersion: installation.runtime?.nodeVersion || '',
      paymentReady: Boolean(installation.runtime?.paymentReady), mediaStorageReady: Boolean(installation.runtime?.mediaStorageReady),
      shippingProvider: installation.runtime?.shippingProvider || 'disabled',
    },
    keyRotation: installation.keyRotation ? {
      status: installation.keyRotation.status === 'PENDING' && installation.keyRotation.expiresAt && new Date(installation.keyRotation.expiresAt) <= new Date() ? 'EXPIRED' : installation.keyRotation.status,
      requestedAt: installation.keyRotation.requestedAt,
      expiresAt: installation.keyRotation.expiresAt, confirmedAt: installation.keyRotation.confirmedAt,
    } : null,
    attention,
    deployment: {
      hasHook: Boolean(installation.hasDeployHook), phase: deploymentPhase, last: deployment,
      provider: installation.deploymentProvider || 'CUSTOM', repository: installation.deploymentRepository || '',
      branch: installation.deploymentBranch || 'main', environment: installation.deploymentEnvironment || 'production',
    },
  };
}

async function validateInstallation({ installationId, secret, appVersion, protocolVersion = 1, ip, telemetry }) {
  const installation = await authenticateInstallation(installationId, secret);
  const currentVersion = safeVersion(appVersion || installation.appVersion);
  const platform = effectivePlatform(installation);
  const now = new Date();
  if (platform.status === 'EXPIRED' && installation.status !== 'EXPIRED') installation.status = 'EXPIRED';
  installation.lastSeenAt = now;
  installation.lastValidatedVersion = currentVersion;
  installation.appVersion = currentVersion;
  installation.lastProtocolVersion = Math.max(1, Math.min(1000, Number.parseInt(protocolVersion || '1', 10) || 1));
  if (ip) installation.lastIpHash = crypto.createHash('sha256').update(String(ip)).digest('hex');
  if (telemetry && typeof telemetry === 'object') {
    const products = Number(telemetry.products); const ordersPerMonth = Number(telemetry.ordersPerMonth);
    installation.usage = {
      products: Number.isFinite(products) && products >= 0 ? Math.floor(products) : Number(installation.usage?.products || 0),
      ordersPerMonth: Number.isFinite(ordersPerMonth) && ordersPerMonth >= 0 ? Math.floor(ordersPerMonth) : Number(installation.usage?.ordersPerMonth || 0),
      reportedAt: now,
    };
    installation.runtime = {
      databaseStatus: ['CONNECTED', 'DISCONNECTED'].includes(telemetry.databaseStatus) ? telemetry.databaseStatus : 'UNKNOWN',
      serviceStatus: telemetry.serviceStatus === 'DEGRADED' ? 'DEGRADED' : 'HEALTHY',
      lastError: String(telemetry.lastError || '').trim().slice(0, 300), reportedAt: now,
      databaseLatencyMs: Math.max(0, Math.min(60000, Number(telemetry.databaseLatencyMs) || 0)),
      uptimeSeconds: Math.max(0, Number(telemetry.uptimeSeconds) || 0), memoryRssMb: Math.max(0, Number(telemetry.memoryRssMb) || 0),
      nodeVersion: String(telemetry.nodeVersion || '').slice(0, 40), paymentReady: Boolean(telemetry.paymentReady),
      mediaStorageReady: Boolean(telemetry.mediaStorageReady), shippingProvider: String(telemetry.shippingProvider || '').slice(0, 60),
    };
  }
  await installation.save();
  const release = await latestReleaseFor(installation);
  const view = installationView(installation, release);
  const validMinutes = Math.max(5, Number.parseInt(process.env.LICENSE_VALID_MINUTES || '15', 10) || 15);
  const graceHours = Math.max(1, Number.parseInt(process.env.LICENSE_GRACE_HOURS || '72', 10) || 72);
  const pricing = await readPlanPricing();
  return signPayload({
    schema: 1,
    installationId: installation.installationId,
    companyName: installation.companyName,
    industry: installation.industry,
    status: view.status,
    plan: view.plan,
    billingCycle: view.billingCycle,
    endsAt: view.endsAt ? new Date(view.endsAt).toISOString() : null,
    renewalMessage: view.renewalMessage || '',
    features: view.features,
    limits: view.limits,
    appVersion: currentVersion,
    targetVersion: view.targetVersion,
    latestVersion: view.latestVersion,
    updateAvailable: view.updateAvailable,
    updateChannel: view.updateChannel,
    release: release ? { version: release.version, notes: release.notes || '', mandatory: Boolean(release.mandatory), publishedAt: release.publishedAt } : null,
    checkoutConfigured: isRazorpayConfigured(),
    plans: pricing.plans,
    pricing: { revision: pricing.revision, currency: pricing.currency, taxMode: pricing.taxMode, gstPercent: pricing.gstPercent },
    issuedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + validMinutes * 60000).toISOString(),
    graceUntil: new Date(now.getTime() + graceHours * 3600000).toISOString(),
  });
}

async function listInstallations() {
  const installations = await ClientInstallation.find().sort('-createdAt').limit(500);
  const releases = await PlatformRelease.find({ status: 'PUBLISHED' }).sort('-publishedAt').limit(100).lean();
  return installations.map((installation) => {
    const eligible = releases.filter((release) => release.channel === installation.updateChannel && (!release.eligibleIndustries?.length || release.eligibleIndustries.includes(installation.industry)))
      .sort((left, right) => compareVersions(right.version, left.version))[0] || null;
    return installationView(installation, eligible);
  });
}

function safeRegex(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function clientControlWorkspace(input = {}) {
  const now = new Date();
  const page = Math.max(1, Math.min(10000, Number.parseInt(input.page || '1', 10) || 1));
  const limit = Math.max(6, Math.min(50, Number.parseInt(input.limit || '12', 10) || 12));
  const filter = {};
  const clauses = [];
  const requestedStatus = String(input.status || '').toUpperCase();
  if (INSTALLATION_STATUSES.includes(requestedStatus)) {
    if (requestedStatus === 'EXPIRED') clauses.push({ $or: [{ status: 'EXPIRED' }, { status: { $in: ['ACTIVE', 'TRIAL'] }, endsAt: { $lte: now } }] });
    else if (['ACTIVE', 'TRIAL'].includes(requestedStatus)) clauses.push({ status: requestedStatus, $or: [{ billingCycle: 'LIFETIME' }, { endsAt: { $gt: now } }] });
    else clauses.push({ status: requestedStatus });
  }
  if (PLAN_IDS.includes(String(input.plan || '').toUpperCase())) filter.plan = String(input.plan).toUpperCase();
  if (input.industry) filter.industry = String(input.industry).trim().toLowerCase();
  if (input.q) {
    const pattern = new RegExp(safeRegex(String(input.q).trim().slice(0, 100)), 'i');
    clauses.push({ $or: ['companyName', 'projectName', 'projectSlug', 'installationId', 'deploymentUrl', 'contact.ownerName', 'contact.email', 'contact.phone', 'tags'].map((field) => ({ [field]: pattern })) });
  }
  const attention = String(input.attention || '');
  if (attention === 'expiring') filter.endsAt = { $gt: now, $lte: new Date(now.getTime() + 30 * 86400000) };
  if (attention === 'offline') clauses.push({ status: { $in: ['ACTIVE', 'TRIAL'] }, $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: new Date(now.getTime() - 24 * 3600000) } }] });
  if (attention === 'updates') clauses.push({ $expr: { $ne: ['$targetVersion', { $ifNull: ['$lastValidatedVersion', '$appVersion'] }] } });
  if (attention === 'risks') clauses.push({ $or: [{ 'billingReview.required': true }, { 'lastDeployment.status': 'FAILED' }, { status: { $in: ['ACTIVE', 'TRIAL'] }, $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: new Date(now.getTime() - 24 * 3600000) } }] }] });
  if (clauses.length) filter.$and = clauses;
  const expiry = new Date(now.getTime() + 30 * 86400000);
  const offline = new Date(now.getTime() - 24 * 3600000);
  const sortMap = { newest: '-createdAt', updated: '-updatedAt', company: 'companyName', expiry: 'endsAt', health: 'lastSeenAt' };
  const sort = sortMap[String(input.sort || '')] || '-createdAt';
  const [installations, total, releases, allClients, revenue, pricing] = await Promise.all([
    ClientInstallation.find(filter).sort(sort).skip((page - 1) * limit).limit(limit),
    ClientInstallation.countDocuments(filter),
    PlatformRelease.find().sort('-publishedAt').limit(100).lean(),
    ClientInstallation.find().select('status plan billingCycle startsAt trialEndsAt endsAt lastSeenAt usage runtime billingReview lastDeployment limitOverrides featureOverrides disabledFeatures').lean(),
    InstallationPayment.aggregate([{ $match: { status: { $in: ['PAID', 'REFUNDED'] }, paidAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) } } }, { $group: { _id: null, amount: { $sum: { $subtract: ['$amount', { $ifNull: ['$refundedAmount', 0] }] } } } }]),
    readPlanPricing(),
  ]);
  const published = releases.filter((item) => item.status === 'PUBLISHED');
  return {
    installations: installations.map((installation) => {
      const eligible = published.filter((release) => release.channel === installation.updateChannel && (!release.eligibleIndustries?.length || release.eligibleIndustries.includes(installation.industry))).sort((a, b) => compareVersions(b.version, a.version))[0] || null;
      return installationView(installation, eligible);
    }),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    summary: {
      total: allClients.length,
      active: allClients.filter((item) => effectivePlatform(item, now).status === 'ACTIVE').length,
      trials: allClients.filter((item) => effectivePlatform(item, now).status === 'TRIAL').length,
      expiring: allClients.filter((item) => { const view = effectivePlatform(item, now); return ['ACTIVE', 'TRIAL'].includes(view.status) && view.endsAt && new Date(view.endsAt) <= expiry; }).length,
      offline: allClients.filter((item) => ['ACTIVE', 'TRIAL'].includes(effectivePlatform(item, now).status) && (!item.lastSeenAt || new Date(item.lastSeenAt) < offline)).length,
      needsAttention: allClients.filter((item) => item.billingReview?.required || item.lastDeployment?.status === 'FAILED' || (['ACTIVE', 'TRIAL'].includes(effectivePlatform(item, now).status) && (!item.lastSeenAt || new Date(item.lastSeenAt) < offline))).length,
      monthlyRevenue: revenue[0]?.amount || 0,
    },
    plans: pricing.plans, pricing: { revision: pricing.revision, currency: pricing.currency, taxMode: pricing.taxMode, gstPercent: pricing.gstPercent }, releases: releases.map((item) => ({ ...item, id: String(item._id), _id: undefined })),
  };
}

async function installationOperations(id, input = {}) {
  const installation = await ClientInstallation.findById(id);
  if (!installation) throw new ApiError('NOT_FOUND', 'Client installation not found');
  const activityPage = Math.max(1, Number.parseInt(input.activityPage || '1', 10) || 1);
  const activityLimit = Math.max(10, Math.min(100, Number.parseInt(input.activityLimit || '50', 10) || 50));
  const [payments, paymentTotal, operations, operationTotal] = await Promise.all([
    InstallationPayment.find({ installation: installation._id }).sort('-createdAt').limit(100).lean(),
    InstallationPayment.countDocuments({ installation: installation._id }),
    ClientInstallationOperation.find({ installation: installation._id }).populate('actor', 'name role').sort('-createdAt').skip((activityPage - 1) * activityLimit).limit(activityLimit).lean(),
    ClientInstallationOperation.countDocuments({ installation: installation._id }),
  ]);
  return {
    installation: installationView(installation, await latestReleaseFor(installation)),
    payments: payments.map((item) => ({ ...item, id: String(item._id), _id: undefined, installation: undefined })), paymentTotal,
    operations: operations.map((item) => ({
      id: String(item._id), type: item.type, reason: item.reason || '', source: item.source,
      before: item.before || null, after: item.after || null, metadata: item.metadata || null,
      actor: item.actor?.name || (item.source === 'CLIENT' ? 'Client backend' : item.source === 'PAYMENT' ? 'Payment gateway' : 'System'),
      createdAt: item.createdAt,
    })),
    operationPagination: { page: activityPage, limit: activityLimit, total: operationTotal, pages: Math.max(1, Math.ceil(operationTotal / activityLimit)) },
  };
}

async function mutateWithRevision(id, input, actor, definition) {
  return runInTransaction(async (session) => {
    const installation = await ClientInstallation.findById(id).session(session || null);
    if (!installation) throw new ApiError('NOT_FOUND', 'Client installation not found');
    const revision = requireRevision(installation, input.baseRevision);
    const before = definition.before ? definition.before(installation) : operationSnapshot(installation);
    const reason = definition.reasonRequired ? changeReason(input.reason, definition.reasonLabel || 'change') : optionalString(input.reason, 'reason', { max: 500 });
    await definition.apply(installation, reason);
    await saveRevision(installation, revision, session);
    const after = definition.after ? definition.after(installation) : operationSnapshot(installation);
    await recordOperation(installation, { actor, type: definition.type, reason, before, after, metadata: definition.metadata?.(installation), session });
    return installation;
  });
}

async function updateInstallationProfile(id, input = {}, actor) {
  return mutateWithRevision(id, input, actor, {
    type: 'PROFILE_UPDATE',
    before: (item) => ({ contact: item.contact?.toObject?.() || item.contact || {}, tags: item.tags || [], notes: item.notes || '' }),
    after: (item) => ({ revision: item.revision, contact: item.contact?.toObject?.() || item.contact || {}, tags: item.tags || [], notes: item.notes || '' }),
    apply: async (installation) => {
      if (input.contact !== undefined) {
        if (!input.contact || typeof input.contact !== 'object' || Array.isArray(input.contact)) throw new ApiError('VALIDATION_ERROR', 'Contact details must be an object');
        installation.contact = {
          ownerName: optionalString(input.contact.ownerName, 'owner name', { max: 100 }),
          phone: optionalIndianMobile(input.contact.phone, 'phone'),
          email: optionalEmail(input.contact.email, 'email'),
          billingEmail: optionalEmail(input.contact.billingEmail, 'billing email'),
          accountManager: optionalString(input.contact.accountManager, 'account manager', { max: 100 }),
        };
      }
      if (input.tags !== undefined) installation.tags = [...new Set((Array.isArray(input.tags) ? input.tags : String(input.tags).split(',')).map((value) => String(value).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);
      if (input.notes !== undefined) installation.notes = optionalString(input.notes, 'private notes', { max: 1000 });
    },
  });
}

function validateSubscriptionState(installation) {
  const now = new Date();
  if (installation.billingCycle === 'LIFETIME') installation.endsAt = undefined;
  if (installation.status === 'TRIAL') {
    installation.billingCycle = 'TRIAL';
    if (!installation.endsAt || installation.endsAt <= now) throw new ApiError('VALIDATION_ERROR', 'Trial access needs a future expiry date');
    installation.trialEndsAt = installation.endsAt;
  }
  if (installation.status === 'ACTIVE' && installation.billingCycle !== 'LIFETIME' && (!installation.endsAt || installation.endsAt <= now)) throw new ApiError('VALIDATION_ERROR', 'Active time-limited access needs a future expiry date');
  if (installation.status === 'EXPIRED' && installation.endsAt && installation.endsAt > now) throw new ApiError('VALIDATION_ERROR', 'Use a lifecycle action or access grant instead of expiring future access');
}

async function updateInstallationSubscription(id, input = {}, actor) {
  return mutateWithRevision(id, input, actor, {
    type: 'SUBSCRIPTION_UPDATE', reasonRequired: true, reasonLabel: 'subscription change',
    apply: async (installation) => {
      if (input.plan !== undefined) {
        const plan = normalizePlan(input.plan, '');
        if (!PLAN_IDS.includes(plan)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid subscription plan');
        installation.plan = plan;
      }
      if (input.billingCycle !== undefined) {
        const cycle = normalizeBillingCycle(input.billingCycle, '');
        if (!BILLING_CYCLES.includes(cycle)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid billing cycle');
        installation.billingCycle = cycle;
      }
      if (input.endsAt !== undefined) {
        const value = input.endsAt ? new Date(input.endsAt) : null;
        if (value && !Number.isFinite(value.getTime())) throw new ApiError('VALIDATION_ERROR', 'Choose a valid access expiry');
        installation.endsAt = value || undefined;
      }
      if (input.renewalMessage !== undefined) installation.renewalMessage = optionalString(input.renewalMessage, 'renewal message', { max: 500 });
      validateSubscriptionState(installation);
    },
  });
}

async function grantInstallationAccess(id, input = {}, actor) {
  const key = String(input.idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9:_-]{12,120}$/.test(key)) throw new ApiError('VALIDATION_ERROR', 'A valid access-operation key is required');
  const installation = await ClientInstallation.findById(id);
  if (!installation) throw new ApiError('NOT_FOUND', 'Client installation not found');
  const duplicate = await ClientInstallationOperation.findOne({ installation: installation._id, idempotencyKey: key });
  if (duplicate) return { installation, duplicate: true };
  const reason = changeReason(input.reason, 'access grant');
  const cycle = normalizeBillingCycle(input.billingCycle || input.grant, '');
  if (!['TRIAL', 'MONTHLY', 'YEARLY', 'LIFETIME'].includes(cycle)) throw new ApiError('VALIDATION_ERROR', 'Choose trial, monthly, yearly or lifetime access');
  const plan = normalizePlan(input.plan || installation.plan, '');
  if (!PLAN_IDS.includes(plan)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid subscription plan');
  const grantSource = ['COMPLIMENTARY', 'MANUAL_PAYMENT', 'PROMOTIONAL', 'SUPPORT_EXTENSION'].includes(String(input.source || '').toUpperCase()) ? String(input.source).toUpperCase() : 'COMPLIMENTARY';
  try {
    return await runInTransaction(async (session) => {
      const current = await ClientInstallation.findById(id).session(session || null);
      const revision = requireRevision(current, input.baseRevision);
      const before = operationSnapshot(current); const now = new Date();
      const sameActivePlan = current.status === 'ACTIVE' && current.plan === plan && current.endsAt && current.endsAt > now;
      const base = sameActivePlan ? current.endsAt : now;
      current.plan = plan; current.status = cycle === 'TRIAL' ? 'TRIAL' : 'ACTIVE'; current.billingCycle = cycle; current.startsAt = now;
      if (cycle === 'TRIAL') {
        const days = Math.max(1, Math.min(365, Number.parseInt(input.grantDays || '30', 10) || 30));
        current.endsAt = new Date(now.getTime() + days * 86400000); current.trialEndsAt = current.endsAt;
      } else {
        current.endsAt = nextPeriodEnd(cycle, base) || undefined; current.trialEndsAt = undefined;
      }
      current.statusReason = reason; current.statusChangedAt = now;
      await saveRevision(current, revision, session);
      await recordOperation(current, { actor, type: 'ACCESS_GRANT', reason, idempotencyKey: key, before, after: operationSnapshot(current), metadata: { source: grantSource, reference: optionalString(input.reference, 'payment reference', { max: 120 }) }, session });
      return { installation: current, duplicate: false };
    });
  } catch (error) {
    if (error?.code === 11000) return { installation: await ClientInstallation.findById(id), duplicate: true };
    throw error;
  }
}

async function updateInstallationLifecycle(id, input = {}, actor) {
  const action = String(input.action || '').toUpperCase();
  if (!['SUSPEND', 'REVOKE', 'RESTORE', 'EXPIRE'].includes(action)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid client lifecycle action');
  return mutateWithRevision(id, input, actor, {
    type: 'LIFECYCLE_CHANGE', reasonRequired: true, reasonLabel: 'client lifecycle change', metadata: () => ({ action }),
    apply: async (installation, reason) => {
      const now = new Date();
      if (action === 'RESTORE') {
        const accessValid = installation.billingCycle === 'LIFETIME' || (installation.endsAt && installation.endsAt > now);
        if (!accessValid) throw new ApiError('VALIDATION_ERROR', 'This client has no valid access period. Grant trial or paid access instead.');
        installation.status = installation.billingCycle === 'TRIAL' ? 'TRIAL' : 'ACTIVE';
        if (installation.billingReview) { installation.billingReview.required = false; installation.billingReview.resolvedAt = now; }
      } else installation.status = action === 'SUSPEND' ? 'SUSPENDED' : action === 'REVOKE' ? 'REVOKED' : 'EXPIRED';
      installation.statusReason = reason; installation.statusChangedAt = now;
    },
  });
}

function normalizedFeatures(value, label) {
  if (!Array.isArray(value)) throw new ApiError('VALIDATION_ERROR', `${label} must be a list`);
  const features = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (features.some((feature) => !FEATURE_IDS.includes(feature))) throw new ApiError('VALIDATION_ERROR', 'Choose only supported store features');
  return features;
}

async function updateInstallationEntitlements(id, input = {}, actor) {
  return mutateWithRevision(id, input, actor, {
    type: 'ENTITLEMENTS_UPDATE', reasonRequired: true, reasonLabel: 'feature or limit change',
    apply: async (installation) => {
      if (input.featureOverrides !== undefined) installation.featureOverrides = normalizedFeatures(input.featureOverrides, 'Feature overrides');
      if (input.disabledFeatures !== undefined) installation.disabledFeatures = normalizedFeatures(input.disabledFeatures, 'Disabled features');
      installation.featureOverrides = (installation.featureOverrides || []).filter((feature) => !(installation.disabledFeatures || []).includes(feature));
      if (input.limitOverrides !== undefined) {
        if (!input.limitOverrides || typeof input.limitOverrides !== 'object' || Array.isArray(input.limitOverrides)) throw new ApiError('VALIDATION_ERROR', 'Limit overrides must be an object');
        for (const key of LIMIT_KEYS) {
          const raw = input.limitOverrides[key];
          if (raw === '' || raw == null) installation.limitOverrides[key] = null;
          else {
            const value = Number(raw);
            if (!Number.isInteger(value) || value < 0 || value > 10000000) throw new ApiError('VALIDATION_ERROR', `${key} limit must be a whole number from 0 to 10,000,000`);
            installation.limitOverrides[key] = value;
          }
        }
      }
    },
  });
}

async function updateInstallationDeployment(id, input = {}, actor) {
  return mutateWithRevision(id, input, actor, {
    type: 'DEPLOYMENT_SETTINGS_UPDATE', reasonRequired: true, reasonLabel: 'deployment change',
    apply: async (installation) => {
      if (input.updateChannel !== undefined) {
        if (!['stable', 'beta'].includes(input.updateChannel)) throw new ApiError('VALIDATION_ERROR', 'Choose stable or beta updates');
        installation.updateChannel = input.updateChannel;
      }
      if (input.targetVersion !== undefined) {
        const targetVersion = safeVersion(input.targetVersion, installation.appVersion);
        if (targetVersion !== installation.appVersion) {
          const release = await PlatformRelease.exists({ version: targetVersion, status: 'PUBLISHED', channel: installation.updateChannel, rolloutStatus: { $ne: 'PAUSED' }, $or: [{ eligibleIndustries: { $size: 0 } }, { eligibleIndustries: installation.industry }] });
          if (!release) throw new ApiError('VALIDATION_ERROR', 'Choose an active published release available for this client');
        }
        installation.targetVersion = targetVersion;
      }
      if (input.deploymentUrl !== undefined) installation.deploymentUrl = normalizedPublicUrl(input.deploymentUrl);
      if (input.provider !== undefined) {
        const provider = String(input.provider || '').toUpperCase();
        if (!['RENDER', 'VERCEL', 'NETLIFY', 'CLOUDFLARE', 'CUSTOM'].includes(provider)) throw new ApiError('VALIDATION_ERROR', 'Choose a supported deployment provider');
        installation.deploymentProvider = provider;
      }
      if (input.repository !== undefined) installation.deploymentRepository = normalizedRepository(input.repository);
      if (input.branch !== undefined) installation.deploymentBranch = requireString(input.branch, 'deployment branch', { max: 120 });
      if (input.environment !== undefined) installation.deploymentEnvironment = requireString(input.environment, 'deployment environment', { max: 80 });
      if (input.deployHookUrl !== undefined) {
        const raw = String(input.deployHookUrl || '').trim();
        if (!raw) {
          installation.hasDeployHook = false; installation.deployHookCiphertext = undefined; installation.deployHookIv = undefined; installation.deployHookTag = undefined;
        } else {
          const encrypted = encryptCredential(validDeployHook(raw));
          installation.hasDeployHook = true; installation.deployHookCiphertext = encrypted.ciphertext; installation.deployHookIv = encrypted.iv; installation.deployHookTag = encrypted.tag;
        }
      }
    },
  });
}

async function updateInstallation(id, input = {}) {
  const installation = await ClientInstallation.findById(id);
  if (!installation) throw new ApiError('NOT_FOUND', 'Client installation not found');
  if (input.plan !== undefined) {
    const plan = normalizePlan(input.plan, '');
    if (!PLAN_IDS.includes(plan)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid subscription plan');
    installation.plan = plan;
  }
  if (input.status !== undefined) {
    const status = String(input.status || '').toUpperCase();
    if (!INSTALLATION_STATUSES.includes(status)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid installation status');
    if (installation.status !== status && ['SUSPENDED', 'REVOKED'].includes(status) && String(input.statusReason || installation.statusReason || '').trim().length < 3) throw new ApiError('VALIDATION_ERROR', 'Add a reason before suspending or revoking this client');
    if (installation.status !== status) installation.statusChangedAt = new Date();
    installation.status = status;
  }
  if (input.billingCycle !== undefined) {
    const billingCycle = normalizeBillingCycle(input.billingCycle, '');
    if (!BILLING_CYCLES.includes(billingCycle)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid billing cycle');
    installation.billingCycle = billingCycle;
  }
  if (input.endsAt !== undefined) installation.endsAt = input.endsAt ? new Date(input.endsAt) : undefined;
  if (input.updateChannel !== undefined) {
    if (!['stable', 'beta'].includes(input.updateChannel)) throw new ApiError('VALIDATION_ERROR', 'Choose stable or beta updates');
    installation.updateChannel = input.updateChannel;
  }
  if (input.targetVersion !== undefined) {
    const targetVersion = safeVersion(input.targetVersion, installation.appVersion);
    if (targetVersion !== installation.appVersion) {
      const release = await PlatformRelease.exists({ version: targetVersion, status: 'PUBLISHED', channel: installation.updateChannel, $or: [{ eligibleIndustries: { $size: 0 } }, { eligibleIndustries: installation.industry }] });
      if (!release) throw new ApiError('VALIDATION_ERROR', 'Choose a published release available for this client industry and channel');
    }
    installation.targetVersion = targetVersion;
  }
  if (input.deploymentUrl !== undefined) installation.deploymentUrl = String(input.deploymentUrl || '').trim().slice(0, 300);
  if (input.deployHookUrl !== undefined) {
    const raw = String(input.deployHookUrl || '').trim();
    if (!raw) {
      installation.hasDeployHook = false;
      installation.deployHookCiphertext = undefined; installation.deployHookIv = undefined; installation.deployHookTag = undefined;
    } else {
      const encrypted = encryptCredential(validDeployHook(raw));
      installation.hasDeployHook = true;
      installation.deployHookCiphertext = encrypted.ciphertext; installation.deployHookIv = encrypted.iv; installation.deployHookTag = encrypted.tag;
    }
  }
  if (input.notes !== undefined) installation.notes = String(input.notes || '').trim().slice(0, 1000);
  if (input.statusReason !== undefined) installation.statusReason = String(input.statusReason || '').trim().slice(0, 500);
  if (input.renewalMessage !== undefined) installation.renewalMessage = String(input.renewalMessage || '').trim().slice(0, 500);
  if (input.contact && typeof input.contact === 'object') {
    const clean = (key, max) => String(input.contact[key] || '').trim().slice(0, max);
    installation.contact = { ownerName: clean('ownerName', 100), phone: clean('phone', 30), email: clean('email', 160).toLowerCase(), billingEmail: clean('billingEmail', 160).toLowerCase(), accountManager: clean('accountManager', 100) };
  }
  if (input.tags !== undefined) installation.tags = [...new Set((Array.isArray(input.tags) ? input.tags : String(input.tags).split(',')).map((item) => String(item).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);
  for (const key of ['featureOverrides', 'disabledFeatures']) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key])) throw new ApiError('VALIDATION_ERROR', `${key} must be a list`);
    const features = [...new Set(input[key].map((item) => String(item).trim()).filter(Boolean))];
    if (features.some((feature) => !FEATURE_IDS.includes(feature))) throw new ApiError('VALIDATION_ERROR', 'Choose only supported store features');
    installation[key] = features;
  }
  installation.featureOverrides = (installation.featureOverrides || []).filter((feature) => !(installation.disabledFeatures || []).includes(feature));
  if (input.limitOverrides && typeof input.limitOverrides === 'object') {
    for (const key of LIMIT_KEYS) {
      if (!(key in input.limitOverrides)) continue;
      const raw = input.limitOverrides[key];
      if (raw === '' || raw == null) installation.limitOverrides[key] = null;
      else {
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0 || value > 10000000) throw new ApiError('VALIDATION_ERROR', `${key} limit must be a whole number from 0 to 10,000,000`);
        installation.limitOverrides[key] = value;
      }
    }
  }
  if (input.grant) {
    const grant = String(input.grant).toUpperCase();
    const now = new Date();
    const base = installation.endsAt && installation.endsAt > now ? installation.endsAt : now;
    if (grant === 'TRIAL') {
      const days = Math.max(1, Math.min(365, Number.parseInt(input.grantDays || '30', 10) || 30));
      installation.status = 'TRIAL'; installation.billingCycle = 'TRIAL'; installation.startsAt = now;
      installation.trialEndsAt = new Date(now.getTime() + days * 86400000); installation.endsAt = installation.trialEndsAt;
    } else if (['MONTHLY', 'YEARLY', 'LIFETIME'].includes(grant)) {
      installation.status = 'ACTIVE'; installation.billingCycle = grant; installation.startsAt = now;
      installation.endsAt = grant === 'LIFETIME' ? undefined : nextPeriodEnd(grant, base);
    } else throw new ApiError('VALIDATION_ERROR', 'Choose a valid access grant');
  }
  await installation.save();
  return installationView(installation, await latestReleaseFor(installation));
}

async function rotateInstallationKey(id, input = {}, actor) {
  const installation = await ClientInstallation.findById(id).select('+secretSalt +secretHash +pendingSecretSalt +pendingSecretHash +pendingSecretCiphertext +pendingSecretIv +pendingSecretTag');
  if (!installation) throw new ApiError('NOT_FOUND', 'Client installation not found');
  const key = String(input.idempotencyKey || '').trim();
  if (key && !/^[A-Za-z0-9:_-]{12,120}$/.test(key)) throw new ApiError('VALIDATION_ERROR', 'A valid key-rotation operation ID is required');
  if (key) {
    const existing = await ClientInstallationOperation.findOne({ installation: installation._id, idempotencyKey: key });
    if (existing) {
      const canRecover = installation.keyRotation?.status === 'PENDING'
        && installation.keyRotation?.expiresAt && new Date(installation.keyRotation.expiresAt) > new Date()
        && installation.pendingSecretCiphertext;
      return {
        duplicate: true,
        credentials: canRecover ? {
          CONTROL_PLANE_URL: String(process.env.CONTROL_PLANE_PUBLIC_URL || process.env.PUBLIC_API_URL || 'http://localhost:5000').replace(/\/+$/, ''),
          CLIENT_INSTALLATION_ID: installation.installationId,
          CLIENT_LICENSE_KEY: decryptEncrypted(installation.pendingSecretCiphertext, installation.pendingSecretIv, installation.pendingSecretTag),
          LICENSE_SIGNING_PUBLIC_KEY: publicKeyBase64(), APP_VERSION: installation.appVersion,
        } : null,
        installation: installationView(installation, await latestReleaseFor(installation)),
      };
    }
  }
  const pendingIsLive = installation.keyRotation?.status === 'PENDING'
    && installation.keyRotation?.expiresAt && new Date(installation.keyRotation.expiresAt) > new Date();
  if (pendingIsLive) throw new ApiError('DUPLICATE_REQUEST', 'A replacement key is already waiting for client check-in. Download it again with the same operation ID or cancel it before starting another rotation.');
  const revision = input.baseRevision === undefined ? Number(installation.revision || 0) : requireRevision(installation, input.baseRevision);
  const reason = input.reason === undefined ? 'Platform owner rotated the installation credential.' : changeReason(input.reason, 'key rotation');
  const licenseKey = crypto.randomBytes(32).toString('base64url');
  const salt = crypto.randomBytes(18).toString('hex');
  const encrypted = encryptCredential(licenseKey);
  installation.pendingSecretSalt = salt;
  installation.pendingSecretHash = hashSecret(licenseKey, salt);
  installation.pendingSecretCiphertext = encrypted.ciphertext;
  installation.pendingSecretIv = encrypted.iv;
  installation.pendingSecretTag = encrypted.tag;
  installation.keyRotation = {
    status: 'PENDING', requestedAt: new Date(), expiresAt: new Date(Date.now() + 24 * 3600000),
    requestedBy: actor?._id,
  };
  await saveRevision(installation, revision);
  await recordOperation(installation, {
    actor, type: 'KEY_ROTATION_START', reason, idempotencyKey: key || undefined,
    after: { revision: installation.revision, status: 'PENDING', expiresAt: installation.keyRotation.expiresAt },
  });
  return {
    duplicate: false,
    credentials: {
      CONTROL_PLANE_URL: String(process.env.CONTROL_PLANE_PUBLIC_URL || process.env.PUBLIC_API_URL || 'http://localhost:5000').replace(/\/+$/, ''),
      CLIENT_INSTALLATION_ID: installation.installationId,
      CLIENT_LICENSE_KEY: licenseKey,
      LICENSE_SIGNING_PUBLIC_KEY: publicKeyBase64(),
      APP_VERSION: installation.appVersion,
    },
    installation: installationView(installation, await latestReleaseFor(installation)),
  };
}

async function cancelInstallationKeyRotation(id, input = {}, actor) {
  const installation = await ClientInstallation.findById(id).select('+pendingSecretSalt +pendingSecretHash +pendingSecretCiphertext +pendingSecretIv +pendingSecretTag');
  if (!installation) throw new ApiError('NOT_FOUND', 'Client installation not found');
  const revision = requireRevision(installation, input.baseRevision);
  const reason = changeReason(input.reason, 'key rotation cancellation');
  if (installation.keyRotation?.status !== 'PENDING') throw new ApiError('DUPLICATE_REQUEST', 'There is no pending key rotation to cancel');
  installation.pendingSecretSalt = undefined; installation.pendingSecretHash = undefined;
  installation.pendingSecretCiphertext = undefined; installation.pendingSecretIv = undefined; installation.pendingSecretTag = undefined;
  installation.keyRotation.status = 'CANCELLED'; installation.keyRotation.cancelledAt = new Date();
  await saveRevision(installation, revision);
  await recordOperation(installation, { actor, type: 'KEY_ROTATION_CANCEL', reason, after: { revision: installation.revision, status: 'CANCELLED' } });
  return installation;
}

async function triggerDeployment(id, input = {}, actor) {
  const installation = await ClientInstallation.findById(id).select('+deployHookCiphertext +deployHookIv +deployHookTag');
  if (!installation) throw new ApiError('NOT_FOUND', 'Client installation not found');
  if (!installation.hasDeployHook || !installation.deployHookCiphertext) throw new ApiError('VALIDATION_ERROR', 'Add this client deployment hook before triggering an update');
  const revision = input.baseRevision === undefined ? Number(installation.revision || 0) : requireRevision(installation, input.baseRevision);
  const reason = input.reason === undefined ? 'Platform owner requested a deployment.' : changeReason(input.reason, 'deployment');
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (idempotencyKey && !/^[A-Za-z0-9:_-]{12,120}$/.test(idempotencyKey)) throw new ApiError('VALIDATION_ERROR', 'A valid deployment operation ID is required');
  if (idempotencyKey) {
    const existing = await ClientInstallationOperation.findOne({ installation: installation._id, idempotencyKey });
    if (existing) return installationView(installation, await latestReleaseFor(installation));
  }
  const hook = decryptCredential(installation);
  const deploymentAttempt = { status: 'REQUESTED', version: installation.targetVersion, requestedAt: new Date(), message: 'Deployment requested by the platform owner' };
  installation.lastDeployment = deploymentAttempt;
  await saveRevision(installation, revision);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(hook, {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { 'user-agent': 'Samira-Control-Plane/1.0', 'x-platform-release': installation.targetVersion, 'x-installation-id': installation.installationId },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    installation.lastDeployment = { ...deploymentAttempt, status: 'SUCCEEDED', completedAt: new Date(), message: 'The hosting provider accepted the deployment request' };
    await installation.save();
    await recordOperation(installation, {
      actor, type: 'DEPLOYMENT_REQUEST', reason, idempotencyKey: idempotencyKey || undefined,
      after: { targetVersion: installation.targetVersion, provider: installation.deploymentProvider, status: 'SUCCEEDED' },
      metadata: { repository: installation.deploymentRepository, branch: installation.deploymentBranch, environment: installation.deploymentEnvironment },
    });
    return installationView(installation, await latestReleaseFor(installation));
  } catch (error) {
    installation.lastDeployment = { ...deploymentAttempt, status: 'FAILED', completedAt: new Date(), message: 'The hosting provider did not accept the deployment request' };
    await installation.save().catch(() => null);
    await recordOperation(installation, {
      actor, type: 'DEPLOYMENT_REQUEST', reason, idempotencyKey: idempotencyKey || undefined,
      after: { targetVersion: installation.targetVersion, provider: installation.deploymentProvider, status: 'FAILED' },
      metadata: { repository: installation.deploymentRepository, branch: installation.deploymentBranch, environment: installation.deploymentEnvironment, error: String(error.message || 'Deployment failed').slice(0, 200) },
    }).catch(() => null);
    throw new ApiError('SERVICE_UNAVAILABLE', 'The client deployment hook could not be reached');
  } finally { clearTimeout(timer); }
}

async function createRelease(input = {}, actor) {
  const version = safeVersion(input.version);
  const channel = ['stable', 'beta'].includes(input.channel) ? input.channel : 'stable';
  const status = ['DRAFT', 'PUBLISHED'].includes(String(input.status || '').toUpperCase()) ? String(input.status).toUpperCase() : 'PUBLISHED';
  const eligibleIndustries = [...new Set((Array.isArray(input.eligibleIndustries) ? input.eligibleIndustries : []).map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  const rolloutPercent = Number(input.rolloutPercent ?? 100);
  if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) throw new ApiError('VALIDATION_ERROR', 'Rollout percentage must be from 0 to 100');
  const artifact = input.artifact && typeof input.artifact === 'object' ? input.artifact : {};
  const checksumSha256 = String(artifact.checksumSha256 || '').trim().toLowerCase();
  if (checksumSha256 && !/^[a-f0-9]{64}$/.test(checksumSha256)) throw new ApiError('VALIDATION_ERROR', 'Artifact checksum must be a SHA-256 value');
  const commitSha = String(artifact.commitSha || '').trim();
  if (commitSha && !/^[a-f0-9]{7,64}$/i.test(commitSha)) throw new ApiError('VALIDATION_ERROR', 'Enter a valid source commit SHA');
  return PlatformRelease.create({
    version, channel, status, eligibleIndustries, mandatory: Boolean(input.mandatory),
    notes: String(input.notes || '').trim(), createdBy: actor?._id,
    rolloutStatus: rolloutPercent === 0 ? 'PAUSED' : rolloutPercent === 100 ? 'COMPLETED' : 'ACTIVE', rolloutPercent,
    artifact: {
      url: artifact.url ? normalizedPublicUrl(artifact.url, 'artifact URL') : '', checksumSha256, commitSha,
      repository: artifact.repository ? normalizedRepository(artifact.repository) : '',
      migrationVersion: optionalString(artifact.migrationVersion, 'migration version', { max: 80 }),
      minimumProtocol: Math.max(1, Math.min(1000, Number.parseInt(artifact.minimumProtocol || '1', 10) || 1)),
    },
  });
}

async function updateRelease(id, input = {}) {
  const release = await PlatformRelease.findById(id);
  if (!release) throw new ApiError('NOT_FOUND', 'Platform release not found');
  const revision = Number(input.baseRevision);
  if (!Number.isInteger(revision) || revision !== Number(release.revision || 0)) throw new ApiError('DUPLICATE_REQUEST', 'This release changed in another session. Reload before updating it.');
  const action = String(input.action || '').toUpperCase();
  if (!['PAUSE', 'RESUME', 'COMPLETE', 'RETIRE'].includes(action)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid release action');
  changeReason(input.reason, 'release change');
  if (action === 'RETIRE') { release.status = 'RETIRED'; release.rolloutStatus = 'COMPLETED'; }
  else {
    if (release.status !== 'PUBLISHED') throw new ApiError('VALIDATION_ERROR', 'Only a published release can be rolled out');
    if (input.rolloutPercent !== undefined) {
      const percent = Number(input.rolloutPercent);
      if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new ApiError('VALIDATION_ERROR', 'Rollout percentage must be from 0 to 100');
      release.rolloutPercent = percent;
    }
    if (action === 'PAUSE') release.rolloutStatus = 'PAUSED';
    if (action === 'RESUME') release.rolloutStatus = Number(release.rolloutPercent) >= 100 ? 'COMPLETED' : 'ACTIVE';
    if (action === 'COMPLETE') { release.rolloutPercent = 100; release.rolloutStatus = 'COMPLETED'; }
  }
  release.revision = revision + 1; release.$where = revision === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision };
  try { await release.save(); }
  catch (error) {
    if (error?.name === 'DocumentNotFoundError') throw new ApiError('DUPLICATE_REQUEST', 'This release changed in another session. Reload before updating it.');
    throw error;
  } finally { release.$where = undefined; }
  return release;
}

async function readPurchase(input = {}, installation) {
  const plan = normalizePlan(input.plan, '');
  const billingCycle = normalizeBillingCycle(input.billingCycle, '');
  if (!PLAN_IDS.includes(plan)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid subscription plan');
  if (!PAID_CYCLES.includes(billingCycle)) throw new ApiError('VALIDATION_ERROR', 'Choose monthly, yearly or lifetime billing');
  if (installation.status === 'REVOKED') throw new ApiError('FORBIDDEN', 'This installation has been revoked');
  const current = effectivePlatform(installation);
  if (current.status === 'ACTIVE' && PLAN_IDS.indexOf(plan) < PLAN_IDS.indexOf(current.id)) throw new ApiError('VALIDATION_ERROR', 'A lower plan can be selected after the current access period ends');
  if (current.status === 'ACTIVE' && current.billingCycle === 'LIFETIME' && billingCycle !== 'LIFETIME') throw new ApiError('VALIDATION_ERROR', 'Lifetime access cannot be replaced with a time-limited plan');
  if (current.status === 'ACTIVE' && current.billingCycle === 'LIFETIME' && current.id === plan) throw new ApiError('DUPLICATE_REQUEST', 'Lifetime access is already active for this plan');
  return { plan, billingCycle, ...(await priceFor(plan, billingCycle)) };
}

async function createCheckout({ installation, input }) {
  if (!isRazorpayConfigured()) throw new ApiError('SERVICE_UNAVAILABLE', 'Online subscription payment is not configured');
  const purchase = await readPurchase(input, installation);
  const recent = new Date(Date.now() - 15 * 60000);
  let payment = await InstallationPayment.findOne({ installation: installation._id, ...purchase, status: 'CREATED', createdAt: { $gte: recent } }).sort('-createdAt');
  if (!payment) {
    const receipt = `client_${installation.installationId.slice(-7)}_${Date.now().toString(36)}`.slice(0, 40);
    payment = await InstallationPayment.create({ installation: installation._id, installationId: installation.installationId, ...purchase, receipt });
    try {
      const order = await createRazorpayOrder({ amountInPaise: purchase.amount * 100, receipt, notes: { purpose: 'CLIENT_INSTALLATION_SUBSCRIPTION', installationId: installation.installationId, installationPaymentId: String(payment._id), plan: purchase.plan, billingCycle: purchase.billingCycle } });
      payment.razorpayOrderId = order.id; await payment.save();
    } catch (error) {
      payment.status = 'FAILED'; payment.failureReason = String(error.message || 'Unable to start payment').slice(0, 300); await payment.save().catch(() => null);
      throw new ApiError('SERVICE_UNAVAILABLE', 'Unable to start subscription payment');
    }
  }
  return { orderId: payment.razorpayOrderId, amount: payment.amount * 100, currency: payment.currency, keyId: process.env.RAZORPAY_KEY_ID, plan: payment.plan, billingCycle: payment.billingCycle, storeName: installation.companyName };
}

async function activatePayment(payment) {
  const installation = await ClientInstallation.findById(payment.installation);
  if (!installation) throw new ApiError('NOT_FOUND', 'Client installation not found');
  const now = payment.paidAt || new Date();
  let periodStart = payment.periodStart || now;
  const current = effectivePlatform(installation, now);
  if (!payment.periodStart && payment.billingCycle !== 'LIFETIME' && current.status === 'ACTIVE' && current.id === payment.plan && current.endsAt && new Date(current.endsAt) > now) periodStart = new Date(current.endsAt);
  const periodEnd = payment.periodStart ? payment.periodEnd : nextPeriodEnd(payment.billingCycle, periodStart);
  installation.plan = payment.plan; installation.status = 'ACTIVE'; installation.billingCycle = payment.billingCycle;
  installation.startsAt = now; installation.endsAt = periodEnd || undefined;
  installation.lastPayment = { orderId: payment.razorpayOrderId, paymentId: payment.razorpayPaymentId, amount: payment.amount, currency: payment.currency, paidAt: now };
  await installation.save();
  if (!payment.periodStart) { payment.periodStart = periodStart; payment.periodEnd = periodEnd || undefined; await payment.save(); }
  return installation;
}

async function markPaymentPaid(payment, paymentId, verified = false) {
  if (payment.status !== 'PAID') {
    const now = new Date();
    const installation = await ClientInstallation.findById(payment.installation);
    let periodStart = now;
    const current = effectivePlatform(installation, now);
    if (payment.billingCycle !== 'LIFETIME' && current.status === 'ACTIVE' && current.id === payment.plan && current.endsAt && new Date(current.endsAt) > now) periodStart = new Date(current.endsAt);
    const periodEnd = nextPeriodEnd(payment.billingCycle, periodStart);
    const claimed = await InstallationPayment.findOneAndUpdate({ _id: payment._id, status: { $ne: 'PAID' } }, { $set: { status: 'PAID', razorpayPaymentId: paymentId, signatureVerified: verified, paidAt: now, periodStart, ...(periodEnd ? { periodEnd } : {}) } }, { new: true });
    payment = claimed || await InstallationPayment.findById(payment._id);
  }
  return { payment, installation: await activatePayment(payment) };
}

async function verifyCheckout({ installation, input }) {
  const orderId = String(input.razorpay_order_id || input.orderId || '').trim();
  const paymentId = String(input.razorpay_payment_id || input.paymentId || '').trim();
  const signature = String(input.razorpay_signature || input.signature || '').trim();
  const payment = await InstallationPayment.findOne({ installation: installation._id, razorpayOrderId: orderId });
  if (!payment) throw new ApiError('NOT_FOUND', 'Subscription payment was not found');
  if (payment.status !== 'PAID' && !verifyRazorpaySignature({ razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature, secret: process.env.RAZORPAY_KEY_SECRET })) throw new ApiError('PAYMENT_FAILED', 'Subscription payment verification failed');
  return markPaymentPaid(payment, payment.status === 'PAID' ? payment.razorpayPaymentId : paymentId, payment.status === 'PAID' ? payment.signatureVerified : true);
}

async function handleWebhook({ razorpayOrderId, razorpayPaymentId, event }) {
  if (!['payment.captured', 'order.paid', 'payment.failed'].includes(event) || !razorpayOrderId) return null;
  const payment = await InstallationPayment.findOne({ razorpayOrderId });
  if (!payment) return null;
  if (event === 'payment.failed') {
    if (payment.status !== 'PAID') { payment.status = 'FAILED'; payment.failureReason = 'Payment provider reported a failed payment'; await payment.save(); }
    return { payment, installation: await ClientInstallation.findById(payment.installation), outcome: 'FAILED' };
  }
  const result = await markPaymentPaid(payment, razorpayPaymentId || payment.razorpayPaymentId, true);
  return { ...result, outcome: 'PAID' };
}

async function handleRefundWebhook({ razorpayPaymentId, refundId, refundedAmount }) {
  if (!razorpayPaymentId) return null;
  const payment = await InstallationPayment.findOne({ razorpayPaymentId });
  if (!payment) return null;
  const safeRefundId = String(refundId || '').trim().slice(0, 100);
  if (!safeRefundId) throw new ApiError('VALIDATION_ERROR', 'Refund ID is required');
  if ((payment.refunds || []).some((item) => item.refundId === safeRefundId)) return { payment, installation: await ClientInstallation.findById(payment.installation), outcome: payment.status, duplicate: true };
  const amount = Math.max(0, Number(refundedAmount || 0));
  payment.refundId = safeRefundId;
  payment.refunds ||= [];
  payment.refunds.push({ refundId: safeRefundId, amount, processedAt: new Date() });
  payment.refundedAmount = Math.min(payment.amount, payment.refunds.reduce((sum, item) => sum + Number(item.amount || 0), 0));
  payment.refundedAt = new Date();
  if (payment.refundedAmount >= payment.amount) payment.status = 'REFUNDED';
  await payment.save();
  const installation = await ClientInstallation.findById(payment.installation);
  if (installation) {
    const fullRefund = payment.status === 'REFUNDED';
    const currentPayment = String(installation.lastPayment?.paymentId || '') === String(payment.razorpayPaymentId || '');
    const before = operationSnapshot(installation);
    installation.billingReview = {
      required: true,
      reason: fullRefund ? 'Full subscription payment refund requires access review.' : 'Partial subscription refund requires billing review.',
      paymentId: payment.razorpayPaymentId,
      createdAt: new Date(),
    };
    if (fullRefund && currentPayment && ['ACTIVE', 'TRIAL'].includes(effectivePlatform(installation).status)) {
      installation.status = 'SUSPENDED';
      installation.statusReason = 'Latest subscription payment was fully refunded. Review access before restoring.';
      installation.statusChangedAt = new Date();
    }
    await saveRevision(installation, Number(installation.revision || 0));
    await recordOperation(installation, {
      type: 'REFUND_RECONCILIATION', source: 'PAYMENT', reason: installation.billingReview.reason,
      before, after: operationSnapshot(installation), metadata: { refundId: safeRefundId, amount, totalRefunded: payment.refundedAmount, fullRefund, currentPayment },
    }).catch(() => null);
  }
  return { payment, installation, outcome: payment.status, duplicate: false };
}

module.exports = {
  authenticateInstallation, clientControlWorkspace, compareVersions, createCheckout, createRelease, effectivePlatform,
  cancelInstallationKeyRotation, grantInstallationAccess, handleRefundWebhook, handleWebhook, installationOperations,
  installationView, latestReleaseFor, listInstallations, planCatalog, provisionInstallation,
  rotateInstallationKey, triggerDeployment, updateInstallation, updateInstallationDeployment, updateRelease,
  updateInstallationEntitlements, updateInstallationLifecycle, updateInstallationProfile,
  updateInstallationSubscription, validateInstallation, verifyCheckout,
};
