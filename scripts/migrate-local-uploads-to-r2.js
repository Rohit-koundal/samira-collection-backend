#!/usr/bin/env node
/**
 * One-time migration: upload local files from backend/uploads/ to Cloudflare R2.
 *
 * Usage:
 *   1. Configure R2_* variables in samira-collection-backend/.env
 *   2. node scripts/migrate-local-uploads-to-r2.js
 *   3. node scripts/migrate-local-uploads-to-r2.js --update-db
 */
const path = require('path');
const fs = require('fs/promises');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config();

const { isR2Configured, uploadLocalFileToR2 } = require('../services/r2Upload');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Banner = require('../models/Banner');
const connectDB = require('../config/db');

const uploadsDir = path.join(__dirname, '..', 'uploads');
const shouldUpdateDb = process.argv.includes('--update-db');
const imageExtensions = /\.(jpe?g|png|webp)$/i;

function extractFilename(value = '') {
  const match = String(value).match(/\/uploads\/([^/?#]+)/i);
  return match ? match[1] : '';
}

function buildReplacementMap(uploadedFiles) {
  const map = new Map();
  uploadedFiles.forEach((item) => {
    map.set(item.sourceFilename, item);
  });
  return map;
}

function replaceImageObject(image, map) {
  if (!image?.url) return image;
  const filename = extractFilename(image.url) || image.publicId;
  const replacement = map.get(filename);
  if (!replacement) return image;
  return {
    url: replacement.url,
    publicId: replacement.publicId,
    variants: replacement.variants,
  };
}

async function migrateUploadsFolder() {
  if (!isR2Configured()) {
    throw new Error('R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, and R2_PUBLIC_URL in .env');
  }

  const entries = await fs.readdir(uploadsDir);
  const files = entries.filter((name) => imageExtensions.test(name));
  const uploadedFiles = [];

  for (const filename of files) {
    const filePath = path.join(uploadsDir, filename);
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 128) {
      console.log(`Skipping ${filename} (missing or too small to be a valid image).`);
      continue;
    }

    try {
      console.log(`Uploading ${filename}...`);
      const uploaded = await uploadLocalFileToR2(filePath, filename);
      uploadedFiles.push({ sourceFilename: filename, ...uploaded });
      console.log(`  -> ${uploaded.url}`);
    } catch (error) {
      console.log(`  skipped ${filename}: ${error.message}`);
    }
  }

  return uploadedFiles;
}

async function updateDatabase(uploadedFiles) {
  const map = buildReplacementMap(uploadedFiles);
  let productsUpdated = 0;
  let categoriesUpdated = 0;
  let bannersUpdated = 0;

  const products = await Product.find({});
  for (const product of products) {
    let changed = false;
    product.images = (product.images || []).map((image) => {
      const next = replaceImageObject(image, map);
      if (next.url !== image.url) changed = true;
      return next;
    });
    if (changed) {
      await product.save();
      productsUpdated += 1;
    }
  }

  const categories = await Category.find({});
  for (const category of categories) {
    const filename = extractFilename(category.image);
    const replacement = map.get(filename);
    if (replacement) {
      category.image = replacement.url;
      await category.save();
      categoriesUpdated += 1;
    }
  }

  const banners = await Banner.find({});
  for (const banner of banners) {
    const filename = extractFilename(banner.image);
    const replacement = map.get(filename);
    if (replacement) {
      banner.image = replacement.url;
      await banner.save();
      bannersUpdated += 1;
    }
  }

  return { productsUpdated, categoriesUpdated, bannersUpdated };
}

async function main() {
  await connectDB();
  const uploadedFiles = await migrateUploadsFolder();
  console.log(`\nUploaded ${uploadedFiles.length} file(s) to R2.`);

  if (shouldUpdateDb) {
    const summary = await updateDatabase(uploadedFiles);
    console.log('Database update complete:');
    console.log(`  Products updated: ${summary.productsUpdated}`);
    console.log(`  Categories updated: ${summary.categoriesUpdated}`);
    console.log(`  Banners updated: ${summary.bannersUpdated}`);
  } else {
    console.log('\nDatabase was not changed. Re-run with --update-db to replace /uploads/ URLs in MongoDB.');
  }

  await mongoose.connection.close();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.connection.close().catch(() => null);
  process.exit(1);
});
