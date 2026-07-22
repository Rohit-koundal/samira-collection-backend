const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.REDIS_REST_URL = '';
process.env.REDIS_REST_TOKEN = '';
process.env.SUPPORT_NOTIFICATION_EMAIL = '';
process.env.BREVO_API_KEY = '';
process.env.BREVO_SENDER_EMAIL = '';

const Cart = require('../models/Cart');
const Coupon = require('../models/Coupon');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ReturnExchange = require('../models/ReturnExchange');
const Review = require('../models/Review');
const SupportRequest = require('../models/SupportRequest');
const adminAuthRouter = require('../routes/adminAuthRoutes');
const bannerRouter = require('../routes/bannerRoutes');
const categoryRouter = require('../routes/categoryRoutes');
const couponRouter = require('../routes/couponRoutes');
const orderRouter = require('../routes/orderRoutes');
const returnRouter = require('../routes/returnRoutes');
const reviewRouter = require('../routes/reviewRoutes');
const settingsRouter = require('../routes/settingsRoutes');
const uploadRouter = require('../routes/uploadRoutes');
const supportRouter = require('../routes/supportRoutes');
const variantGroupRouter = require('../routes/variantGroupRoutes');
const { adminOnly, requirePermission } = require('../middleware/adminMiddleware');
const { effectivePermissions } = require('../config/adminPermissions');
const { detectType, verifyUploadSignature } = require('../services/uploadVerification');
const { resetMemoryRateLimitsForTests } = require('../services/rateLimitService');
const { paginationEnvelope, parsePagination } = require('../utils/requestValidation');
const returnController = require('../controllers/returnController');
const reviewController = require('../controllers/reviewController');
const supportController = require('../controllers/supportController');
const { normalizeAdminAccess } = require('../scripts/migrate-admin-access');
const { normalizeProductVariants } = require('../scripts/migrate-product-variants');

const USER_ID = '507f1f77bcf86cd799439011';
const PRODUCT_ID = '507f1f77bcf86cd799439012';
const ORDER_ID = '507f1f77bcf86cd799439013';
const ITEM_ID = '507f1f77bcf86cd799439014';
const RETURN_ID = '507f1f77bcf86cd799439015';

test.beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.REDIS_REST_URL = '';
  process.env.REDIS_REST_TOKEN = '';
  resetMemoryRateLimitsForTests();
});

test('upload routes reject a localhost Host header without authentication', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'routes', 'uploadRoutes.js'), 'utf8');
  assert.equal(/localhost|127\.0\.0\.1|headers?\s*\.\s*host/i.test(source), false);

  const firstRouteIndex = uploadRouter.stack.findIndex((layer) => layer.route);
  const protectIndex = uploadRouter.stack.findIndex((layer) => layer.handle.name === 'protect');
  const adminIndex = uploadRouter.stack.findIndex((layer) => layer.handle.name === 'adminOnly');
  assert.ok(protectIndex >= 0 && protectIndex < firstRouteIndex);
  assert.ok(adminIndex >= 0 && adminIndex < firstRouteIndex);

  const response = fakeResponse();
  let nextCalled = false;
  await uploadRouter.stack[protectIndex].handle({
    headers: { host: 'localhost:5000' },
  }, response, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.message, 'Not authorized');
});

