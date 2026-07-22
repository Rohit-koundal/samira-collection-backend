#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const apply = process.argv.includes('--apply');

function loadModels() {
  const modelsDirectory = path.join(__dirname, '..', 'models');
  for (const filename of fs.readdirSync(modelsDirectory).filter((name) => name.endsWith('.js')).sort()) {
    require(path.join(modelsDirectory, filename));
  }
}

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  loadModels();
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    models: 0,
    modelsWithChanges: 0,
    indexesToCreate: 0,
    indexesToDrop: 0,
    changes: [],
    errors: [],
  };

  for (const modelName of mongoose.modelNames().sort()) {
    const model = mongoose.model(modelName);
    summary.models += 1;
    try {
      const diff = await model.diffIndexes();
      const toCreate = Array.isArray(diff?.toCreate) ? diff.toCreate : [];
      const toDrop = Array.isArray(diff?.toDrop) ? diff.toDrop : [];
      if (toCreate.length || toDrop.length) {
        summary.modelsWithChanges += 1;
        summary.indexesToCreate += toCreate.length;
        summary.indexesToDrop += toDrop.length;
        summary.changes.push({ model: modelName, toCreate, toDrop });
      }
      if (apply) await model.syncIndexes();
    } catch (error) {
      summary.errors.push({ model: modelName, message: error.message });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors.length) throw new Error('Index synchronization did not complete for every model');
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

module.exports = { loadModels };
