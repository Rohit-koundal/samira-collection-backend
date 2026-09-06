const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');
const Category = require('../models/Category');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const { publishPreparedDraft } = require('../controllers/productDraftController');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);
async function draftFixture(overrides = {}) {
  const category = await Category.create({ name: 'Sarees', slug: 'draft-sarees' });
  return ProductDraft.create({ name: 'Rose cotton saree', category: category._id, images: [{ url: '/uploads/test.jpg', primary: true }],
    price: 1299, sellingPrice: 1299, originalPrice: 1599, stock: 4, sizingMode: 'free-size', ...overrides });
}
const publish = (token, ids) => request('/api/admin/product-drafts/publish-selected', { method: 'POST', token, body: { ids } });

test('missing or invalid selected drafts fail before any product is published', async () => {
  const { token } = await createAdmin(), draft = await draftFixture();
  const missing = await publish(token, [String(draft._id), String(new mongoose.Types.ObjectId())]);
  assert.equal(missing.status, 404);
  assert.equal(await Product.countDocuments(), 0);
  const invalid = await publish(token, ['not-an-id']);
  assert.equal(invalid.status, 400);
  assert.equal(await Product.countDocuments(), 0);
});

test('concurrent ordinary draft publications and retry create exactly one product', async () => {
  const { token } = await createAdmin(), draft = await draftFixture();
  await Product.init();
  const responses = await Promise.all([publish(token, [String(draft._id)]), publish(token, [String(draft._id)])]);
  responses.forEach(response => assert.equal(response.status, 200, JSON.stringify(response.data)));
  const retry = await publish(token, [String(draft._id), String(draft._id)]);
  assert.equal(retry.status, 200);
  assert.equal(await Product.countDocuments({ sourceDraftId: draft._id }), 1);
  assert.equal(retry.data.data.products.length, 1);
  const saved = await ProductDraft.findById(draft._id);
  assert.equal(saved.status, 'published');
  assert.equal(String(saved.publishedProductId), String(retry.data.data.products[0]._id));
});

test('retry recovers product creation if saving draft publication state was interrupted', async () => {
  const draft = await draftFixture();
  const actualSave = draft.save.bind(draft);
  draft.save = async () => { throw new Error('Synthetic local write interruption'); };
  await assert.rejects(publishPreparedDraft(draft), /write interruption/);
  assert.equal(await Product.countDocuments({ sourceDraftId: draft._id }), 1);
  const retryDraft = await ProductDraft.findById(draft._id);
  assert.equal(retryDraft.status, 'draft');
  const result = await publishPreparedDraft(retryDraft);
  assert.equal(await Product.countDocuments({ sourceDraftId: draft._id }), 1);
  assert.equal(String((await ProductDraft.findById(draft._id)).publishedProductId), String(result._id));
  draft.save = actualSave;
});

test('draft updates preserve publication identity/provenance and published drafts link to product edits', async () => {
  const { token, user } = await createAdmin(), draft = await draftFixture({ createdBy: user._id });
  const response = await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token, body: {
    name: 'Reviewed rose saree', status: 'published', publishedProductId: String(new mongoose.Types.ObjectId()),
    sourceType: 'social-import', sourceUrl: 'https://example.test/forged', createdBy: String(new mongoose.Types.ObjectId()),
  } });
  assert.equal(response.status, 200);
  assert.equal(response.data.data.name, 'Reviewed rose saree');
  assert.equal(response.data.data.status, 'draft');
  assert.equal(response.data.data.sourceType, undefined);
  assert.equal(response.data.data.publishedProductId, undefined);
  assert.equal(String(response.data.data.createdBy), String(user._id));
  assert.equal((await publish(token, [String(draft._id)])).status, 200);
  const edit = await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token, body: { name: 'Wrong editor' } });
  assert.equal(edit.status, 409);
  assert.match(edit.data.message, /published product/);
});

test('draft edits reject fractional stock and invalid prices without changing persisted fields', async () => {
  const { token } = await createAdmin(), draft = await draftFixture();
  for (const body of [{ stock: 1.5 }, { stock: -1 }, { price: 'not-a-number' }, { sellingPrice: -50 }]) {
    assert.equal((await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token, body })).status, 400);
  }
  const saved = await ProductDraft.findById(draft._id);
  assert.equal(saved.stock, 4); assert.equal(saved.sellingPrice, 1299);
});

test('draft routes reject unauthorized edits and return errors for missing records', async () => {
  const { token } = await createAdmin(), customer = await createCustomer(), draft = await draftFixture();
  assert.equal((await request('/api/admin/product-drafts', { token: customer.token })).status, 403);
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}`, { method: 'PUT', token: customer.token, body: { name: 'Unauthorized' } })).status, 403);
  assert.equal((await request('/api/admin/product-drafts/not-an-id', { token })).status, 400);
  assert.equal((await request(`/api/admin/product-drafts/${new mongoose.Types.ObjectId()}`, { method: 'DELETE', token })).status, 404);
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}`, { method: 'DELETE', token })).status, 200);
  assert.equal(await ProductDraft.countDocuments(), 0);
});
