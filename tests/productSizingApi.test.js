const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin } = require('./factories');
const Category = require('../models/Category');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('product API removes legacy size choices from sarees', async () => {
  const { token } = await createAdmin();
  const category = await Category.create({ name: 'Sarees', slug: 'sarees' });
  const response = await request('/api/admin/products', {
    method: 'POST',
    token,
    body: {
      name: 'Royal Silk Saree',
      sku: 'SAREE-SIZE-1',
      category: category._id,
      price: 1299,
      originalPrice: 2499,
      stock: 4,
      images: [{ url: '/uploads/test.jpg', primary: true }],
      sizingMode: 'auto',
      sizeChartProfile: 'auto',
      sizes: ['S', 'M', 'XL'],
      variants: [{ size: 'S', color: 'Pink', stock: 4 }],
      sizeChart: { unit: 'in', rows: [{ size: 'S', bust: 36 }] },
    },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(response.data.sizes, []);
  assert.deepEqual(response.data.variants, []);
  assert.deepEqual(response.data.sizeChart.rows, []);
});

test('product API rejects incomplete dress measurements and accepts a complete chart', async () => {
  const { token } = await createAdmin();
  const category = await Category.create({ name: 'Dresses', slug: 'dresses' });
  const base = {
    name: 'Rose Maxi Dress',
    sku: 'DRESS-SIZE-1',
    category: category._id,
    price: 1499,
    originalPrice: 2499,
    stock: 4,
    images: [{ url: '/uploads/test.jpg', primary: true }],
    sizingMode: 'sized',
    sizeChartProfile: 'auto',
    sizes: ['S'],
  };
  const incomplete = await request('/api/admin/products', {
    method: 'POST',
    token,
    body: { ...base, sizeChart: { unit: 'in', rows: [{ size: 'S', bust: 36 }] } },
  });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.data.message, /complete the size chart/i);

  const complete = await request('/api/admin/products', {
    method: 'POST',
    token,
    body: {
      ...base,
      sizeChart: {
        unit: 'in',
        rows: [{ size: 'S', acrossShoulder: 14, sleeveLength: 18, bust: 36, waist: 30, frontLength: 51, hips: 38 }],
      },
    },
  });
  assert.equal(complete.status, 201);
  assert.equal(complete.data.sizeChart.rows[0].frontLength, 51);
});
