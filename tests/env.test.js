const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertProductionSecrets,
  getJwtRefreshSecret,
  getJwtSecret,
  isDemoOtpMode,
  missingProductionSecrets,
} = require('../config/env');

function withEnv(overrides, work) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('production refuses to start when JWT secrets or MONGO_URI are missing', () => {
  withEnv({
    NODE_ENV: 'production',
    JWT_SECRET: undefined,
    JWT_REFRESH_SECRET: undefined,
    MONGO_URI: undefined,
  }, () => {
    assert.deepEqual(missingProductionSecrets().sort(), ['JWT_REFRESH_SECRET', 'JWT_SECRET', 'MONGO_URI']);
    assert.throws(() => assertProductionSecrets(), /JWT_SECRET/);
  });
});

test('production JWT helpers refuse to fall back to a development secret', () => {
  withEnv({
    NODE_ENV: 'production',
    JWT_SECRET: undefined,
    JWT_REFRESH_SECRET: undefined,
  }, () => {
    assert.throws(() => getJwtSecret(), /JWT_SECRET is required in production/);
    assert.throws(() => getJwtRefreshSecret(), /JWT_REFRESH_SECRET is required in production/);
  });
});

test('development may fall back to a local-only JWT secret', () => {
  withEnv({
    NODE_ENV: 'development',
    JWT_SECRET: undefined,
    JWT_REFRESH_SECRET: undefined,
  }, () => {
    assert.match(getJwtSecret(), /dev_only/);
    assert.match(getJwtRefreshSecret(), /dev_only/);
  });
});

test('OTP_MODE=demo is the default and is distinct from production mode', () => {
  withEnv({ OTP_MODE: undefined }, () => {
    assert.equal(isDemoOtpMode(), true);
  });
  withEnv({ OTP_MODE: 'production' }, () => {
    assert.equal(isDemoOtpMode(), false);
  });
});
