const mongoose = require('mongoose');
const Product = require('../models/Product');
const Order = require('../models/Order');
const InventoryMovement = require('../models/InventoryMovement');
const { releaseCouponReservation } = require('./couponService');

const RESERVATION_MINUTES = Math.max(5, Math.min(60, Number(process.env.INVENTORY_RESERVATION_MINUTES || 15)));

function getReservationExpiry(now = new Date()) {
  return new Date(now.getTime() + (RESERVATION_MINUTES * 60 * 1000));
}

function buildStockOperation(item, movementType) {
  const quantity = toQuantity(item.quantity);
  const variantId = item.variantId ? String(item.variantId) : '';
  const operation = { query: { _id: item.product }, update: { $inc: {} }, options: { new: false } };

  if (variantId) {
    const variantCondition = { _id: variantId };
    if (movementType === 'RESERVATION') variantCondition.stock = { $gte: quantity };
    if (['RESERVATION_RELEASE', 'SALE_COMMIT'].includes(movementType)) {
      variantCondition.reservedStock = { $gte: quantity };
    }
    operation.query.variants = { $elemMatch: variantCondition };
    operation.options.arrayFilters = [{ 'variant._id': variantId }];
    if (movementType === 'RESERVATION') {
      operation.update.$inc['variants.$[variant].stock'] = -quantity;
      operation.update.$inc['variants.$[variant].reservedStock'] = quantity;
    } else if (movementType === 'RESERVATION_RELEASE') {
      operation.update.$inc['variants.$[variant].stock'] = quantity;
      operation.update.$inc['variants.$[variant].reservedStock'] = -quantity;
    } else if (movementType === 'SALE_COMMIT') {
      operation.update.$inc['variants.$[variant].reservedStock'] = -quantity;
    } else {
      operation.update.$inc['variants.$[variant].stock'] = quantity;
    }
  } else {
    if (movementType === 'RESERVATION') operation.query.stock = { $gte: quantity };
    if (['RESERVATION_RELEASE', 'SALE_COMMIT'].includes(movementType)) {
      operation.query.reservedStock = { $gte: quantity };
    }
    if (movementType === 'RESERVATION') {
      operation.update.$inc.stock = -quantity;
      operation.update.$inc.reservedStock = quantity;
    } else if (movementType === 'RESERVATION_RELEASE') {
      operation.update.$inc.stock = quantity;
      operation.update.$inc.reservedStock = -quantity;
    } else if (movementType === 'SALE_COMMIT') {
      operation.update.$inc.reservedStock = -quantity;
    } else {
      operation.update.$inc.stock = quantity;
    }
  }

  return operation;
}

async function applyStockMovement(item, {
  movementType,
  orderId,
  actor,
  referenceId,
  session,
  metadata,
  ProductModel = Product,
  MovementModel = InventoryMovement,
} = {}) {
  const operation = buildStockOperation(item, movementType);
  if (session) operation.options.session = session;
  const before = await ProductModel.findOneAndUpdate(operation.query, operation.update, operation.options);
  if (!before) {
    const error = new Error(movementType === 'RESERVATION'
      ? `Insufficient stock for ${item.name || 'an item'}`
      : `Inventory state is inconsistent for ${item.name || 'an item'}`);
    error.statusCode = 409;
    error.code = movementType === 'RESERVATION' ? 'INSUFFICIENT_STOCK' : 'INVENTORY_CONFLICT';
    throw error;
  }

  const quantity = toQuantity(item.quantity);
  const previous = getStockState(before, item.variantId);
  const next = calculateNextState(previous, quantity, movementType);
  const movement = {
    product: item.product,
    variantId: item.variantId || undefined,
    sku: item.sku,
    quantity,
    movementType,
    order: orderId,
    actor,
    previousStock: previous.stock,
    newStock: next.stock,
    previousReservedStock: previous.reservedStock,
    newReservedStock: next.reservedStock,
    referenceId,
    metadata,
  };
  if (session) await MovementModel.create([movement], { session });
  else await MovementModel.create(movement);
  return { before, movement };
}

