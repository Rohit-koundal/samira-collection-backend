const crypto = require('crypto');
const ClientInstallation = require('../models/ClientInstallation');
const PlatformRelease = require('../models/PlatformRelease');
const InstallationPayment = require('../models/InstallationPayment');
const { ApiError } = require('../utils/apiError');
const { createRazorpayOrder, isRazorpayConfigured } = require('./razorpayService');
const { verifyRazorpaySignature } = require('../utils/paymentUtils');
const { signPayload, publicKeyBase64, signingReady } = require('./licenseSignatureService');
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

function planCatalog() {
  return Object.values(STORE_PLANS).map((plan) => ({
    id: plan.id, name: plan.name, description: plan.description,
    features: [...plan.features], limits: { ...plan.limits }, prices: { ...plan.prices },
  }));
}

function hashSecret(secret, salt) {
  return crypto.scryptSync(secret, salt, 64).toString('hex');
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

function validDeployHook(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new ApiError('VALIDATION_ERROR', 'Enter a valid deployment hook URL'); }
  const localDevelopment = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(localDevelopment && url.protocol === 'http:')) throw new ApiError('VALIDATION_ERROR', 'Deployment hooks must use HTTPS');
  const allowedHosts = new Set(['api.render.com', 'api.vercel.com', 'api.netlify.com', 'hooks.netlify.com', ...String(process.env.DEPLOY_HOOK_ALLOWED_HOSTS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)]);
  if (!localDevelopment && !allowedHosts.has(url.hostname.toLowerCase())) throw new ApiError('VALIDATION_ERROR', 'This deployment-hook host is not allowed');
  return url.toString();
}

function matchesSecret(installation, candidate) {
  const actual = Buffer.from(String(installation.secretHash || ''), 'hex');
  const expected = Buffer.from(hashSecret(String(candidate || ''), installation.secretSalt), 'hex');
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
  const installation = await ClientInstallation.findOne({ installationId: String(installationId) }).select('+secretSalt +secretHash');
  if (!installation || !matchesSecret(installation, secret)) throw new ApiError('UNAUTHORIZED', 'Installation credentials are invalid');
  return installation;
}

async function latestReleaseFor(installation) {
  const releases = await PlatformRelease.find({
    status: 'PUBLISHED', channel: installation.updateChannel || 'stable',
    $or: [{ eligibleIndustries: { $size: 0 } }, { eligibleIndustries: installation.industry }],
  }).sort('-publishedAt').limit(100).lean();
  return releases.sort((left, right) => compareVersions(right.version, left.version))[0] || null;
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
  return {
    id: String(installation._id), installationId: installation.installationId,
    companyName: installation.companyName, projectName: installation.projectName, projectSlug: installation.projectSlug,
    industry: installation.industry, status: platform.status, plan: platform.id, billingCycle: platform.billingCycle,
    startsAt: platform.startsAt, endsAt: platform.endsAt, daysRemaining: platform.daysRemaining,
    features: platform.features, limits: platform.limits, limitOverrides: platform.limitOverrides,
    featureOverrides: [...(installation.featureOverrides || [])], disabledFeatures: [...(installation.disabledFeatures || [])],
    appVersion: installation.appVersion, targetVersion: installation.targetVersion,
    latestVersion, updateChannel: installation.updateChannel,
    updateAvailable: compareVersions(installation.lastValidatedVersion || installation.appVersion, installation.targetVersion || latestVersion) < 0,
    lastValidatedVersion: installation.lastValidatedVersion || null, lastSeenAt: installation.lastSeenAt || null,
    deploymentUrl: installation.deploymentUrl || '', notes: installation.notes || '', createdAt: installation.createdAt,
    contact: installation.contact?.toObject?.() || installation.contact || {}, tags: [...(installation.tags || [])],
    statusReason: installation.statusReason || '', statusChangedAt: installation.statusChangedAt || null,
    renewalMessage: installation.renewalMessage || '', lastPayment: platform.lastPayment || null,
    usage: installation.usage?.toObject?.() || installation.usage || {},
    health: { status: connectionStatus, databaseStatus, serviceStatus: installation.runtime?.serviceStatus || 'UNKNOWN', lastError: installation.runtime?.lastError || '', reportedAt: installation.runtime?.reportedAt || null },
    deployment: { hasHook: Boolean(installation.hasDeployHook), phase: deploymentPhase, last: deployment },
  };
}

