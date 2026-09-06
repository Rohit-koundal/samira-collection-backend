const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getJwtRefreshSecret, getJwtSecret } = require('../config/env');
const { protect } = require('../middleware/authMiddleware');
const { refresh } = require('../controllers/authController');
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const token = (refreshToken = false, extra = {}) => jwt.sign({ id: '0123456789abcdef01234567', ...(refreshToken ? { tokenType: 'refresh' } : {}), ...extra }, refreshToken ? getJwtRefreshSecret() : getJwtSecret());

test('temporary database failure keeps valid access and refresh credentials recoverable', async (t) => {
  t.mock.method(User, 'findById', () => ({ select: async () => { throw new Error('Database unavailable'); } }));
  const access = response();
  await protect({ headers: { authorization: `Bearer ${token()}` } }, access, () => assert.fail('Must not authorize'));
  assert.equal(access.statusCode, 503);
  const renewed = response();
  await refresh({ body: { refreshToken: token(true) } }, renewed);
  assert.equal(renewed.statusCode, 503);
  assert.equal(renewed.body.code, 'SERVICE_UNAVAILABLE');
  assert.equal(JSON.stringify(renewed.body).includes('Database unavailable'), false);
});

test('invalid and expired credentials remain unauthorized, while missing accounts cannot refresh', async (t) => {
  t.mock.method(User, 'findById', () => ({ select: async () => null }));
  for (const value of ['bad-token', token(true, { exp: 1 }), token(true)]) {
    const res = response(); await refresh({ body: { refreshToken: value } }, res);
    assert.equal(res.statusCode, 401);
  }
  const res = response();
  await protect({ headers: { authorization: `Bearer ${token(true)}` } }, res, () => assert.fail('Must not authorize'));
  assert.equal(res.statusCode, 401);
});
