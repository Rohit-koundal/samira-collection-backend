#!/usr/bin/env node
const path = require('path');
const { spawnSync } = require('child_process');

const testFile = path.join(__dirname, '..', 'tests', 'paymentInventory.test.js');
const result = spawnSync(process.execPath, ['--test', testFile], { stdio: 'inherit' });
process.exit(result.status ?? 1);
