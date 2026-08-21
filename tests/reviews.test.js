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
