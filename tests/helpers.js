/**
 * Shared test harness.
 *
 * Serves the real Express app on an ephemeral port so the middleware chain,
 * routing and auth guards are covered, not just the controllers.
 *
 * Database selection, in order of preference:
 *  1. TEST_MONGO_URI, if you point it somewhere yourself.
 *  2. An in-memory MongoDB replica set, when the binary is available locally.
 *  3. A dedicated *test* database on the cluster in MONGO_URI.
 *
 * Option 3 never touches application data: the database name is rewritten to
 * TEST_DB_NAME and startup aborts if the connection lands anywhere else.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_jwt_refresh_secret';
process.env.OTP_MODE = process.env.OTP_MODE || 'demo';
process.env.DEMO_OTP = process.env.DEMO_OTP || '123456';
process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';

const dns = require('node:dns');
const path = require('node:path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TEST_DB_NAME = 'samira_collection_automated_tests';

let replSet;
let server;
let baseUrl;

/**
 * Rewrites the database portion of a connection string so tests can share a
 * cluster with the application without sharing its data.
 */
function toTestUri(uri) {
  const [beforeQuery, query] = String(uri).split('?');
  const withoutTrailingSlash = beforeQuery.replace(/\/+$/, '');
  const lastSlash = withoutTrailingSlash.lastIndexOf('/');
  const schemeEnd = withoutTrailingSlash.indexOf('//') + 2;
  const base = lastSlash > schemeEnd ? withoutTrailingSlash.slice(0, lastSlash) : withoutTrailingSlash;
  return `${base}/${TEST_DB_NAME}${query ? `?${query}` : ''}`;
}

async function tryInMemoryMongo() {
  try {
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    return replSet.getUri();
  } catch {
    if (replSet) await replSet.stop().catch(() => null);
    replSet = undefined;
    return null;
  }
}

async function resolveTestUri() {
  if (process.env.TEST_MONGO_URI) return process.env.TEST_MONGO_URI;

  const inMemory = await tryInMemoryMongo();
  if (inMemory) return inMemory;

  if (!process.env.MONGO_URI) {
    throw new Error('No test database available. Set TEST_MONGO_URI or MONGO_URI.');
  }

  // Some local resolvers refuse the SRV lookup Atlas needs.
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  return toTestUri(process.env.MONGO_URI);
}

async function startTestEnvironment() {
  const uri = await resolveTestUri();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const connectedDb = mongoose.connection.name;
  const isEphemeral = Boolean(replSet) || Boolean(process.env.TEST_MONGO_URI);
  if (!isEphemeral && connectedDb !== TEST_DB_NAME) {
    await mongoose.disconnect();
    throw new Error(`Refusing to run tests against database "${connectedDb}". Expected "${TEST_DB_NAME}".`);
  }

  process.env.MONGO_URI = uri;

  const app = require('../app');
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl };
}

async function stopTestEnvironment() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await resetDatabase().catch(() => null);
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}

async function resetDatabase() {
  if (mongoose.connection.readyState !== 1) return;
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

module.exports = {
  TEST_DB_NAME,
  request,
  resetDatabase,
  startTestEnvironment,
  stopTestEnvironment,
  toTestUri,
  getBaseUrl: () => baseUrl,
};
