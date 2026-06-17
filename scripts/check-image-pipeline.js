#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const assert = require('assert');
const { getStorageProvider } = require('../services/imageStorage');
const { isR2Configured } = require('../services/r2Upload');
const { generateImageVariants } = require('../services/imageProcessor');

async function run() {
  console.log('Running image pipeline checks...');

  assert.strictEqual(typeof getStorageProvider(), 'string');
  console.log(`storage provider: ${getStorageProvider()}`);
  console.log(`r2 configured: ${isR2Configured()}`);

  const validImage = path.join(__dirname, '..', 'uploads', '1781033987445-sarees-premium-style-1-under-2mb.jpg');
  const variants = await generateImageVariants(validImage);
  assert.ok(variants.thumb.length > 100);
  assert.ok(variants.card.length > variants.thumb.length);
  assert.ok(variants.full.length > variants.card.length);
  console.log('valid image variants:', variants.thumb.length, variants.card.length, variants.full.length);

  let smallImageFailed = false;
  const smallImage = path.join(__dirname, '..', 'uploads', '1781033552961-test.png');
  try {
    await generateImageVariants(smallImage);
  } catch (error) {
    smallImageFailed = true;
    assert.match(error.message, /too small|Invalid|Failed|corrupted/i);
  }
  assert.strictEqual(smallImageFailed, true, 'tiny placeholder image should be rejected');
  console.log('undersized image rejected as expected');

  const controllerSource = require('fs').readFileSync(path.join(__dirname, '..', 'controllers', 'productController.js'), 'utf8');
  assert.ok(controllerSource.includes('function prepareProductPayload'));
  assert.ok(controllerSource.includes('payload.primaryImage'));
  console.log('product save normalization helper: ok');

  console.log('\nAll image pipeline checks passed.');
}

run().catch((error) => {
  console.error('CHECK FAILED:', error.message);
  process.exit(1);
});
