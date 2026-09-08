const { isDemoOtpMode } = require('./env');

function isHostedOwnerDemoEnabled() {
  // Customer demo OTP mode must never silently downgrade the owner account.
  // Hosted owner demo access is a separate, explicit opt-in.
  return String(process.env.OTP_MODE || '').trim().toLowerCase() === 'demo'
    && String(process.env.ALLOW_HOSTED_OWNER_DEMO || '').trim().toLowerCase() === 'true';
}

function isLocalOwnerDemoEnabled() {
  return process.env.LOCAL_OWNER_DEMO === 'true' && isDemoOtpMode() && !isHostedOwnerDemoEnabled();
}

function isLoopback(address) {
  return ['127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(String(address || '').toLowerCase());
}

function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password
      && (url.hostname === 'localhost' || isLoopback(url.hostname));
  } catch {
    return false;
  }
}

function isLocalOwnerDemoRequest(req) {
  // Only server.js can mark the listener, while binding it to loopback.
  // Never trust req.ip/hostname: Express may derive them from proxy headers.
  const headers = req?.headers || {};
  return isLocalOwnerDemoEnabled()
    && req?.app?.locals?.localOwnerDemo === true
    && isLoopback(req?.socket?.remoteAddress)
    && isLoopback(req?.socket?.localAddress)
    && isLocalUrl(`http://${headers.host || ''}`)
    && (!headers.origin || isLocalUrl(headers.origin))
    && !Object.keys(headers).some(key => key.toLowerCase() === 'forwarded' || key.toLowerCase().startsWith('x-forwarded-'));
}

function allowsOwnerDemoSession(claims, req) {
  if (claims?.localOwnerDemo && claims?.hostedOwnerDemo) return false;
  if (claims?.hostedOwnerDemo) return isHostedOwnerDemoEnabled();
  return !claims?.localOwnerDemo || isLocalOwnerDemoRequest(req);
}

function getOwnerDemoProvider(req) {
  if (isHostedOwnerDemoEnabled()) return 'hosted-demo';
  return isLocalOwnerDemoRequest(req) ? 'local-demo' : '';
}

module.exports = { isLocalOwnerDemoEnabled, isLocalOwnerDemoRequest, isHostedOwnerDemoEnabled, getOwnerDemoProvider, allowsOwnerDemoSession };
