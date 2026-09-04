const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Product = require('../models/Product');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings();
});

async function deliverProduct(token, product) {
  const placed = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });
  const { token: adminToken } = await createAdmin();
  await request(`/api/admin/orders/${placed.data._id}/status`, {
    method: 'PUT',
    token: adminToken,
    body: { orderStatus: 'Delivered' },
  });
  return placed.data._id;
}

test('a review requires a delivered purchase', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const eligibility = await request(`/api/reviews/${product._id}/eligibility`, { token });
  assert.equal(eligibility.status, 200);
  assert.equal(eligibility.data.canReview, false);
  assert.equal(eligibility.data.canEdit, false);
  assert.equal(eligibility.data.hasDeliveredPurchase, false);
  assert.equal(eligibility.data.reason, 'DELIVERY_REQUIRED');

  const { status, data } = await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token,
    body: { rating: 5, comment: 'Lovely fabric' },
  });

  assert.equal(status, 403);
  assert.match(String(data.message), /received this product/i);
});

test('a delivered purchase can submit one review and updates the product rating', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  await deliverProduct(token, product);

  const created = await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token,
    body: { rating: 4, comment: 'Nice drape', title: 'Good buy' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.verifiedPurchase, true);

  const featured = await request('/api/reviews/featured?limit=3');
  assert.equal(featured.status, 200);
  assert.equal(featured.data.length, 1);
  assert.equal(featured.data[0].comment, 'Nice drape');
  assert.equal(featured.data[0].product.name, product.name);
  assert.ok(featured.data[0].user.name);

  const duplicate = await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token,
    body: { rating: 5, comment: 'Again' },
  });
  assert.equal(duplicate.status, 409);

  const refreshed = await Product.findById(product._id);
  assert.equal(refreshed.numReviews, 1);
  assert.equal(refreshed.rating, 4);
});

test('an eligible customer can load and edit their existing review', async () => {
  const { token } = await createCustomer();
  const outsider = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const orderId = await deliverProduct(token, product);

  const before = await request(`/api/reviews/${product._id}/eligibility`, { token });
  assert.equal(before.status, 200);
  assert.equal(before.data.canReview, true);
  assert.equal(before.data.canEdit, false);
  assert.equal(String(before.data.orderId), String(orderId));

  const created = await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token,
    body: { rating: 2, title: 'Not as expected', comment: 'The fit could be better.' },
  });
  assert.equal(created.status, 201);

  const after = await request(`/api/reviews/${product._id}/eligibility`, { token });
  assert.equal(after.status, 200);
  assert.equal(after.data.canEdit, true);
  assert.equal(after.data.existingReview.title, 'Not as expected');

  const forbiddenEdit = await request(`/api/reviews/${created.data._id}`, {
    method: 'PUT',
    token: outsider.token,
    body: { rating: 1 },
  });
  assert.equal(forbiddenEdit.status, 403);

  const invalidEdit = await request(`/api/reviews/${created.data._id}`, {
    method: 'PUT',
    token,
    body: { rating: 6 },
  });
  assert.equal(invalidEdit.status, 400);

  const updated = await request(`/api/reviews/${created.data._id}`, {
    method: 'PUT',
    token,
    body: { rating: 5, title: 'Much better', comment: 'Updating after trying the right size.' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.rating, 5);
  assert.equal(updated.data.title, 'Much better');

  const refreshed = await Product.findById(product._id);
  assert.equal(refreshed.numReviews, 1);
  assert.equal(refreshed.rating, 5);
});

test('public summaries and product ratings exclude reviews hidden by an admin', async () => {
  const first = await createCustomer();
  const second = await createCustomer();
  const product = await createProduct({ stock: 5 });
  await deliverProduct(first.token, product);
  await deliverProduct(second.token, product);

  const firstReview = await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token: first.token,
    body: { rating: 5, comment: 'Excellent quality.' },
  });
  await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token: second.token,
    body: { rating: 3, comment: 'Average fit.' },
  });

  const summary = await request(`/api/reviews/${product._id}/summary`);
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.data.distribution, { 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 });
  assert.equal(summary.data.total, 2);
  assert.equal(summary.data.average, 4);
  assert.equal(summary.data.recommendationPercentage, 50);

  const { token: adminToken } = await createAdmin();
  const hidden = await request(`/api/admin/reviews/${firstReview.data._id}/visibility`, {
    method: 'PATCH',
    token: adminToken,
    body: { isVisible: false },
  });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.data.isVisible, false);

  const publicReviews = await request(`/api/reviews/${product._id}`);
  assert.equal(publicReviews.status, 200);
  assert.equal(publicReviews.data.length, 1);
  assert.equal(publicReviews.data[0].rating, 3);

  const updatedSummary = await request(`/api/reviews/${product._id}/summary`);
  assert.equal(updatedSummary.data.total, 1);
  assert.equal(updatedSummary.data.average, 3);

  const refreshed = await Product.findById(product._id);
  assert.equal(refreshed.numReviews, 1);
  assert.equal(refreshed.rating, 3);
});

test('customers can mark another visible review helpful and toggle it off', async () => {
  const reviewer = await createCustomer();
  const shopper = await createCustomer();
  const product = await createProduct({ stock: 5 });
  await deliverProduct(reviewer.token, product);

  const created = await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token: reviewer.token,
    body: { rating: 5, comment: 'The fabric and finish are excellent.' },
  });

  const marked = await request(`/api/reviews/${created.data._id}/helpful`, {
    method: 'POST',
    token: shopper.token,
  });
  assert.equal(marked.status, 200);
  assert.equal(marked.data.helpful, true);
  assert.equal(marked.data.helpfulCount, 1);

  const eligibility = await request(`/api/reviews/${product._id}/eligibility`, { token: shopper.token });
  assert.deepEqual(eligibility.data.helpfulReviewIds, [String(created.data._id)]);

  const ownVote = await request(`/api/reviews/${created.data._id}/helpful`, {
    method: 'POST',
    token: reviewer.token,
  });
  assert.equal(ownVote.status, 403);

  const unmarked = await request(`/api/reviews/${created.data._id}/helpful`, {
    method: 'POST',
    token: shopper.token,
  });
  assert.equal(unmarked.status, 200);
  assert.equal(unmarked.data.helpful, false);
  assert.equal(unmarked.data.helpfulCount, 0);
});