async function validateInstallation({ installationId, secret, appVersion, ip, telemetry }) {
  const installation = await authenticateInstallation(installationId, secret);
  const currentVersion = safeVersion(appVersion || installation.appVersion);
  const platform = effectivePlatform(installation);
  const now = new Date();
  if (platform.status === 'EXPIRED' && installation.status !== 'EXPIRED') installation.status = 'EXPIRED';
  installation.lastSeenAt = now;
  installation.lastValidatedVersion = currentVersion;
  installation.appVersion = currentVersion;
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
    };
  }
  await installation.save();
  const release = await latestReleaseFor(installation);
  const view = installationView(installation, release);
  const validMinutes = Math.max(5, Number.parseInt(process.env.LICENSE_VALID_MINUTES || '15', 10) || 15);
  const graceHours = Math.max(1, Number.parseInt(process.env.LICENSE_GRACE_HOURS || '72', 10) || 72);
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
    plans: planCatalog(),
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
  await ClientInstallation.updateMany({ status: { $in: ['ACTIVE', 'TRIAL'] }, endsAt: { $lte: now } }, { $set: { status: 'EXPIRED', statusChangedAt: now } });
  const page = Math.max(1, Math.min(10000, Number.parseInt(input.page || '1', 10) || 1));
  const limit = Math.max(6, Math.min(50, Number.parseInt(input.limit || '12', 10) || 12));
  const filter = {};
  if (INSTALLATION_STATUSES.includes(String(input.status || '').toUpperCase())) filter.status = String(input.status).toUpperCase();
  if (PLAN_IDS.includes(String(input.plan || '').toUpperCase())) filter.plan = String(input.plan).toUpperCase();
  if (input.industry) filter.industry = String(input.industry).trim().toLowerCase();
  if (input.q) {
    const pattern = new RegExp(safeRegex(String(input.q).trim().slice(0, 100)), 'i');
    filter.$or = ['companyName', 'projectName', 'projectSlug', 'installationId', 'deploymentUrl', 'contact.ownerName', 'contact.email', 'contact.phone', 'tags'].map((field) => ({ [field]: pattern }));
  }
  const attention = String(input.attention || '');
  if (attention === 'expiring') filter.endsAt = { $gt: now, $lte: new Date(now.getTime() + 30 * 86400000) };
  if (attention === 'offline') filter.$and = [{ $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: new Date(now.getTime() - 24 * 3600000) } }] }];
  if (attention === 'updates') filter.$expr = { $ne: ['$targetVersion', { $ifNull: ['$lastValidatedVersion', '$appVersion'] }] };
  const expiry = new Date(now.getTime() + 30 * 86400000);
  const offline = new Date(now.getTime() - 24 * 3600000);
  const [installations, total, releases, active, trials, expiring, offlineCount, revenue] = await Promise.all([
    ClientInstallation.find(filter).sort('-createdAt').skip((page - 1) * limit).limit(limit),
    ClientInstallation.countDocuments(filter),
    PlatformRelease.find().sort('-publishedAt').limit(100).lean(),
    ClientInstallation.countDocuments({ status: 'ACTIVE' }), ClientInstallation.countDocuments({ status: 'TRIAL' }),
    ClientInstallation.countDocuments({ status: { $in: ['ACTIVE', 'TRIAL'] }, endsAt: { $gt: now, $lte: expiry } }),
    ClientInstallation.countDocuments({ $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: offline } }] }),
    InstallationPayment.aggregate([{ $match: { status: 'PAID', paidAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) } } }, { $group: { _id: null, amount: { $sum: '$amount' } } }]),
  ]);
  const published = releases.filter((item) => item.status === 'PUBLISHED');
  return {
    installations: installations.map((installation) => {
      const eligible = published.filter((release) => release.channel === installation.updateChannel && (!release.eligibleIndustries?.length || release.eligibleIndustries.includes(installation.industry))).sort((a, b) => compareVersions(b.version, a.version))[0] || null;
      return installationView(installation, eligible);
    }),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    summary: { total: await ClientInstallation.countDocuments(), active, trials, expiring, offline: offlineCount, monthlyRevenue: revenue[0]?.amount || 0 },
    plans: planCatalog(), releases: releases.map((item) => ({ ...item, id: String(item._id), _id: undefined })),
  };
}

