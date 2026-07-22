#!/usr/bin/env node
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Product = require('../models/Product');

const apply = process.argv.includes('--apply');
const MAX_GENERATED_VARIANTS = 100;

function normalizeProductVariants(product = {}) {
  const source = toPlain(product);
  const existing = Array.isArray(source.variants) ? source.variants : [];
  if (existing.length) {
    const variants = existing.map((variant, index) => normalizeExistingVariant(variant, source, index));
    return {
      variants,
      changed: JSON.stringify(comparableVariants(existing)) !== JSON.stringify(comparableVariants(variants)),
      created: false,
      requiresManualReview: false,
      warnings: [],
    };
  }

  const sizes = normalizedOptions(source.sizes, source.variantSize);
  const colors = normalizedOptions(source.colors, source.variantColor);
  const combinations = [];
  for (const size of sizes) {
    for (const color of colors) combinations.push({ size, color });
  }
  if (combinations.length > MAX_GENERATED_VARIANTS) {
    return {
      variants: [],
      changed: false,
      created: false,
      requiresManualReview: true,
      warnings: [`Refusing to generate ${combinations.length} variants automatically`],
    };
  }

  const stock = nonNegativeInteger(source.stock);
  const reservedStock = nonNegativeInteger(source.reservedStock);
  const price = nonNegativeMoney(source.price);
  const originalPrice = finiteNonNegative(source.originalPrice) ? Number(source.originalPrice) : price;
  const baseSku = clean(source.sku) || `LEGACY-${String(source._id || new mongoose.Types.ObjectId())}`;
  const variants = combinations.map(({ size, color }, index) => ({
    _id: new mongoose.Types.ObjectId(),
    sku: combinations.length === 1 ? baseSku : `${baseSku}-${variantSuffix(size, color, index)}`,
    size,
    color,
    stock: index === 0 ? stock : 0,
    reservedStock: index === 0 ? reservedStock : 0,
    price,
    originalPrice,
    images: [],
    isActive: source.isActive !== false,
  }));
  const warnings = combinations.length > 1 && (stock > 0 || reservedStock > 0)
    ? ['Legacy inventory was assigned to the first generated option; review the per-option allocation']
    : [];
  return {
    variants,
    changed: true,
    created: true,
    requiresManualReview: false,
    warnings,
  };
}

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    scanned: 0,
    changed: 0,
    variantsCreatedForLegacyProducts: 0,
    manualReviewRequired: 0,
    allocationWarnings: 0,
  };
  let operations = [];
  const cursor = Product.find({})
    .select('_id sku sizes colors variantSize variantColor variants stock reservedStock price originalPrice isActive')
    .lean()
    .cursor();

  for await (const product of cursor) {
    summary.scanned += 1;
    const result = normalizeProductVariants(product);
    if (result.requiresManualReview) {
      summary.manualReviewRequired += 1;
      console.warn(JSON.stringify({ productId: String(product._id), warnings: result.warnings }));
      continue;
    }
    if (result.warnings.length) {
      summary.allocationWarnings += 1;
      console.warn(JSON.stringify({ productId: String(product._id), warnings: result.warnings }));
    }
    if (!result.changed) continue;
    assertInventoryPreserved(product, result.variants);
    summary.changed += 1;
    if (result.created) summary.variantsCreatedForLegacyProducts += 1;
    if (apply) {
      operations.push({
        updateOne: {
          filter: { _id: product._id },
          update: { $set: { variants: result.variants } },
        },
      });
      if (operations.length >= 250) {
        await Product.bulkWrite(operations, { ordered: false });
        operations = [];
      }
    }
  }
  if (apply && operations.length) await Product.bulkWrite(operations, { ordered: false });

  console.log(JSON.stringify(summary, null, 2));
  if (summary.manualReviewRequired) {
    throw new Error('Some products require manual variant review before the migration can be considered complete');
  }
}

function normalizeExistingVariant(value, product, index) {
  const variant = toPlain(value);
  const price = finiteNonNegative(variant.price) ? Number(variant.price) : nonNegativeMoney(product.price);
  return {
    ...variant,
    _id: mongoose.Types.ObjectId.isValid(String(variant._id || ''))
      ? variant._id
      : new mongoose.Types.ObjectId(),
    sku: clean(variant.sku) || `${clean(product.sku) || `LEGACY-${String(product._id)}`}-${index + 1}`,
    size: clean(variant.size),
    color: clean(variant.color),
    stock: nonNegativeInteger(variant.stock),
    reservedStock: nonNegativeInteger(variant.reservedStock),
    price,
    originalPrice: finiteNonNegative(variant.originalPrice) ? Number(variant.originalPrice) : price,
    barcode: clean(variant.barcode),
    weight: finiteNonNegative(variant.weight) ? Number(variant.weight) : undefined,
    images: normalizeImages(variant.images),
    isActive: variant.isActive !== false,
  };
}

function assertInventoryPreserved(product, variants) {
  const hadVariants = Array.isArray(product.variants) && product.variants.length > 0;
  const before = hadVariants
    ? inventoryTotals(product.variants)
    : { stock: nonNegativeInteger(product.stock), reservedStock: nonNegativeInteger(product.reservedStock) };
  const after = inventoryTotals(variants);
  if (before.stock !== after.stock || before.reservedStock !== after.reservedStock) {
    throw new Error(`Inventory total changed while normalizing product ${String(product._id)}`);
  }
}

function inventoryTotals(variants) {
  return variants.reduce((totals, variant) => ({
    stock: totals.stock + nonNegativeInteger(variant.stock),
    reservedStock: totals.reservedStock + nonNegativeInteger(variant.reservedStock),
  }), { stock: 0, reservedStock: 0 });
}

function normalizedOptions(values, fallback) {
  const options = [...new Set([
    ...(Array.isArray(values) ? values : []),
    ...(fallback ? [fallback] : []),
  ].map(clean).filter(Boolean))];
  return options.length ? options : [''];
}

function normalizeImages(images) {
  return (Array.isArray(images) ? images : [])
    .map((image) => ({
      url: clean(typeof image === 'string' ? image : image?.url),
      publicId: clean(typeof image === 'object' ? image?.publicId : ''),
    }))
    .filter((image) => image.url);
}

function comparableVariants(variants) {
  return variants.map((variant) => {
    const value = toPlain(variant);
    return {
      ...value,
      _id: String(value._id || ''),
      images: normalizeImages(value.images),
    };
  });
}

function variantSuffix(size, color, index) {
  const suffix = [size, color].map((value) => clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, '-'))
    .filter(Boolean)
    .join('-');
  return suffix || String(index + 1);
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function nonNegativeMoney(value) {
  return finiteNonNegative(value) ? Math.round(Number(value) * 100) / 100 : 0;
}

function finiteNonNegative(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

function clean(value) {
  return String(value || '').trim();
}

function toPlain(value) {
  return value?.toObject ? value.toObject() : { ...value };
}

if (require.main === module) {
  run()
    .then(() => mongoose.disconnect())
    .catch(async (error) => {
      console.error(error.message);
      await mongoose.disconnect().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { normalizeProductVariants };
