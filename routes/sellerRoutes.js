const router = require('express').Router();
const product = require('../controllers/productController');
const order = require('../controllers/orderController');
const coupon = require('../controllers/couponController');
const banner = require('../controllers/bannerController');
const category = require('../controllers/categoryController');
const review = require('../controllers/reviewController');
const returns = require('../controllers/returnController');
const dashboard = require('../controllers/dashboardController');
const contact = require('../controllers/contactController');
const newsletter = require('../controllers/newsletterController');
const crm = require('../controllers/crmController');
const inbox = require('../controllers/inboxController');
const audit = require('../controllers/auditController');
const analytics = require('../controllers/analyticsController');
const instagram = require('../controllers/instagramController');
const { getShippingProvider } = require('../services/shippingProvider');
const { requireStorePermission, stripClientStoreId } = require('../middleware/storeMiddleware');

router.get('/products', requireStorePermission('catalog.read'), product.getProducts);
router.get('/products/quick-analyze/status', requireStorePermission('catalog.read'), product.getQuickAddVisionStatus);
router.post('/products/quick-analyze', requireStorePermission('catalog.write'), product.analyzeQuickAdd);
router.get('/products/:id', requireStorePermission('catalog.read'), product.getProductById);
router.post('/products', requireStorePermission('catalog.write'), stripClientStoreId, product.createProduct);
router.put('/products/:id', requireStorePermission('catalog.write'), stripClientStoreId, product.updateProduct);
router.delete('/products/:id', requireStorePermission('catalog.write'), product.deleteProduct);
router.patch('/products/:id/status', requireStorePermission('catalog.write'), product.updateStatus);
router.patch('/products/:id/stock', requireStorePermission('inventory.write'), product.updateStock);

router.get('/orders', requireStorePermission('orders.read'), order.adminOrders);
router.get('/orders/:id', requireStorePermission('orders.read'), order.getOrder);
router.put('/orders/:id/status', requireStorePermission('orders.write'), order.updateOrderStatus);
router.put('/orders/:id/payment-status', requireStorePermission('orders.write'), order.updatePaymentStatus);
router.put('/orders/:id/shipment', requireStorePermission('orders.write'), order.updateShipment);
router.delete('/orders/:id', requireStorePermission('orders.write'), order.deleteOrder);

router.get('/coupons', requireStorePermission('marketing.read'), coupon.getCoupons);
router.post('/coupons', requireStorePermission('marketing.write'), stripClientStoreId, coupon.createCoupon);
router.put('/coupons/:id', requireStorePermission('marketing.write'), stripClientStoreId, coupon.updateCoupon);

router.get('/categories', requireStorePermission('catalog.read'), category.getCategories);
router.post('/categories', requireStorePermission('catalog.write'), stripClientStoreId, category.createCategory);

router.get('/banners', requireStorePermission('marketing.read'), banner.getBanners);
router.post('/banners', requireStorePermission('marketing.write'), stripClientStoreId, banner.createBanner);

router.get('/reviews', requireStorePermission('catalog.read'), review.adminReviews);
router.get('/returns', requireStorePermission('returns.read'), returns.adminReturns);
router.put('/returns/:id/status', requireStorePermission('returns.write'), returns.updateReturnStatus);

router.get('/dashboard/stats', requireStorePermission('orders.read'), dashboard.stats);
router.get('/reports/sales', requireStorePermission('orders.read'), dashboard.salesReport);
router.get('/reports/products', requireStorePermission('catalog.read'), dashboard.productReport);

router.get('/contact', requireStorePermission('support.read'), contact.adminList);
router.get('/newsletter', requireStorePermission('marketing.read'), newsletter.adminList);

router.get('/crm', requireStorePermission('crm.read'), crm.list);
router.put('/crm/:userId', requireStorePermission('crm.write'), crm.update);

router.get('/inbox', requireStorePermission('inbox.read'), inbox.list);
router.get('/inbox/:id', requireStorePermission('inbox.read'), inbox.get);
router.post('/inbox/:id/reply', requireStorePermission('inbox.write'), inbox.reply);
router.put('/inbox/:id/status', requireStorePermission('inbox.write'), inbox.updateStatus);

router.get('/audit-logs', requireStorePermission('audit.read'), audit.list);
router.get('/audit-logs/options', requireStorePermission('audit.read'), audit.options);
router.get('/audit-logs/:id', requireStorePermission('audit.read'), audit.get);
router.get('/analytics/funnel', requireStorePermission('marketing.read'), analytics.funnel);

router.use('/uploads', requireStorePermission('catalog.write'), require('./uploadRoutes'));

router.get('/instagram', requireStorePermission('instagram.read'), instagram.status);
router.get('/instagram/connect-url', requireStorePermission('instagram.write'), instagram.connectUrl);
router.get('/instagram/media', requireStorePermission('instagram.read'), instagram.media);
router.post('/instagram', requireStorePermission('instagram.write'), instagram.saveStub);

router.get('/shipping/provider', requireStorePermission('orders.read'), (_req, res) => {
  res.json(getShippingProvider());
});

module.exports = router;
