const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.REQUIRE_DATABASE = 'false';
process.env.REQUIRE_MEDIA_STORAGE = 'false';
process.env.REDIS_REST_URL = '';
process.env.REDIS_REST_TOKEN = '';

const app = require('../app');

test('async validation failures reach the safe error handler without terminating the server', async (t) => {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const invalidSupport = await fetch(`${baseUrl}/api/support/contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(invalidSupport.status, 400);
  assert.equal((await invalidSupport.json()).code, 'VALIDATION_ERROR');

  const invalidReview = await fetch(`${baseUrl}/api/reviews/not-an-object-id`);
  assert.equal(invalidReview.status, 400);
  assert.equal((await invalidReview.json()).code, 'VALIDATION_ERROR');

  const live = await fetch(`${baseUrl}/health/live`);
  assert.equal(live.status, 200);
  assert.equal((await live.json()).status, 'ok');
});
