const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  assertNoClientPricing,
  buildCheckoutSnapshotHash,
  pickOrderFields,
  validateRazorpayPayment,
  verifyRazorpaySignature,
  verifyWebhookSignature,
} = require('../utils/paymentUtils');
const {
  ORDER_TRANSITIONS,
  assertOrderTransition,
  canTransitionOrder,
} = require('../services/orderStateService');
const {
  applyStockMovement,
  buildStockOperation,
} = require('../services/inventoryService');
const {
  assertOnlyFields,
  claimWebhookEvent,
  ownedCheckoutQuery,
  processWebhookEvent,
} = require('../controllers/paymentController');
const PaymentWebhookEvent = require('../models/PaymentWebhookEvent');
const Order = require('../models/Order');
const cartController = require('../controllers/cartController');
const { validateEnvironment } = require('../config/env');
const { reconcileReturnRefund } = require('../services/paymentService');

test('Razorpay checkout and webhook signatures use the expected HMAC', () => {
  const secret = 'unit_test_secret';
  const razorpayOrderId = 'order_test';
  const razorpayPaymentId = 'pay_test';
  const razorpaySignature = crypto
    .createHmac('sha256', secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  assert.equal(verifyRazorpaySignature({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
    secret,
  }), true);
  assert.equal(verifyRazorpaySignature({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature: `${razorpaySignature.slice(0, -1)}0`,
    secret,
  }), false);

  const rawBody = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  assert.equal(verifyWebhookSignature({ rawBody, signature, secret }), true);
  assert.equal(verifyWebhookSignature({ rawBody, signature: 'invalid', secret }), false);
});

test('client prices, totals, state, and coupon values are rejected', () => {
  assert.throws(
    () => assertNoClientPricing({ orderItems: [{ product: 'abc', quantity: 1, price: 1 }] }),
    (error) => error.code === 'CLIENT_PRICING_NOT_ALLOWED',
  );
  assert.throws(
    () => assertNoClientPricing({ orderItems: [], finalAmount: 1 }),
    (error) => error.code === 'CLIENT_PRICING_NOT_ALLOWED',
  );
  assert.throws(
    () => assertNoClientPricing({ orderItems: [], coupon: { code: 'SAVE', discountAmount: 999 } }),
    (error) => error.code === 'CLIENT_COUPON_VALUE_NOT_ALLOWED',
  );
  assert.throws(
    () => assertOnlyFields({
      razorpay_order_id: 'order',
      razorpay_payment_id: 'payment',
      razorpay_signature: 'signature',
      orderPayload: { finalAmount: 1 },
    }, ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature']),
    (error) => error.code === 'UNSUPPORTED_PAYMENT_FIELDS',
  );
});

test('checkout field picker only returns a sanitized address, method, and coupon code', () => {
  const fields = pickOrderFields({
    shippingAddress: {
      fullName: '  Samira User  ',
      mobile: '9999999999',
      pincode: '302001',
      city: 'Jaipur',
      state: 'Rajasthan',
      injected: 'not persisted',
    },
    paymentMethod: 'upi',
    coupon: { code: ' save10 ' },
  });
  assert.deepEqual(fields, {
    shippingAddress: {
      fullName: 'Samira User',
      mobile: '9999999999',
      pincode: '302001',
      state: 'Rajasthan',
      city: 'Jaipur',
    },
    paymentMethod: 'UPI',
    coupon: { code: 'SAVE10' },
  });
});

test('immutable checkout hash changes when item quantity or authoritative price changes', () => {
  const checkout = {
    userId: 'user-1',
    orderItems: [{ product: 'product-1', quantity: 1, price: 100 }],
    shippingAddress: { city: 'Jaipur' },
    paymentMethod: 'UPI',
    couponCode: 'SAVE10',
  };
  const original = buildCheckoutSnapshotHash(checkout);
  assert.equal(original, buildCheckoutSnapshotHash({ ...checkout }));
  assert.notEqual(original, buildCheckoutSnapshotHash({
    ...checkout,
    orderItems: [{ ...checkout.orderItems[0], quantity: 2 }],
  }));
  assert.notEqual(original, buildCheckoutSnapshotHash({
    ...checkout,
    orderItems: [{ ...checkout.orderItems[0], price: 101 }],
  }));
});

test('provider payment must match stored order, amount, currency, and captured status', () => {
  const order = { razorpayOrderId: 'order_1', expectedAmount: 12500, currency: 'INR' };
  const valid = { id: 'pay_1', order_id: 'order_1', amount: 12500, currency: 'INR', status: 'captured' };
  assert.equal(validateRazorpayPayment(valid, order), true);
  for (const [field, value, code] of [
    ['order_id', 'order_other', 'PAYMENT_ORDER_MISMATCH'],
    ['amount', 12499, 'PAYMENT_AMOUNT_MISMATCH'],
    ['currency', 'USD', 'PAYMENT_CURRENCY_MISMATCH'],
    ['status', 'authorized', 'PAYMENT_NOT_CAPTURED'],
  ]) {
    assert.throws(
      () => validateRazorpayPayment({ ...valid, [field]: value }, order),
      (error) => error.code === code,
    );
  }
});

test('payment verification lookup is always scoped to the authenticated owner', () => {
  assert.deepEqual(ownedCheckoutQuery('customer-a', 'order-1'), {
    razorpayOrderId: 'order-1',
    user: 'customer-a',
  });
  assert.notDeepEqual(
    ownedCheckoutQuery('customer-a', 'order-1'),
    ownedCheckoutQuery('customer-b', 'order-1'),
  );
});

test('all declared order transitions pass and undeclared transitions fail', () => {
  for (const [current, allowed] of Object.entries(ORDER_TRANSITIONS)) {
    assert.equal(canTransitionOrder(current, current), true);
    assert.doesNotThrow(() => assertOrderTransition(current, current));
    for (const next of Object.keys(ORDER_TRANSITIONS)) {
      if (next === current || allowed.includes(next)) {
        assert.doesNotThrow(() => assertOrderTransition(current, next));
      } else {
        assert.throws(
          () => assertOrderTransition(current, next),
          (error) => error.code === 'INVALID_ORDER_TRANSITION',
        );
      }
    }
  }
  assert.throws(
    () => assertOrderTransition('Pending', 'Made Up'),
    (error) => error.code === 'INVALID_ORDER_STATUS',
  );
});

test('reservation updates are conditional and target the exact variant', () => {
  const base = buildStockOperation({ product: 'p1', quantity: 2 }, 'RESERVATION');
  assert.deepEqual(base.query, { _id: 'p1', stock: { $gte: 2 } });
  assert.deepEqual(base.update, { $inc: { stock: -2, reservedStock: 2 } });

  const variant = buildStockOperation({
    product: 'p1',
    variantId: 'v1',
    quantity: 2,
  }, 'RESERVATION');
  assert.deepEqual(variant.query.variants, {
    $elemMatch: { _id: 'v1', stock: { $gte: 2 } },
  });
  assert.deepEqual(variant.options.arrayFilters, [{ 'variant._id': 'v1' }]);
  assert.equal(variant.update.$inc['variants.$[variant].stock'], -2);
});

test('two concurrent reservations for the final unit allow exactly one purchase', async () => {
  let stock = 1;
  let reservedStock = 0;
  const movements = [];
  const ProductModel = {
    async findOneAndUpdate(query, update) {
      if (stock < Number(query.stock?.$gte || 0)) return null;
      const before = { stock, reservedStock };
      stock += Number(update.$inc.stock || 0);
      reservedStock += Number(update.$inc.reservedStock || 0);
      return before;
    },
  };
  const MovementModel = {
    async create(movement) {
      movements.push(movement);
      return movement;
    },
  };
  const item = { product: 'product-1', name: 'Final unit', quantity: 1 };
  const attempts = await Promise.allSettled([
    applyStockMovement(item, {
      movementType: 'RESERVATION',
      orderId: 'order-1',
      referenceId: 'reserve:order-1',
      ProductModel,
      MovementModel,
    }),
    applyStockMovement(item, {
      movementType: 'RESERVATION',
      orderId: 'order-2',
      referenceId: 'reserve:order-2',
      ProductModel,
      MovementModel,
    }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  assert.equal(attempts.find((attempt) => attempt.status === 'rejected').reason.code, 'INSUFFICIENT_STOCK');
  assert.equal(stock, 0);
  assert.equal(reservedStock, 1);
  assert.equal(movements.length, 1);
});

test('processed webhook event IDs are idempotent without calling a live provider', async (t) => {
  const originalCreate = PaymentWebhookEvent.create;
  const originalFindOne = PaymentWebhookEvent.findOne;
  t.after(() => {
    PaymentWebhookEvent.create = originalCreate;
    PaymentWebhookEvent.findOne = originalFindOne;
  });
  PaymentWebhookEvent.create = async () => {
    const duplicate = new Error('duplicate');
    duplicate.code = 11000;
    throw duplicate;
  };
  PaymentWebhookEvent.findOne = async () => ({ status: 'Processed' });
  assert.deepEqual(await claimWebhookEvent('evt-processed', 'payment.captured'), { duplicate: true });
});

test('webhook safely ignores unknown orders and does not reprocess an already paid order', async (t) => {
  const originalFindOne = Order.findOne;
  t.after(() => {
    Order.findOne = originalFindOne;
  });
  const payload = {
    payload: {
      payment: {
        entity: {
          id: 'pay_webhook',
          order_id: 'order_webhook',
          amount: 5000,
          currency: 'INR',
          status: 'captured',
        },
      },
    },
  };
  Order.findOne = async () => null;
  assert.deepEqual(await processWebhookEvent('payment.captured', payload, 'evt-unknown'), {
    ignored: true,
    providerOrderId: 'order_webhook',
  });

  Order.findOne = async () => ({
    _id: '507f191e810c19729de860ea',
    razorpayOrderId: 'order_webhook',
    razorpayPaymentId: 'pay_webhook',
    expectedAmount: 5000,
    currency: 'INR',
    paymentStatus: 'Paid',
  });
  const result = await processWebhookEvent('payment.captured', payload, 'evt-paid');
  assert.equal(result.providerPaymentId, 'pay_webhook');
  assert.equal(result.providerOrderId, 'order_webhook');
});

test('cart API rejects a client-supplied price before any database lookup', async () => {
  const req = {
    body: {
      product: '507f1f77bcf86cd799439011',
      quantity: 1,
      price: 1,
    },
    user: { _id: 'user-1' },
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  await cartController.addToCart(req, res, (error) => {
    throw error;
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'CLIENT_PRICING_NOT_ALLOWED');
});

test('production payment enablement requires keys and a strong webhook secret', () => {
  const environment = {
      NODE_ENV: 'production',
      REQUIRE_MEDIA_STORAGE: 'false',
    REQUIRE_DATABASE: 'true',
    MONGO_URI: 'mongodb://database/app',
    JWT_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    OTP_HASH_SECRET: 'c'.repeat(40),
    REDIS_REST_URL: 'https://redis.example.test',
    REDIS_REST_TOKEN: 'configured',
    SMS_PROVIDER: 'twilio',
    SMS_ACCOUNT_SID: 'configured',
    SMS_AUTH_TOKEN: 'configured',
    SMS_SENDER_ID: 'configured',
    EMAIL_OTP_PROVIDER: 'brevo',
    BREVO_API_KEY: 'configured',
    BREVO_SENDER_EMAIL: 'security@example.test',
    CLIENT_ORIGINS: 'https://shop.example.test',
    PAYMENTS_ENABLED: 'true',
  };
  assert.throws(
    () => validateEnvironment(environment),
    (error) => error.details.some((message) => message.includes('RAZORPAY_WEBHOOK_SECRET')),
  );
  assert.deepEqual(validateEnvironment({
    ...environment,
    RAZORPAY_KEY_ID: 'rzp_test_placeholder',
    RAZORPAY_KEY_SECRET: 'provider-secret',
    RAZORPAY_WEBHOOK_SECRET: 'w'.repeat(40),
  }), { valid: true, errors: [] });
});

test('processed Razorpay return refund transitions the matching return exactly once', async () => {
  let captured;
  const ReturnModel = {
    async findOneAndUpdate(query, update, options) {
      captured = { query, update, options };
      return { _id: query._id, status: 'Refunded' };
    },
  };
  const returnId = '507f1f77bcf86cd799439011';
  const order = {
    _id: '507f191e810c19729de860ea',
    refunds: [{
      idempotencyKey: `return:${returnId}:507f1f77bcf86cd799439012`,
      razorpayRefundId: 'rfnd_test',
    }],
  };
  const result = await reconcileReturnRefund(order, { id: 'rfnd_test' }, ReturnModel);
  assert.equal(result.status, 'Refunded');
  assert.deepEqual(captured.query, {
    _id: returnId,
    order: order._id,
    status: 'Received',
    'refund.status': { $in: ['Pending', 'Failed'] },
  });
  assert.equal(captured.update.$set.status, 'Refunded');
  assert.equal(captured.update.$set['refund.status'], 'Processed');
  assert.equal(captured.update.$set['refund.providerRefundId'], 'rfnd_test');
  assert.equal(captured.update.$push.auditTrail.action, 'refund_webhook_processed');
  assert.equal(captured.options.new, true);
});