async function reserveInventory(order, actor) {
  return runWithOptionalTransaction(async (session) => {
    const claimed = await claimInventoryState(order._id, 'Not Reserved', 'Reserving', session);
    if (!claimed) return inventoryIdempotentResult(order._id, ['Reserved', 'Committed'], session);

    const applied = [];
    try {
      for (const item of claimed.orderItems) {
        await applyStockMovement(item, {
          movementType: 'RESERVATION',
          orderId: claimed._id,
          actor,
          referenceId: movementReference('reserve', claimed._id, item),
          session,
        });
        applied.push(item);
      }
    } catch (error) {
      if (!session) {
        for (const item of applied.reverse()) {
          await applyStockMovement(item, {
            movementType: 'RESERVATION_RELEASE',
            orderId: claimed._id,
            actor,
            referenceId: movementReference('reserve-rollback', claimed._id, item),
            metadata: { reason: 'Reservation failed; prior line rolled back' },
          });
        }
        await updateInventoryState(claimed._id, 'Reserving', 'Released', null, {
          reservationExpiresAt: null,
        });
      }
      throw error;
    }

    const reserved = await updateInventoryState(claimed._id, 'Reserving', 'Reserved', session, {
      reservationExpiresAt: claimed.reservationExpiresAt || getReservationExpiry(),
    });
    if (!reserved) throw inventoryConflict('Reservation state changed while stock was being reserved');
    return reserved;
  });
}

async function commitInventory(order, actor) {
  return runWithOptionalTransaction(async (session) => {
    const claimed = await claimInventoryState(order._id, 'Reserved', 'Committing', session);
    if (!claimed) return inventoryIdempotentResult(order._id, ['Committed'], session);
    for (const item of claimed.orderItems) {
      await applyStockMovement(item, {
        movementType: 'SALE_COMMIT',
        orderId: claimed._id,
        actor,
        referenceId: movementReference('commit', claimed._id, item),
        session,
      });
    }
    const committed = await updateInventoryState(claimed._id, 'Committing', 'Committed', session, {
      reservationExpiresAt: null,
    });
    if (!committed) throw inventoryConflict('Reservation state changed while stock was being committed');
    return committed;
  });
}

async function releaseInventory(order, actor, reason = 'Reservation released') {
  return runWithOptionalTransaction(async (session) => {
    const claimed = await claimInventoryState(order._id, 'Reserved', 'Releasing', session);
    if (!claimed) return inventoryIdempotentResult(order._id, ['Released', 'Restored'], session);
    for (const item of claimed.orderItems) {
      await applyStockMovement(item, {
        movementType: 'RESERVATION_RELEASE',
        orderId: claimed._id,
        actor,
        referenceId: movementReference('release', claimed._id, item),
        session,
        metadata: { reason },
      });
    }
    const released = await updateInventoryState(claimed._id, 'Releasing', 'Released', session, {
      reservationExpiresAt: null,
    });
    if (!released) throw inventoryConflict('Reservation state changed while stock was being released');
    return released;
  });
}

async function restoreCommittedInventory(order, actor, reason = 'Order cancelled') {
  return runWithOptionalTransaction(async (session) => {
    const claimed = await claimInventoryState(order._id, 'Committed', 'Restoring', session);
    if (!claimed) return inventoryIdempotentResult(order._id, ['Restored'], session);
    for (const item of claimed.orderItems) {
      await applyStockMovement(item, {
        movementType: 'CANCELLATION_RESTORE',
        orderId: claimed._id,
        actor,
        referenceId: movementReference('cancel-restore', claimed._id, item),
        session,
        metadata: { reason },
      });
    }
    const restored = await updateInventoryState(claimed._id, 'Restoring', 'Restored', session);
    if (!restored) throw inventoryConflict('Inventory state changed while stock was being restored');
    return restored;
  });
}

async function restoreReturnedItem(order, orderItem, quantity, {
  actor,
  returnRequestId,
  session,
} = {}) {
  const item = { ...toPlainObject(orderItem), quantity: toQuantity(quantity) };
  const referenceId = `return:${returnRequestId}:${String(orderItem._id)}`;
  const restore = async (activeSession) => {
    let movementQuery = InventoryMovement.findOne({ referenceId });
    if (activeSession) movementQuery = movementQuery.session(activeSession);
    const existing = await movementQuery;
    if (existing) return { movement: existing, idempotent: true };
    return applyStockMovement(item, {
      movementType: 'RETURN_RESTORE',
      orderId: order._id,
      actor,
      referenceId,
      session: activeSession,
      metadata: { reason: 'Returned item received', returnRequest: returnRequestId },
    });
  };
  return session ? restore(session) : runWithOptionalTransaction(restore);
}