test('upload administration allows active admins and owners but rejects customers', () => {
  for (const role of ['admin', 'owner']) {
    let allowed = false;
    adminOnly({ user: { role, activeMode: 'admin' } }, fakeResponse(), () => {
      allowed = true;
    });
    assert.equal(allowed, true);
  }

  const denied = fakeResponse();
  adminOnly({ user: { role: 'customer', activeMode: 'customer' } }, denied, () => {
    throw new Error('customer must not reach upload handler');
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'ADMIN_REQUIRED');
});

test('upload validation trusts file magic and rejects mismatched or executable content', async (t) => {
  assert.deepEqual(detectType(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), {
    mime: 'image/jpeg',
    extension: 'jpg',
  });
  assert.equal(detectType(Buffer.from('MZ executable content')), null);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'samira-signature-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pngPath = path.join(directory, 'payload.exe');
  const executablePath = path.join(directory, 'claimed-image.png');
  await fs.writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await fs.writeFile(executablePath, Buffer.from('MZ executable content'));

  const file = { path: pngPath, mimetype: 'application/octet-stream' };
  assert.deepEqual(await verifyUploadSignature(file, 'image'), {
    mime: 'image/png',
    extension: 'png',
  });
  assert.equal(file.detectedMime, 'image/png');
  await assert.rejects(
    () => verifyUploadSignature({ path: pngPath, mimetype: 'video/mp4' }, 'video'),
    (error) => error.code === 'INVALID_FILE_SIGNATURE' && error.statusCode === 400,
  );
  await assert.rejects(
    () => verifyUploadSignature({ path: executablePath, mimetype: 'image/png' }, 'image'),
    (error) => error.code === 'INVALID_FILE_SIGNATURE' && error.statusCode === 400,
  );
});

test('public coupons exclude private and inactive data while owners use the admin view', async () => {
  const controller = require('../controllers/couponController');
  const originalFind = Coupon.find;
  const originalAdminCoupons = controller.adminCoupons;
  let filter;
  let projection;
  Coupon.find = (value) => {
    filter = value;
    return {
      select(valueToSelect) {
        projection = valueToSelect;
        return this;
      },
      sort() {
        return this;
      },
      async lean() {
        return [{ code: 'PUBLIC10' }];
      },
    };
  };

  try {
    const response = fakeResponse();
    await controller.getCoupons({ user: undefined }, response);
    assert.equal(filter.isActive, true);
    assert.equal(filter.isPrivate, false);
    assert.ok(filter.startDate.$lte instanceof Date);
    assert.ok(filter.expiryDate.$gt instanceof Date);
    assert.match(projection, /code/);
    assert.doesNotMatch(projection, /customers|usageLimit|isPrivate|usedCount/);
    assert.deepEqual(response.body, [{ code: 'PUBLIC10' }]);

    let ownerUsedAdminView = false;
    controller.adminCoupons = async () => {
      ownerUsedAdminView = true;
    };
    await controller.getCoupons({ user: { role: 'owner' } }, fakeResponse());
    assert.equal(ownerUsedAdminView, true);
  } finally {
    Coupon.find = originalFind;
    controller.adminCoupons = originalAdminCoupons;
  }
});

test('coupon application derives item prices and subtotal from the server cart', async () => {
  const couponService = require('../services/couponService');
  const controllerPath = require.resolve('../controllers/couponController');
  const originalValidator = couponService.validateCouponForCheckout;
  const originalFindOne = Cart.findOne;
  let validated;
  couponService.validateCouponForCheckout = async (input) => {
    validated = input;
    return {
      snapshot: {
        code: 'SAVE10',
        subtotal: input.subtotal,
        discountAmount: 55,
      },
    };
  };
  delete require.cache[controllerPath];
  const controller = require(controllerPath);
  Cart.findOne = (filter) => ({
    async populate() {
      assert.deepEqual(filter, { user: USER_ID });
      return {
        items: [{
          quantity: 2,
          variantId: 'variant-server',
          product: {
            _id: PRODUCT_ID,
            category: 'category-server',
            price: 999,
            variants: [{ _id: 'variant-server', price: 275 }],
          },
        }],
      };
    },
  });

  try {
    const response = fakeResponse();
    await controller.applyCoupon({
      user: { _id: USER_ID },
      body: {
        code: 'SAVE10',
        paymentMethod: 'UPI',
        subtotal: 1,
        price: 1,
        items: [{ price: 1 }],
      },
    }, response);
    assert.equal(validated.subtotal, 550);
    assert.equal(validated.items[0].unitPrice, 275);
    assert.equal(validated.items[0].quantity, 2);
    assert.equal(response.body.subtotal, 550);
  } finally {
    Cart.findOne = originalFindOne;
    couponService.validateCouponForCheckout = originalValidator;
    delete require.cache[controllerPath];
  }
});

test('return creation scopes the order lookup to the authenticated owner', async () => {
  const originalFindOne = Order.findOne;
  let captured;
  Order.findOne = async (query) => {
    captured = query;
    return null;
  };
  try {
    const response = fakeResponse();
    await returnController.createReturn({
      user: { _id: USER_ID },
      body: { orderId: ORDER_ID, orderItemId: ITEM_ID, type: 'return' },
    }, response);
    assert.deepEqual(captured, { _id: ORDER_ID, user: USER_ID });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.message, 'Order not found');
  } finally {
    Order.findOne = originalFindOne;
  }
});

