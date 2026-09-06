const test = require('node:test');
const assert = require('node:assert/strict');
const Product = require('../models/Product');
require('../services/auditService').logAudit = () => {};
const controller = require('../controllers/productController');
const productId = '0123456789abcdef01234567';
const storeId = '0123456789abcdef11111111';
async function invoke(handler, body, extra = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  let error;
  await handler({ params: { id: productId }, body, ...extra }, res, (value) => { error = value; });
  return { res, error };
}

test('stock updates reject blank, fractional and non-finite values before querying products', async (t) => {
  const lookup = t.mock.method(Product, 'findOne', async () => { throw new Error('Must not query'); });
  for (const stock of [undefined, null, '', ' ', true, false, [], {}, -1, 1.2, 'NaN', Infinity]) {
    const { res, error } = await invoke(controller.updateStock, { stock });
    assert.equal(error, undefined);
    assert.equal(res.statusCode, 400, String(stock));
  }
  assert.equal(lookup.mock.callCount(), 0);
});

test('valid zero and whole-number stock edits persist; database errors reach the API handler', async (t) => {
  const product = { _id: productId, stock: 4, variants: [], save: async () => {} };
  t.mock.method(Product, 'findOne', async () => product);
  for (const stock of [0, '7']) {
    const { res, error } = await invoke(controller.updateStock, { stock });
    assert.equal(error, undefined); assert.equal(res.statusCode, 200);
    assert.equal(product.stock, Number(stock));
  }
  product.save = async () => { throw new Error('Database unavailable'); };
  assert.match((await invoke(controller.updateStock, { stock: 5 })).error.message, /Database unavailable/);
});

test('marking out of stock scopes the lookup and refuses a product belonging to another store', async (t) => {
  t.mock.method(Product, 'findOne', async (filter) => {
    assert.deepEqual(filter, { $and: [{ _id: productId }, { storeId }] });
    return null;
  });
  const req = { tenantFilter: { storeId }, store: { _id: storeId } };
  assert.equal((await invoke(controller.markOutOfStock, {}, req)).res.statusCode, 404);
  t.mock.method(Product, 'findOne', async () => ({ _id: productId, storeId: '0123456789abcdef22222222' }));
  assert.equal((await invoke(controller.markOutOfStock, {}, req)).error.statusCode, 403);
});