async function installationOperations(id) {
  const installation = await ClientInstallation.findById(id);
  if (!installation) throw new ApiError('NOT_FOUND', 'Client installation not found');
  const [payments, paymentTotal] = await Promise.all([
    InstallationPayment.find({ installation: installation._id }).sort('-createdAt').limit(50).lean(),
    InstallationPayment.countDocuments({ installation: installation._id }),
  ]);
  return { installation: installationView(installation, await latestReleaseFor(installation)), payments: payments.map((item) => ({ ...item, id: String(item._id), _id: undefined, installation: undefined })), paymentTotal };
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

async function rotateInstallationKey(id) {
  const installation = await ClientInstallation.findById(id).select('+secretSalt +secretHash');
  if (!installation) throw new ApiError('NOT_FOUND', 'Client installation not found');
  const licenseKey = crypto.randomBytes(32).toString('base64url');
  installation.secretSalt = crypto.randomBytes(18).toString('hex');
  installation.secretHash = hashSecret(licenseKey, installation.secretSalt);
  await installation.save();
  return {
    CONTROL_PLANE_URL: String(process.env.CONTROL_PLANE_PUBLIC_URL || process.env.PUBLIC_API_URL || 'http://localhost:5000').replace(/\/+$/, ''),
    CLIENT_INSTALLATION_ID: installation.installationId,
    CLIENT_LICENSE_KEY: licenseKey,
    LICENSE_SIGNING_PUBLIC_KEY: publicKeyBase64(),
    APP_VERSION: installation.appVersion,
  };
}

async function triggerDeployment(id) {
  const installation = await ClientInstallation.findById(id).select('+deployHookCiphertext +deployHookIv +deployHookTag');
  if (!installation) throw new ApiError('NOT_FOUND', 'Client installation not found');
  if (!installation.hasDeployHook || !installation.deployHookCiphertext) throw new ApiError('VALIDATION_ERROR', 'Add this client deployment hook before triggering an update');
  const hook = decryptCredential(installation);
  const deploymentAttempt = { status: 'REQUESTED', version: installation.targetVersion, requestedAt: new Date(), message: 'Deployment requested by the platform owner' };
  installation.lastDeployment = deploymentAttempt;
  await installation.save();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(hook, { method: 'POST', signal: controller.signal, redirect: 'error', headers: { 'user-agent': 'Samira-Control-Plane/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    installation.lastDeployment = { ...deploymentAttempt, status: 'SUCCEEDED', completedAt: new Date(), message: 'The hosting provider accepted the deployment request' };
    await installation.save();
    return installationView(installation, await latestReleaseFor(installation));
  } catch {
    installation.lastDeployment = { ...deploymentAttempt, status: 'FAILED', completedAt: new Date(), message: 'The hosting provider did not accept the deployment request' };
    await installation.save().catch(() => null);
    throw new ApiError('SERVICE_UNAVAILABLE', 'The client deployment hook could not be reached');
  } finally { clearTimeout(timer); }
}

async function createRelease(input = {}, actor) {
  const version = safeVersion(input.version);
  const channel = ['stable', 'beta'].includes(input.channel) ? input.channel : 'stable';
  const status = ['DRAFT', 'PUBLISHED'].includes(String(input.status || '').toUpperCase()) ? String(input.status).toUpperCase() : 'PUBLISHED';
  const eligibleIndustries = [...new Set((Array.isArray(input.eligibleIndustries) ? input.eligibleIndustries : []).map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  return PlatformRelease.create({ version, channel, status, eligibleIndustries, mandatory: Boolean(input.mandatory), notes: String(input.notes || '').trim(), createdBy: actor?._id });
}

function readPurchase(input = {}, installation) {
  const plan = normalizePlan(input.plan, '');
  const billingCycle = normalizeBillingCycle(input.billingCycle, '');
  if (!PLAN_IDS.includes(plan)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid subscription plan');
  if (!PAID_CYCLES.includes(billingCycle)) throw new ApiError('VALIDATION_ERROR', 'Choose monthly, yearly or lifetime billing');
  if (installation.status === 'REVOKED') throw new ApiError('FORBIDDEN', 'This installation has been revoked');
  const current = effectivePlatform(installation);
  if (current.status === 'ACTIVE' && PLAN_IDS.indexOf(plan) < PLAN_IDS.indexOf(current.id)) throw new ApiError('VALIDATION_ERROR', 'A lower plan can be selected after the current access period ends');
  if (current.status === 'ACTIVE' && current.billingCycle === 'LIFETIME' && billingCycle !== 'LIFETIME') throw new ApiError('VALIDATION_ERROR', 'Lifetime access cannot be replaced with a time-limited plan');
  if (current.status === 'ACTIVE' && current.billingCycle === 'LIFETIME' && current.id === plan) throw new ApiError('DUPLICATE_REQUEST', 'Lifetime access is already active for this plan');
  const amount = STORE_PLANS[plan].prices[billingCycle.toLowerCase()];
  return { plan, billingCycle, amount };
}

async function createCheckout({ installation, input }) {
  if (!isRazorpayConfigured()) throw new ApiError('SERVICE_UNAVAILABLE', 'Online subscription payment is not configured');
  const purchase = readPurchase(input, installation);
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
  const amount = Math.max(0, Number(refundedAmount || 0));
  payment.refundId = String(refundId || '').slice(0, 100);
  payment.refundedAmount = Math.max(Number(payment.refundedAmount || 0), amount);
  payment.refundedAt = new Date();
  if (payment.refundedAmount >= payment.amount) payment.status = 'REFUNDED';
  await payment.save();
  return { payment, installation: await ClientInstallation.findById(payment.installation), outcome: payment.status };
}

module.exports = {
  authenticateInstallation, clientControlWorkspace, compareVersions, createCheckout, createRelease, effectivePlatform,
  handleRefundWebhook, handleWebhook, installationOperations, installationView, listInstallations, planCatalog, provisionInstallation,
  rotateInstallationKey, triggerDeployment, updateInstallation, validateInstallation, verifyCheckout,
};
