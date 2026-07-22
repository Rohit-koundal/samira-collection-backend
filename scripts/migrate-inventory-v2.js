#!/usr/bin/env node
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Product = require('../models/Product');
const Order = require('../models/Order');
const { restoreCommittedInventory } = require('../services/inventoryService');

const apply = process.argv.includes('--apply');
const restoreCancelled = process.argv.includes('--restore-cancelled');

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  if (restoreCancelled && !apply) {
    throw new Error('--restore-cancelled requires --apply');
  }
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  const legacyOrderFilter = { inventoryStatus: { $exists: false } };
  const committedFilter = {
    ...legacyOrderFilter,
    $or: [
      { paymentMethod: 'COD' },
      { paymentProvider: 'COD' },
      { paymentStatus: { $in: ['Paid', 'Refund Pending', 'Partially Refunded', 'Refunded'] } },
    ],
  };
  const releasedFilter = {
    ...legacyOrderFilter,
    $nor: committedFilter.$or,
  };
  const [
    productsWithoutReservedStock,
    productsWithVariants,
    legacyCommittedOrders,
    legacyReleasedOrders,
    duplicateProviderOrders,
    duplicateProviderPayments,
  ] = await Promise.all([
    Product.countDocuments({ reservedStock: { $exists: false } }),
    Product.countDocuments({ 'variants.0': { $exists: true } }),
    Order.countDocuments(committedFilter),
    Order.countDocuments(releasedFilter),
    findDuplicateValues('razorpayOrderId'),
    findDuplicateValues('razorpayPaymentId'),
  ]);

  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    productsWithoutReservedStock,
    productsWithVariants,
    legacyCommittedOrders,
    legacyReleasedOrders,
    duplicateRazorpayOrderIds: duplicateProviderOrders.length,
    duplicateRazorpayPaymentIds: duplicateProviderPayments.length,
    restoreCancelled,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (duplicateProviderOrders.length || duplicateProviderPayments.length) {
    throw new Error('Duplicate Razorpay identifiers must be reconciled before unique payment indexes are created');
  }
  if (!apply) return;

  await Product.updateMany(
    { reservedStock: { $exists: false } },
    { $set: { reservedStock: 0 } },
  );
  await Product.updateMany(
    { 'variants.0': { $exists: true } },
    [{
      $set: {
        variants: {
          $map: {
            input: '$variants',
            as: 'variant',
            in: {
              $mergeObjects: [
                '$$variant',
                { reservedStock: { $ifNull: ['$$variant.reservedStock', 0] } },
              ],
            },
          },
        },
      },
    }],
  );
  await Order.updateMany(committedFilter, {
    $set: { inventoryStatus: 'Committed', checkoutVersion: 1, currency: 'INR' },
  });
  await Order.updateMany(releasedFilter, {
    $set: { inventoryStatus: 'Released', checkoutVersion: 1, currency: 'INR' },
  });
  await Order.updateMany(
    { expectedAmount: { $exists: false }, finalAmount: { $type: 'number' } },
    [{ $set: { expectedAmount: { $round: [{ $multiply: ['$finalAmount', 100] }, 0] } } }],
  );

  let restored = 0;
  if (restoreCancelled) {
    const terminalOrders = await Order.find({
      inventoryStatus: 'Committed',
      orderStatus: { $in: ['Cancelled', 'Refunded'] },
    }).cursor();
    for await (const order of terminalOrders) {
      await restoreCommittedInventory(order, null, 'Inventory v2 migration: restore legacy terminal order');
      restored += 1;
    }
  }
  await Promise.all([Product.syncIndexes(), Order.syncIndexes()]);
  console.log(JSON.stringify({ migrated: true, restoredTerminalOrders: restored }, null, 2));
}

async function findDuplicateValues(field) {
  return Order.aggregate([
    { $match: { [field]: { $type: 'string', $ne: '' } } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 20 },
  ]);
}

run()
  .then(() => mongoose.disconnect())
  .catch(async (error) => {
    console.error(error.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