async function releaseExpiredReservations({ limit = 50 } = {}) {
  const expired = await Order.find({
    inventoryStatus: { $in: ['Not Reserved', 'Reserved'] },
    paymentStatus: 'Pending',
    reservationExpiresAt: { $lte: new Date() },
  }).sort({ reservationExpiresAt: 1 }).limit(Math.max(1, Math.min(200, limit)));

  let released = 0;
  for (const order of expired) {
    try {
      if (order.inventoryStatus === 'Reserved') {
        await releaseInventory(order, order.user, 'Checkout inventory reservation expired');
      }
      await releaseCouponReservation({
        orderId: order._id,
        reason: 'Checkout reservation expired',
      });
      await Order.updateOne(
        { _id: order._id, paymentStatus: 'Pending' },
        {
          $set: {
            paymentStatus: 'Failed',
            orderStatus: 'Cancelled',
            paymentFailureReason: 'Checkout window expired',
          },
          $push: {
            statusTimeline: {
              status: 'Cancelled',
              date: new Date(),
              note: 'Checkout window expired and any reservations were released',
            },
          },
        },
      );
      released += 1;
    } catch (error) {
      console.error('Reservation cleanup failed', {
        orderId: String(order._id),
        code: error.code || 'INVENTORY_CLEANUP_FAILED',
      });
    }
  }
  return released;
}

function startReservationCleanup() {
  const intervalMs = Math.max(30_000, Number(process.env.INVENTORY_CLEANUP_INTERVAL_MS || 60_000));
  const timer = setInterval(() => {
    releaseExpiredReservations().catch((error) => {
      console.error('Reservation cleanup job failed', { code: error.code || 'INVENTORY_CLEANUP_FAILED' });
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

async function runWithOptionalTransaction(work) {
  let session;
  try {
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    if (!isTransactionUnsupported(error)) throw error;
    return work(null);
  } finally {
    if (session) await session.endSession();
  }
}

function isTransactionUnsupported(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === 20
    || message.includes('transaction numbers are only allowed')
    || message.includes('replica set')
    || message.includes('does not support retryable writes');
}

async function claimInventoryState(orderId, from, to, session) {
  return Order.findOneAndUpdate(
    { _id: orderId, inventoryStatus: from },
    { $set: { inventoryStatus: to } },
    { new: true, session: session || undefined },
  );
}

async function updateInventoryState(orderId, from, to, session, extra = {}) {
  return Order.findOneAndUpdate(
    { _id: orderId, inventoryStatus: from },
    { $set: { inventoryStatus: to, ...extra } },
    { new: true, session: session || undefined },
  );
}

async function inventoryIdempotentResult(orderId, acceptedStates, session) {
  const current = await Order.findById(orderId).session(session || null);
  if (current && acceptedStates.includes(current.inventoryStatus)) return current;
  throw inventoryConflict('Inventory operation is already in progress or is not valid for this order');
}

function getStockState(product, variantId) {
  if (variantId) {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const variant = variants.find((entry) => String(entry._id) === String(variantId));
    if (!variant) throw inventoryConflict('The purchased variant no longer exists');
    return {
      stock: Number(variant.stock || 0),
      reservedStock: Number(variant.reservedStock || 0),
    };
  }
  return {
    stock: Number(product.stock || 0),
    reservedStock: Number(product.reservedStock || 0),
  };
}

function calculateNextState(previous, quantity, movementType) {
  if (movementType === 'RESERVATION') {
    return { stock: previous.stock - quantity, reservedStock: previous.reservedStock + quantity };
  }
  if (movementType === 'RESERVATION_RELEASE') {
    return { stock: previous.stock + quantity, reservedStock: previous.reservedStock - quantity };
  }
  if (movementType === 'SALE_COMMIT') {
    return { stock: previous.stock, reservedStock: previous.reservedStock - quantity };
  }
  return { stock: previous.stock + quantity, reservedStock: previous.reservedStock };
}

function movementReference(prefix, orderId, item) {
  return `${prefix}:${String(orderId)}:${String(item._id || item.product)}:${String(item.variantId || 'base')}`;
}

function toQuantity(value) {
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) {
    const error = new Error('Item quantity must be a whole number between 1 and 20');
    error.statusCode = 400;
    error.code = 'INVALID_QUANTITY';
    throw error;
  }
  return quantity;
}

function inventoryConflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'INVENTORY_CONFLICT';
  return error;
}

function toPlainObject(value) {
  return value?.toObject ? value.toObject() : value;
}

module.exports = {
  applyStockMovement,
  buildStockOperation,
  commitInventory,
  getReservationExpiry,
  releaseExpiredReservations,
  releaseInventory,
  reserveInventory,
  restoreCommittedInventory,
  restoreReturnedItem,
  startReservationCleanup,
};
