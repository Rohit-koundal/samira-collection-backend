const developmentOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
    .filter((origin) => {
      try {
        const url = new URL(origin);
        return ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
      } catch {
        return false;
      }
    });
}

function getAllowedOrigins() {
  const configured = [
    ...parseOrigins(process.env.CLIENT_ORIGINS),
    ...parseOrigins(process.env.FRONTEND_URL),
  ];
  const defaults = process.env.NODE_ENV === 'production' ? [] : developmentOrigins;
  return [...new Set([...defaults, ...configured])];
}

function corsOptions(req, callback) {
  const origin = req.header('Origin');
  const allowed = !origin || getAllowedOrigins().includes(origin.replace(/\/$/, ''));
  if (!allowed) return callback(null, { origin: false });
  return callback(null, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'X-Request-ID',
      'Idempotency-Key',
    ],
    exposedHeaders: ['X-Request-ID', 'Retry-After'],
    maxAge: 86400,
  });
}

module.exports = { corsOptions, getAllowedOrigins };
