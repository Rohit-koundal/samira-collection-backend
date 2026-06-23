#!/usr/bin/env node
/**
 * Dry-run tests for payment storage logic.
 * Run: npm run test:payments
 */
const assert = require('assert');
const { verifyRazorpaySignature, pickOrderFields } = require('../utils/paymentUtils');

function testSignatureVerification() {
  const secret = 'test_secret_key';
  const orderId = 'order_abc123';
  const paymentId = 'pay_xyz789';
  const crypto = require('crypto');
  const validSignature = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

  assert.strictEqual(verifyRazorpaySignature({
    razorpayOrderId: orderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: validSignature,
    secret,
  }), true);

  assert.strictEqual(verifyRazorpaySignature({
    razorpayOrderId: orderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: 'invalid',
    secret,
  }), false);

  assert.strictEqual(verifyRazorpaySignature({
    razorpayOrderId: '',
    razorpayPaymentId: paymentId,
    razorpaySignature: validSignature,
    secret,
  }), false);

  console.log('✓ Razorpay signature verification');
}

function testPickOrderFields() {
  const fields = pickOrderFields({
    shippingAddress: { fullName: 'Samira User', city: 'Jaipur' },
    paymentMethod: 'UPI',
    paymentProvider: 'Razorpay',
    coupon: { code: 'SAVE10', discount: 100 },
    extraField: 'should-not-leak',
  });

  assert.deepStrictEqual(fields, {
    shippingAddress: { fullName: 'Samira User', city: 'Jaipur' },
    paymentMethod: 'UPI',
    paymentProvider: 'Razorpay',
    coupon: { code: 'SAVE10', discount: 100 },
  });
  assert.strictEqual(fields.extraField, undefined);
  console.log('✓ pickOrderFields whitelist');
}

async function testFailedPaymentPersistence() {
  require('dotenv').config();

  if (!process.env.MONGO_URI) {
    console.log('↷ Skipping DB test (MONGO_URI not set)');
    return;
  }

  const mongoose = require('mongoose');
  const Order = require('../models/Order');
  const User = require('../models/User');
  const Product = require('../models/Product');
  const paymentController = require('../controllers/paymentController');

  await mongoose.connect(process.env.MONGO_URI);

  let user = await User.findOne({ phone: '9999999901' });
  if (!user) {
    user = await User.create({
      name: 'Payment Test User',
      phone: '9999999901',
      isPhoneVerified: true,
      role: 'customer',
    });
  }

  let product = await Product.findOne({ isActive: true });
  if (!product) {
    throw new Error('No active product found in database for payment dry-run');
  }

  const req = {
    user,
    body: {
      reason: 'Payment cancelled by customer (dry-run)',
      razorpayOrderId: `order_test_${Date.now()}`,
      orderPayload: {
        orderItems: [{
          product: product._id,
          name: product.name,
          quantity: 1,
          size: product.sizes?.[0] || 'Free Size',
          color: product.colors?.[0] || 'Wine',
        }],
        shippingAddress: {
          fullName: 'Payment Test User',
          mobile: '9999999901',
          pincode: '302001',
          state: 'Rajasthan',
          city: 'Jaipur',
          houseNo: '1',
          area: 'Test Area',
        },
        paymentMethod: 'UPI',
        paymentProvider: 'Razorpay',
      },
    },
  };

  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  await paymentController.recordPaymentFailure(req, res);

  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body.success, false);
  assert.ok(res.body.order?._id);
  assert.strictEqual(res.body.order.paymentStatus, 'Failed');
  assert.strictEqual(res.body.order.orderStatus, 'Cancelled');
  assert.ok(res.body.order.paymentFailureReason);

  const saved = await Order.findById(res.body.order._id);
  assert.ok(saved);
  assert.strictEqual(saved.paymentStatus, 'Failed');

  await Order.findByIdAndDelete(saved._id);
  await mongoose.disconnect();
  console.log('✓ Failed payment persisted to orders collection');
}

async function testPendingOrderMarkedFailed() {
  require('dotenv').config();

  if (!process.env.MONGO_URI) {
    console.log('↷ Skipping pending→failed DB test (MONGO_URI not set)');
    return;
  }

  const mongoose = require('mongoose');
  const Order = require('../models/Order');
  const User = require('../models/User');
  const Product = require('../models/Product');
  const paymentController = require('../controllers/paymentController');

  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ phone: '9999999901' });
  const product = await Product.findOne({ isActive: true });
  if (!user || !product) {
    await mongoose.disconnect();
    throw new Error('Test fixtures missing (user/product)');
  }

  const razorpayOrderId = `order_pending_${Date.now()}`;
  const pending = await Order.create({
    user: user._id,
    orderItems: [{
      product: product._id,
      name: product.name,
      quantity: 1,
      price: product.price,
      originalPrice: product.originalPrice || product.price,
    }],
    shippingAddress: { fullName: 'Payment Test User', mobile: '9999999901' },
    paymentMethod: 'UPI',
    paymentProvider: 'Razorpay',
    paymentStatus: 'Pending',
    orderStatus: 'Pending',
    razorpayOrderId,
    totalMRP: product.price,
    productDiscount: 0,
    couponDiscount: 0,
    deliveryCharge: 0,
    codCharge: 0,
    finalAmount: product.price,
    statusTimeline: [{ status: 'Pending', date: new Date(), note: 'Awaiting Razorpay payment' }],
  });

  const stockBefore = product.stock;
  const req = {
    user,
    body: {
      reason: 'Payment cancelled by customer (pending dry-run)',
      razorpayOrderId,
      orderPayload: { orderItems: [{ product: product._id, quantity: 1 }] },
    },
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  await paymentController.recordPaymentFailure(req, res);

  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body.order._id.toString(), pending._id.toString());
  assert.strictEqual(res.body.order.paymentStatus, 'Failed');

  const refreshedProduct = await Product.findById(product._id);
  assert.strictEqual(refreshedProduct.stock, stockBefore, 'stock must not change on failed payment');

  await Order.findByIdAndDelete(pending._id);
  await mongoose.disconnect();
  console.log('✓ Pending order updated to Failed without stock reduction');
}

async function run() {
  testSignatureVerification();
  testPickOrderFields();
  await testFailedPaymentPersistence();
  await testPendingOrderMarkedFailed();
  console.log('\nAll payment flow tests passed.');
}

run().catch((error) => {
  console.error('\nPayment flow test failed:', error.message);
  process.exit(1);
});
