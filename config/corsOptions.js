const defaultOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://samira-collection.onrender.com',
];

function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getAllowedOrigins() {
  return [...new Set([...defaultOrigins, ...parseOrigins(process.env.CLIENT_ORIGINS), process.env.FRONTEND_URL].filter(Boolean))];
}

function isAllowedRenderOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.hostname.endsWith('.onrender.com');
  } catch (error) {
    return false;
  }
}

function corsOptions(req, callback) {
  const origin = req.header('Origin');
  const allowedOrigins = getAllowedOrigins();

  if (!origin || allowedOrigins.includes(origin) || isAllowedRenderOrigin(origin)) {
    return callback(null, {
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86400,
    });
  }

  return callback(null, { origin: false });
}

module.exports = { corsOptions, getAllowedOrigins };
