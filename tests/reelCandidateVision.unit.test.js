const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVisionSuggestion } = require('../services/quickAddVision.service');
const {
  defaultCandidateSuggestion,
  toCandidateAnalysis,
} = require('../services/reelCandidateVision.service');

test('visual suggestions map a saree to the real category and free-size behavior', () => {
  const result = normalizeVisionSuggestion({
    name: 'Teal Zari Silk Saree',
    categoryName: 'Sarees',
    colors: ['Teal', 'Magenta'],
    pattern: 'Zari woven',
    fabric: 'Silk blend',
    occasion: 'Festive',
    tags: ['silk', 'zari', 'festive'],
    shortDescription: 'A teal saree with a magenta zari border.',
    description: 'A teal silk-look saree finished with a contrasting magenta zari border.',
    confidence: { name: 0.92, category: 92, color: 0.9, pattern: 0.81, fabric: 0.58, overall: 0.82 },
  }, [{ _id: 'category-sarees', name: 'Sarees' }], 'gemini-test');

  assert.equal(result.suggestion.categoryId, 'category-sarees');
  assert.equal(result.suggestion.sizingMode, 'free-size');
  assert.deepEqual(result.suggestion.colors, ['Teal', 'Magenta']);
  assert.equal(result.confidence.category, 0.92);
  assert.equal(result.analysis.model, 'gemini-test');
});

test('candidate mapping keeps inferred catalog data but never creates price, stock, or sizes', () => {
  const result = toCandidateAnalysis({
    enabled: true,
    suggestion: {
      name: 'Wine Embroidered Kurta Set',
      categoryId: 'category-suits',
      categoryName: 'Suits',
      colors: ['Wine', 'Gold'],
      pattern: 'Embroidered',
      fabric: 'Silk blend',
      occasion: 'Wedding',
      tags: ['wine', 'embroidered'],
      shortDescription: 'A wine kurta set with gold embroidery.',
      description: 'A coordinated wine kurta set with visible gold embroidery.',
      sizingMode: 'sized',
    },
    confidence: { name: 0.9, category: 0.8, primaryColor: 0.88, overall: 0.84 },
    analysis: { source: 'gemini-vision', model: 'gemini-test', analyzedAt: '2026-09-05T00:00:00.000Z' },
  }, 2);

  assert.equal(result.analysis.status, 'completed');
  assert.equal(result.suggestions.primaryColor, 'Wine');
  assert.deepEqual(result.suggestions.secondaryColors, ['Gold']);
  assert.equal(result.suggestions.sizingMode, 'sized');
  assert.equal(Object.hasOwn(result.suggestions, 'price'), false);
  assert.equal(Object.hasOwn(result.suggestions, 'stock'), false);
  assert.equal(Object.hasOwn(result.suggestions, 'sizes'), false);
});

test('unavailable analysis returns a review-safe candidate instead of failing the reel job', () => {
  const suggestion = defaultCandidateSuggestion(4);
  assert.equal(suggestion.name, 'Product 4');
  assert.equal(suggestion.sizingMode, 'confirm');
  assert.deepEqual(suggestion.tags, ['reel-import']);
});
