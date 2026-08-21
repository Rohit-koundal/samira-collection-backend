/**
 * Central place for secrets and mode flags.
 *
 * Production must supply real secrets. Development keeps working without a
 * .env file so local demos and offline sessions are unaffected.
 */

const DEV_JWT_SECRET = 'samira_dev_only_access_secret_not_for_production';
const DEV_JWT_REFRESH_SECRET = 'samira_dev_only_refresh_secret_not_for_production';
const DEFAULT_DEMO_OTP = '123456';

const REQUIRED_PRODUCTION_SECRETS = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'MONGO_URI'];

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function missingProductionSecrets() {
  if (!isProduction()) return [];
  return REQUIRED_PRODUCTION_SECRETS.filter((key) => !String(process.env[key] || '').trim());
}

function assertProductionSecrets() {
  const missing = missingProductionSecrets();
  if (missing.length) {
    throw new Error(`Missing required production environment variables: ${missing.join(', ')}`);
  }
}

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (secret) return secret;
  if (isProduction()) throw new Error('JWT_SECRET is required in production');
  return DEV_JWT_SECRET;
}

function getJwtRefreshSecret() {
  const secret = String(process.env.JWT_REFRESH_SECRET || '').trim();
  if (secret) return secret;
  if (isProduction()) throw new Error('JWT_REFRESH_SECRET is required in production');
  return String(process.env.JWT_SECRET || '').trim() || DEV_JWT_REFRESH_SECRET;
}

/**
 * OTP_MODE controls whether the fixed demo code is accepted.
 *
 * demo       - fixed DEMO_OTP is issued and surfaced to the client so the
 *              product can be demonstrated without an SMS provider.
 * production - a random code is issued, never returned to the client, and a
 *              delivery failure fails the request instead of silently
 *              falling back to a guessable code.
 *
 * Defaults to demo so the existing demo deployment keeps working. Switch to
 * production once a real SMS provider is connected.
 */
function getOtpMode() {
  const mode = String(process.env.OTP_MODE || '').trim().toLowerCase();
  if (mode === 'production' || mode === 'demo') return mode;
  return 'demo';
}

function isDemoOtpMode() {
  return getOtpMode() === 'demo';
}

function getDemoOtp() {
  const code = String(process.env.DEMO_OTP || process.env.OTP_DEV_CODE || '').trim();
  return /^\d{6}$/.test(code) ? code : DEFAULT_DEMO_OTP;
}

module.exports = {
  DEV_JWT_SECRET,
  DEV_JWT_REFRESH_SECRET,
  REQUIRED_PRODUCTION_SECRETS,
  assertProductionSecrets,
  getDemoOtp,
  getJwtRefreshSecret,
  getJwtSecret,
  getOtpMode,
  isDemoOtpMode,
  isProduction,
  missingProductionSecrets,
};