test('return creation rejects orders that have not been delivered', async () => {
  const originalFindOne = Order.findOne;
  Order.findOne = async () => ({
    _id: ORDER_ID,
    orderStatus: 'Processing',
    statusTimeline: [],
  });
  try {
    const response = fakeResponse();
    await returnController.createReturn({
      user: { _id: USER_ID },
      body: { orderId: ORDER_ID, orderItemId: ITEM_ID, type: 'return' },
    }, response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'ORDER_NOT_DELIVERED');
  } finally {
    Order.findOne = originalFindOne;
  }
});

test('refund status is gated until returned inventory is restored', async () => {
  const originalFindById = ReturnExchange.findById;
  ReturnExchange.findById = async () => ({
    _id: RETURN_ID,
    status: 'Received',
    inventoryRestoreStatus: 'Not Started',
  });
  try {
    const response = fakeResponse();
    await returnController.updateReturnStatus({
      params: { id: RETURN_ID },
      body: { status: 'Refunded' },
      user: { _id: USER_ID, role: 'owner' },
      ip: '198.51.100.20',
    }, response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'RETURN_NOT_RECEIVED');
  } finally {
    ReturnExchange.findById = originalFindById;
  }
});

test('refund status requires an explicit refund permission', async () => {
  const originalFindById = ReturnExchange.findById;
  ReturnExchange.findById = async () => ({
    _id: RETURN_ID,
    status: 'Received',
    inventoryRestoreStatus: 'Restored',
  });
  try {
    const response = fakeResponse();
    await returnController.updateReturnStatus({
      params: { id: RETURN_ID },
      body: { status: 'Refunded' },
      user: {
        _id: USER_ID,
        role: 'admin',
        adminRole: 'order_manager',
        permissions: [],
      },
      ip: '198.51.100.21',
    }, response);
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, 'PERMISSION_DENIED');
  } finally {
    ReturnExchange.findById = originalFindById;
  }
});

test('reviews require a delivered purchase owned by the reviewer', async () => {
  const originalProductFind = Product.findById;
  const originalOrderFind = Order.findOne;
  let purchaseFilter;
  Product.findById = () => ({ select: async () => ({ _id: PRODUCT_ID }) });
  Order.findOne = (filter) => {
    purchaseFilter = filter;
    return {
      sort() {
        return this;
      },
      async select() {
        return null;
      },
    };
  };
  try {
    const response = fakeResponse();
    await reviewController.createReview({
      params: { productId: PRODUCT_ID },
      body: { rating: 5 },
      user: { _id: USER_ID },
    }, response);
    assert.equal(purchaseFilter.user, USER_ID);
    assert.equal(purchaseFilter['orderItems.product'], PRODUCT_ID);
    assert.ok(purchaseFilter.$or.some((clause) => clause.orderStatus === 'Delivered'));
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, 'VERIFIED_PURCHASE_REQUIRED');
  } finally {
    Product.findById = originalProductFind;
    Order.findOne = originalOrderFind;
  }
});

test('verified review creation recalculates the visible product rating', async () => {
  const originals = {
    productFind: Product.findById,
    productUpdate: Product.updateOne,
    orderFind: Order.findOne,
    reviewFind: Review.findOne,
    reviewCreate: Review.create,
    reviewAggregate: Review.aggregate,
  };
  let created;
  let ratingPipeline;
  let productUpdate;
  Product.findById = () => ({ select: async () => ({ _id: PRODUCT_ID }) });
  Order.findOne = () => ({
    sort() {
      return this;
    },
    async select() {
      return { _id: ORDER_ID };
    },
  });
  Review.findOne = async () => null;
  Review.create = async (payload) => {
    created = payload;
    return { _id: 'review-1', ...payload };
  };
  Review.aggregate = async (pipeline) => {
    ratingPipeline = pipeline;
    return [{ rating: 4.25, count: 2 }];
  };
  Product.updateOne = async (query, update) => {
    productUpdate = { query, update };
  };

  try {
    const response = fakeResponse();
    await reviewController.createReview({
      params: { productId: PRODUCT_ID },
      body: { rating: 4, comment: '<b>Good fit</b>' },
      user: { _id: USER_ID },
    }, response);
    assert.equal(response.statusCode, 201);
    assert.equal(created.verifiedPurchase, true);
    assert.equal(created.order, ORDER_ID);
    assert.equal(created.user, USER_ID);
    assert.equal(ratingPipeline[0].$match.isVisible, true);
    assert.equal(String(ratingPipeline[0].$match.product), PRODUCT_ID);
    assert.deepEqual(productUpdate.query, { _id: PRODUCT_ID });
    assert.deepEqual(productUpdate.update.$set, { rating: 4.3, numReviews: 2 });
  } finally {
    Product.findById = originals.productFind;
    Product.updateOne = originals.productUpdate;
    Order.findOne = originals.orderFind;
    Review.findOne = originals.reviewFind;
    Review.create = originals.reviewCreate;
    Review.aggregate = originals.reviewAggregate;
  }
});

