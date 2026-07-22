const { enforceRateLimits } = require('../services/rateLimitService');

function rateLimit({ scope, limit, windowSeconds, identifiers = [ipIdentifier], when = () => true }) {
  return async function rateLimitRequest(req, res, next) {
    try {
      if (!when(req)) return next();
      const rules = identifiers
        .map((identifier, index) => ({
          scope: `${scope}:${index}`,
          identifier: identifier(req),
          limit,
          windowSeconds,
        }))
        .filter((rule) => rule.identifier);
      await enforceRateLimits(rules);
      return next();
    } catch (error) {
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      return next(error);
    }
  };
}

function ipIdentifier(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function userIdentifier(req) {
  return req.user?._id ? String(req.user._id) : null;
}

module.exports = { ipIdentifier, rateLimit, userIdentifier };
