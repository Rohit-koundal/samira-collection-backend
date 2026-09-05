const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProductSizing, validateProductSizing } = require('../services/productSizingService');

test('saree sizing is removed at the API boundary', () => {
  const normalized = normalizeProductSizing({
    name: 'Silk Saree',
    sizingMode: 'auto',
    sizes: ['S', 'M', 'XL'],
    variants: [{ size: 'S', color: 'Pink', stock: 2 }],
    sizeChart: { unit: 'in', rows: [{ size: 'S', bust: 36 }] },
  }, 'Sarees');

  assert.deepEqual(normalized.sizes, []);
  assert.deepEqual(normalized.variants, []);
  assert.deepEqual(normalized.sizeChart.rows, []);
  assert.equal(validateProductSizing(normalized, 'Sarees'), '');
});

test('a sized dress requires all category measurements', () => {
  const payload = {
    name: 'Pink Dress',
    sizingMode: 'sized',
    sizes: ['S'],
    sizeChart: { unit: 'in', rows: [{ size: 'S', bust: 36 }] },
  };

  assert.match(validateProductSizing(payload, 'Dresses'), /missing across shoulder/i);
});

test('complete dress measurements are normalized and accepted', () => {
  const payload = normalizeProductSizing({
    name: 'Pink Dress',
    sizingMode: 'sized',
    sizes: ['S'],
    sizeChart: {
      unit: 'in',
      rows: [{ size: 'S', acrossShoulder: 14, sleeveLength: 18, bust: 36, waist: 30, frontLength: 51, hips: 38 }],
    },
  }, 'Dresses');

  assert.equal(validateProductSizing(payload, 'Dresses'), '');
  assert.deepEqual(payload.sizeChart.columns, ['acrossShoulder', 'sleeveLength', 'bust', 'waist', 'frontLength', 'hips']);
});
