const crypto = require('crypto');
const compression = require('compression');
const helmet = require('helmet');
const hpp = require('hpp');

const requestCompression = compression({ threshold: 1024 });
const queryPollutionProtection = hpp();
const secureHeaders = helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
});

function requestContext(req, res, next) {
  const supplied = String(req.get('X-Request-ID') || '');
  req.id = /^[a-zA-Z0-9._:-]{8,100}$/.test(supplied) ? supplied : crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  const startedAt = process.hrtime.bigint();
  req.log = createRequestLogger(req);
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    writeLog('info', {
      event: 'http_request',
      requestId: req.id,
      method: req.method,
      route: safeRoute(req),
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      userId: req.user?._id ? String(req.user._id) : undefined,
    });
  });
  next();
}

function rejectUnsafeMongoKeys(req, res, next) {
  try {
    for (const [name, value] of [['body', req.body], ['query', req.query], ['params', req.params]]) {
      findUnsafeKey(value, name);
    }
    next();
  } catch (error) {
    error.statusCode = 400;
    error.code = 'UNSAFE_QUERY_KEY';
    next(error);
  }
}

function findUnsafeKey(value, path, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findUnsafeKey(entry, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$') || key.includes('.')) throw new Error(`Unsafe request key at ${path}`);
    findUnsafeKey(child, `${path}.${key}`, seen);
  }
}

function createRequestLogger(req) {
  const base = { requestId: req.id };
  return {
    info: (fields) => writeLog('info', { ...base, ...sanitizeLogFields(fields) }),
    warn: (fields) => writeLog('warn', { ...base, ...sanitizeLogFields(fields) }),
    error: (fields) => writeLog('error', { ...base, ...sanitizeLogFields(fields) }),
  };
}

function sanitizeLogFields(fields) {
  if (!fields || typeof fields !== 'object') return { message: String(fields || '') };
  const blocked = /password|otp|token|secret|authorization|cookie|signature|credential|card/i;
  return Object.fromEntries(Object.entries(fields)
    .filter(([key]) => !blocked.test(key))
    .map(([key, value]) => [key, safeLogValue(value)]));
}

function safeLogValue(value) {
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
  if (value instanceof Error) return { name: value.name, code: value.code };
  if (typeof value === 'string') return value.slice(0, 500).replace(/[\r\n]/g, ' ');
  if (Array.isArray(value)) return value.slice(0, 20).map(safeLogValue);
  if (typeof value === 'object') return sanitizeLogFields(value);
  return String(value).slice(0, 200);
}

function writeLog(level, fields) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, ...fields });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

function safeRoute(req) {
  const path = String(req.originalUrl || req.path || '/').split('?')[0];
  return path.replace(/[\r\n]/g, '').slice(0, 300);
}

module.exports = {
  queryPollutionProtection,
  rejectUnsafeMongoKeys,
  requestCompression,
  requestContext,
  secureHeaders,
};
