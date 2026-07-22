const crypto = require('crypto');

const memoryWindows = new Map();

function keyFor(scope, identifier) {
  const digest = crypto.createHash('sha256').update(String(identifier || 'unknown')).digest('hex');
  return `samira:rate:${scope}:${digest}`;
}

async function consumeRateLimit({ scope, identifier, limit, windowSeconds }) {
  const key = keyFor(scope, identifier);
  if (shouldUseRedis()) {
    return consumeRedisWindow(key, Number(limit), Number(windowSeconds));
  }
  if (process.env.NODE_ENV === 'production') {
    const error = new Error('Rate limiting service is unavailable');
    error.statusCode = 503;
    error.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
    throw error;
  }
  return consumeMemoryWindow(key, Number(limit), Number(windowSeconds));
}

async function enforceRateLimits(rules) {
  let longestRetry = 0;
  for (const rule of rules) {
    if (!rule.identifier) continue;
    const result = await consumeRateLimit(rule);
    if (!result.allowed) longestRetry = Math.max(longestRetry, result.retryAfter);
  }
  if (longestRetry > 0) {
    const error = new Error('Too many requests. Please try again later.');
    error.statusCode = 429;
    error.retryAfter = longestRetry;
    error.code = 'RATE_LIMIT_EXCEEDED';
    throw error;
  }
}

function shouldUseRedis() {
  return Boolean(process.env.REDIS_REST_URL && process.env.REDIS_REST_TOKEN);
}

async function getRateLimitStoreState() {
  if (!shouldUseRedis()) return { configured: false, available: false };
  try {
    const result = await redisCommand(['PING']);
    return { configured: true, available: String(result).toUpperCase() === 'PONG' };
  } catch {
    return { configured: true, available: false };
  }
}

async function consumeRedisWindow(key, limit, windowSeconds) {
  const script = [
    "local current = redis.call('INCR', KEYS[1])",
    "if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "local ttl = redis.call('TTL', KEYS[1])",
    'return {current, ttl}',
  ].join('; ');
  const result = await redisCommand(['EVAL', script, '1', key, String(windowSeconds)]);
  const count = Number(result?.[0]);
  const ttl = Number(result?.[1]);
  if (!Number.isFinite(count) || !Number.isFinite(ttl)) throw storeUnavailable();
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfter: count <= limit ? 0 : Math.max(1, ttl > 0 ? ttl : windowSeconds),
  };
}

async function redisCommand(command) {
  const baseUrl = String(process.env.REDIS_REST_URL || '').replace(/\/+$/, '');
  const token = String(process.env.REDIS_REST_TOKEN || '');
  if (!baseUrl || !token) throw storeUnavailable();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.REDIS_TIMEOUT_MS || 2500));
  try {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    if (!response.ok) throw storeUnavailable();
    const body = await response.json();
    if (body?.error || body?.result === undefined) throw storeUnavailable();
    return body.result;
  } catch {
    throw storeUnavailable();
  } finally {
    clearTimeout(timeout);
  }
}

function consumeMemoryWindow(key, limit, windowSeconds) {
  const now = Date.now();
  const existing = memoryWindows.get(key);
  const resetAt = existing?.resetAt > now ? existing.resetAt : now + windowSeconds * 1000;
  const count = existing?.resetAt > now ? existing.count + 1 : 1;
  memoryWindows.set(key, { count, resetAt });
  pruneMemoryWindows(now);
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfter: count <= limit ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
  };
}

function pruneMemoryWindows(now) {
  if (memoryWindows.size < 1000) return;
  for (const [key, value] of memoryWindows.entries()) {
    if (value.resetAt <= now) memoryWindows.delete(key);
  }
}

function storeUnavailable() {
  const error = new Error('Rate limiting service is unavailable');
  error.statusCode = 503;
  error.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
  return error;
}

function resetMemoryRateLimitsForTests() {
  if (process.env.NODE_ENV === 'test') memoryWindows.clear();
}

module.exports = {
  consumeRateLimit,
  enforceRateLimits,
  getRateLimitStoreState,
  keyFor,
  resetMemoryRateLimitsForTests,
};