test('granular permissions combine role defaults with only valid explicit grants', () => {
  const owner = effectivePermissions({ role: 'owner' });
  assert.equal(owner.has('manage_settings'), true);
  assert.equal(owner.has('refund_payments'), true);
  assert.equal(owner.has('view_audit_logs'), true);

  const catalog = effectivePermissions({
    role: 'admin',
    adminRole: 'catalog_manager',
    permissions: ['refund_payments', 'invented_permission'],
  });
  assert.equal(catalog.has('manage_catalog'), true);
  assert.equal(catalog.has('refund_payments'), true);
  assert.equal(catalog.has('invented_permission'), false);
  assert.equal(catalog.has('manage_orders'), false);
  assert.equal(effectivePermissions({ role: 'customer' }).size, 0);
});

test('permission middleware allows a matching grant and denies unrelated admin roles', () => {
  const manageCatalog = requirePermission('manage_catalog');
  let nextCalled = false;
  manageCatalog({
    user: { role: 'admin', adminRole: 'catalog_manager', permissions: [] },
  }, fakeResponse(), () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  const denied = fakeResponse();
  manageCatalog({
    user: { role: 'admin', adminRole: 'order_manager', permissions: [] },
  }, denied, () => {
    throw new Error('unrelated admin role must not pass');
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'PERMISSION_DENIED');
});

test('every public-mount admin handler enforces its specific granular permission internally', () => {
  const cases = [
    [couponRouter, 'post', '/', 'manage_marketing'],
    [couponRouter, 'put', '/:id', 'manage_marketing'],
    [couponRouter, 'delete', '/:id', 'manage_marketing'],
    [couponRouter, 'post', '/admin/create', 'manage_marketing'],
    [couponRouter, 'put', '/admin/:id', 'manage_marketing'],
    [couponRouter, 'delete', '/admin/:id', 'manage_marketing'],
    [bannerRouter, 'get', '/:id', 'manage_marketing'],
    [bannerRouter, 'post', '/', 'manage_marketing'],
    [bannerRouter, 'put', '/:id', 'manage_marketing'],
    [bannerRouter, 'delete', '/:id', 'manage_marketing'],
    [categoryRouter, 'post', '/admin/create', 'manage_catalog'],
    [categoryRouter, 'put', '/admin/:id', 'manage_catalog'],
    [categoryRouter, 'delete', '/admin/:id', 'manage_catalog'],
    [categoryRouter, 'get', '/:id', 'manage_catalog'],
    [categoryRouter, 'post', '/', 'manage_catalog'],
    [categoryRouter, 'put', '/:id', 'manage_catalog'],
    [categoryRouter, 'delete', '/:id', 'manage_catalog'],
    [orderRouter, 'get', '/', 'manage_orders'],
    [orderRouter, 'put', '/:id/status', 'manage_orders'],
    [orderRouter, 'put', '/:id/payment-status', 'manage_orders'],
    [orderRouter, 'delete', '/:id', 'manage_orders'],
    [orderRouter, 'get', '/admin/all', 'manage_orders'],
    [orderRouter, 'get', '/admin/:id', 'manage_orders'],
    [orderRouter, 'get', '/admin/:id/receipt', 'manage_orders'],
    [orderRouter, 'put', '/admin/:id/status', 'manage_orders'],
    [orderRouter, 'put', '/admin/:id/payment-status', 'manage_orders'],
    [reviewRouter, 'get', '/', 'manage_support'],
    [reviewRouter, 'get', '/admin/all', 'manage_support'],
    [reviewRouter, 'patch', '/admin/:id/visibility', 'manage_support'],
    [reviewRouter, 'delete', '/admin/:id', 'manage_support'],
    [reviewRouter, 'patch', '/:id/visibility', 'manage_support'],
    [reviewRouter, 'delete', '/:id', 'manage_support'],
    [returnRouter, 'get', '/', 'manage_support'],
    [returnRouter, 'get', '/admin/all', 'manage_support'],
    [returnRouter, 'put', '/admin/:id/status', 'manage_support'],
    [returnRouter, 'put', '/:id/status', 'manage_support'],
    [settingsRouter, 'put', '/', 'manage_settings'],
    [settingsRouter, 'put', '/admin/update', 'manage_settings'],
    [variantGroupRouter, 'post', '/', 'manage_catalog'],
    [variantGroupRouter, 'put', '/:id', 'manage_catalog'],
    [variantGroupRouter, 'delete', '/:id', 'manage_catalog'],
    [variantGroupRouter, 'post', '/:id/add-products', 'manage_catalog'],
    [variantGroupRouter, 'post', '/:id/remove-products', 'manage_catalog'],
    [adminAuthRouter, 'get', '/dashboard/stats', 'view_financial_reports'],
    [adminAuthRouter, 'get', '/dashboard/overview', 'view_financial_reports'],
    [adminAuthRouter, 'get', '/dashboard/recent-orders', 'manage_orders'],
    [adminAuthRouter, 'get', '/dashboard/low-stock', 'manage_inventory'],
    [adminAuthRouter, 'get', '/inventory/low-stock', 'manage_inventory'],
    [adminAuthRouter, 'get', '/customers', 'manage_customers'],
    [adminAuthRouter, 'patch', '/customers/:id/block', 'manage_customers'],
  ];

  for (const [router, method, routePath, permission] of cases) {
    const label = `${method.toUpperCase()} ${routePath}`;
    const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
    assert.ok(layer, `${label} route is registered`);
    const names = layer.route.stack.map((entry) => entry.handle.name);
    const protectIndex = names.indexOf('protect');
    const adminIndex = names.indexOf('adminOnly');
    const permissionIndex = names.indexOf('permissionRequired');
    assert.ok(protectIndex >= 0 && protectIndex < adminIndex, `${label} authenticates before admin authorization`);
    assert.ok(adminIndex < permissionIndex, `${label} applies granular authorization after admin authorization`);

    let allowed = false;
    layer.route.stack[permissionIndex].handle({
      user: { role: 'admin', adminRole: 'unassigned', permissions: [permission] },
    }, fakeResponse(), () => {
      allowed = true;
    });
    assert.equal(allowed, true, `${label} accepts ${permission}`);

    const denied = fakeResponse();
    layer.route.stack[permissionIndex].handle({
      user: { role: 'admin', adminRole: 'unassigned', permissions: [] },
    }, denied, () => {
      throw new Error(`${label} passed without ${permission}`);
    });
    assert.equal(denied.body.code, 'PERMISSION_DENIED', `${label} rejects missing ${permission}`);
  }
});

test('pagination returns bounded values and a stable response envelope', () => {
  const parsed = parsePagination(
    { page: '3', limit: '25', sort: '-rating' },
    { defaultLimit: 10, maxLimit: 50, allowedSorts: ['createdAt', 'rating'] },
  );
  assert.deepEqual(parsed, {
    page: 3,
    limit: 25,
    skip: 50,
    sort: { rating: -1 },
  });
  assert.deepEqual(paginationEnvelope(['item'], 51, 3, 25), {
    items: ['item'],
    pagination: { page: 3, limit: 25, total: 51, pages: 3 },
  });
});

test('pagination rejects invalid pages, oversized limits, and unapproved sort fields', () => {
  for (const query of [
    { page: '0' },
    { page: 'not-a-number' },
    { limit: '101' },
    { sort: '-password' },
  ]) {
    assert.throws(
      () => parsePagination(query, { maxLimit: 100, allowedSorts: ['createdAt'] }),
      (error) => error.statusCode === 400 && error.code === 'VALIDATION_ERROR',
    );
  }
});

test('support intake validates contact data, honors the honeypot, and deduplicates', async () => {
  const originalFindOne = SupportRequest.findOne;
  const originalCreate = SupportRequest.create;
  let lookupCount = 0;
  SupportRequest.findOne = async () => {
    lookupCount += 1;
    return { _id: 'ticket-existing' };
  };
  SupportRequest.create = async () => {
    throw new Error('deduplicated or honeypot requests must not create a ticket');
  };
  try {
    const honeypot = fakeResponse();
    await supportController.createSupportRequest({
      body: { website: 'bot-filled-field' },
    }, honeypot);
    assert.equal(honeypot.statusCode, 202);
    assert.equal(lookupCount, 0);

    const missingContact = fakeResponse();
    await supportController.createSupportRequest({
      body: {
        name: 'Customer Name',
        message: 'This message is long enough.',
      },
    }, missingContact);
    assert.equal(missingContact.statusCode, 400);
    assert.equal(lookupCount, 0);

    await assert.rejects(
      () => supportController.createSupportRequest({
        body: {
          name: 'Customer Name',
          email: 'invalid-email',
          message: 'This message is long enough.',
        },
      }, fakeResponse()),
      (error) => error.statusCode === 400 && /valid email/i.test(error.message),
    );

    const duplicate = fakeResponse();
    await supportController.createSupportRequest({
      body: {
        name: 'Customer Name',
        email: ' Customer@Example.Test ',
        subject: 'Order support',
        message: 'Please help with this delivered order.',
      },
      ip: '198.51.100.50',
      id: 'request-1',
    }, duplicate);
    assert.equal(lookupCount, 1);
    assert.equal(duplicate.statusCode, 202);
    assert.equal(duplicate.body.ticketId, 'ticket-existing');
  } finally {
    SupportRequest.findOne = originalFindOne;
    SupportRequest.create = originalCreate;
  }
});

test('support contact rate limit permits five requests and blocks the sixth', async () => {
  const route = supportRouter.stack.find((layer) => layer.route?.path === '/contact');
  const limiter = route.route.stack.find((layer) => layer.handle.name === 'rateLimitRequest')?.handle;
  assert.equal(typeof limiter, 'function');

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = fakeResponse();
    let nextError;
    await limiter({
      ip: '198.51.100.60',
      socket: { remoteAddress: '198.51.100.60' },
    }, response, (error) => {
      nextError = error;
    });
    if (attempt <= 5) {
      assert.equal(nextError, undefined);
    } else {
      assert.equal(nextError.statusCode, 429);
      assert.equal(nextError.code, 'RATE_LIMIT_EXCEEDED');
      assert.ok(Number(response.headers['Retry-After']) >= 1);
    }
  }
});

test('migration normalizers backfill safe admin access and preserve legacy inventory totals', () => {
  assert.deepEqual(normalizeAdminAccess({
    role: 'admin',
    adminRole: 'superuser',
    permissions: ['refund_payments', 'not_real', 'refund_payments'],
    availableModes: ['admin'],
    activeMode: 'invalid',
  }), {
    role: 'admin',
    adminRole: 'order_manager',
    permissions: ['refund_payments'],
    availableModes: ['customer', 'admin'],
    activeMode: 'admin',
  });
  assert.deepEqual(normalizeAdminAccess({
    role: 'customer',
    adminRole: 'catalog_manager',
    permissions: ['manage_catalog'],
    activeMode: 'admin',
  }), {
    role: 'customer',
    adminRole: undefined,
    permissions: [],
    availableModes: ['customer'],
    activeMode: 'customer',
  });

  const result = normalizeProductVariants({
    _id: PRODUCT_ID,
    sku: 'LEGACY-SKU',
    sizes: ['S', 'M'],
    colors: ['Red', 'Blue'],
    stock: 7,
    reservedStock: 2,
    price: 499,
    originalPrice: 699,
    variants: [],
    isActive: true,
  });
  assert.equal(result.created, true);
  assert.equal(result.changed, true);
  assert.equal(result.variants.length, 4);
  assert.equal(result.variants.reduce((sum, variant) => sum + variant.stock, 0), 7);
  assert.equal(result.variants.reduce((sum, variant) => sum + variant.reservedStock, 0), 2);
  assert.equal(result.variants[0].stock, 7);
  assert.ok(result.variants.slice(1).every((variant) => variant.stock === 0));
  assert.equal(result.warnings.length, 1);
});

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
  };
}
