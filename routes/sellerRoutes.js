const router = require('express').Router();
const product = require('../controllers/productController');
const smartFill = require('../controllers/productSmartFillController');
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
const business = require('../controllers/businessController');
const settings = require('../controllers/settingsController');
const delivery = require('../controllers/deliveryController');
const inventory = require('../controllers/inventoryController');
const customization = require('../controllers/websiteCustomizationController');
const notifications = require('../controllers/notificationController');
const subscription = require('../controllers/subscriptionController');
const productDraft = require('../controllers/productDraftController');
const variantGroup = require('../controllers/variantGroupController');
const { requireActiveStoreLicenseForWrites, requireProductCapacity, requireStoreFeature, requireStorePermission, stripClientStoreId } = require('../middleware/storeMiddleware');

router.get('/subscription', requireStorePermission('settings.read'), subscription.status);
router.post('/subscription/checkout', requireStorePermission('settings.write'), subscription.checkout);
router.post('/subscription/verify', requireStorePermission('settings.write'), subscription.verify);
router.use(requireActiveStoreLicenseForWrites);

router.get('/products', requireStorePermission('catalog.read'), product.getProducts);
router.get('/products/smart-fill/status', requireStorePermission('catalog.read'), smartFill.status);
router.post('/products/smart-fill', requireStorePermission('catalog.write'), requireStoreFeature('aiProduct'), smartFill.limiter, smartFill.fill);
router.get('/products/quick-analyze/status', requireStorePermission('catalog.read'), product.getQuickAddVisionStatus);
router.post('/products/quick-analyze', requireStorePermission('catalog.write'), requireStoreFeature('aiProduct'), product.analyzeQuickAdd);
router.get('/products/export', requireStorePermission('catalog.read'), product.exportProducts);
router.get('/products/duplicate-check', requireStorePermission('catalog.read'), product.checkDuplicates);
router.post('/products/bulk', requireStorePermission('catalog.write'), requireBulkInventoryPermission, product.bulkUpdateProducts);
router.get('/products/:id', requireStorePermission('catalog.read'), product.getProductById);
router.post('/products', requireStorePermission('catalog.write'), requireProductCapacity, stripClientStoreId, product.createProduct);
router.put('/products/:id', requireStorePermission('catalog.write'), stripClientStoreId, product.updateProduct);
router.delete('/products/:id', requireStorePermission('catalog.write'), product.deleteProduct);
router.post('/products/:id/duplicate', requireStorePermission('catalog.write'), requireProductCapacity, product.duplicateProduct);
router.patch('/products/:id/restore', requireStorePermission('catalog.write'), requireProductCapacity, product.restoreProduct);
router.patch('/products/:id/status', requireStorePermission('catalog.write'), product.updateStatus);
router.patch('/products/:id/stock', requireStorePermission('inventory.write'), product.updateStock);
router.patch('/products/:id/mark-out-of-stock', requireStorePermission('inventory.write'), product.markOutOfStock);
router.patch('/products/:id/hide', requireStorePermission('catalog.write'), product.hideProduct);
router.post('/product-drafts/bulk-upload', requireStorePermission('catalog.write'), productDraft.bulkUploadMiddleware.array('images', 30), productDraft.bulkUpload);
router.post('/product-drafts', requireStorePermission('catalog.write'), productDraft.createDraft);
router.get('/product-drafts', requireStorePermission('catalog.read'), productDraft.listDrafts);
router.get('/product-drafts/autosave', requireStorePermission('catalog.read'), productDraft.getAutosave);
router.put('/product-drafts/autosave', requireStorePermission('catalog.write'), productDraft.saveAutosave);
router.get('/product-drafts/:id', requireStorePermission('catalog.read'), productDraft.getDraft);
router.put('/product-drafts/:id', requireStorePermission('catalog.write'), productDraft.updateDraft);
router.patch('/product-drafts/:id/archive', requireStorePermission('catalog.write'), productDraft.archiveDraft);
router.patch('/product-drafts/:id/restore', requireStorePermission('catalog.write'), productDraft.restoreDraft);
router.delete('/product-drafts/:id', requireStorePermission('catalog.write'), productDraft.deleteDraft);
router.post('/product-drafts/publish-selected', requireStorePermission('catalog.write'), requireProductCapacity, productDraft.publishSelected);
router.get('/variant-groups', requireStorePermission('catalog.read'), variantGroup.listGroups);
router.get('/variant-groups/candidates', requireStorePermission('catalog.read'), variantGroup.listCandidates);
router.get('/variant-groups/:id', requireStorePermission('catalog.read'), variantGroup.getGroup);
router.post('/variant-groups', requireStorePermission('catalog.write'), stripClientStoreId, variantGroup.createGroup);
router.put('/variant-groups/:id', requireStorePermission('catalog.write'), stripClientStoreId, variantGroup.updateGroup);
router.patch('/variant-groups/:id/archive', requireStorePermission('catalog.write'), variantGroup.archiveGroup);
router.patch('/variant-groups/:id/restore', requireStorePermission('catalog.write'), variantGroup.restoreGroup);
router.post('/variant-groups/:id/reconcile', requireStorePermission('catalog.write'), variantGroup.reconcileGroup);
router.post('/variant-groups/:id/add-products', requireStorePermission('catalog.write'), stripClientStoreId, variantGroup.addProducts);
router.post('/variant-groups/:id/remove-products', requireStorePermission('catalog.write'), stripClientStoreId, variantGroup.removeProducts);
router.delete('/variant-groups/:id', requireStorePermission('catalog.write'), variantGroup.deleteGroup);
router.get('/inventory/history', requireStorePermission('inventory.read'), inventory.history);

router.get('/notifications', notifications.myNotifications);
router.get('/notifications/summary', notifications.summary);
router.patch('/notifications/read-all', notifications.markAllRead);
router.patch('/notifications/:id/read', notifications.markRead);

router.get('/orders', requireStorePermission('orders.read'), order.adminOrders);
router.get('/orders/workspace-summary', requireStorePermission('orders.read'), order.orderWorkspaceSummary);
router.get('/orders/:id', requireStorePermission('orders.read'), order.getOrder);
router.get('/orders/:id/receipt', requireStorePermission('orders.read'), order.receipt);
router.get('/orders/:id/delivery', requireStorePermission('orders.read'), delivery.details);
router.get('/orders/:id/delivery/label', requireStorePermission('orders.write'), requireStoreFeature('shippingAutomation'), delivery.label);
router.post('/orders/:id/delivery/:action', requireStorePermission('orders.write'), requireStoreFeature('shippingAutomation'), delivery.action);
router.put('/orders/:id/status', requireStorePermission('orders.write'), order.updateOrderStatus);
router.put('/orders/:id/payment-status', requireStorePermission('orders.write'), order.updatePaymentStatus);
router.patch('/orders/:id/staff-notes', requireStorePermission('orders.write'), order.addStaffNote);
router.put('/orders/:id/shipping-address', requireStorePermission('orders.write'), order.updateShippingAddress);
router.put('/orders/:id/shipment', requireStorePermission('orders.write'), order.updateShipment);
router.delete('/orders/:id', requireStorePermission('orders.write'), order.deleteOrder);

router.get('/coupons', requireStorePermission('marketing.read'), coupon.getCoupons);
router.post('/coupons', requireStorePermission('marketing.write'), stripClientStoreId, coupon.createCoupon);
router.put('/coupons/:id', requireStorePermission('marketing.write'), stripClientStoreId, coupon.updateCoupon);
router.delete('/coupons/:id', requireStorePermission('marketing.write'), coupon.deleteCoupon);

router.get('/categories', requireStorePermission('catalog.read'), category.getCategories);
router.post('/categories', requireStorePermission('catalog.write'), stripClientStoreId, category.createCategory);
router.put('/categories/reorder', requireStorePermission('catalog.write'), stripClientStoreId, category.reorderCategories);
router.get('/categories/:id/impact', requireStorePermission('catalog.read'), category.getCategoryImpact);
router.post('/categories/:id/reassign', requireStorePermission('catalog.write'), stripClientStoreId, category.reassignCategory);
router.patch('/categories/:id/status', requireStorePermission('catalog.write'), stripClientStoreId, category.updateCategoryStatus);
router.patch('/categories/:id/archive', requireStorePermission('catalog.write'), category.archiveCategory);
router.patch('/categories/:id/restore', requireStorePermission('catalog.write'), category.restoreCategory);
router.get('/categories/:id', requireStorePermission('catalog.read'), category.getCategoryById);
router.put('/categories/:id', requireStorePermission('catalog.write'), stripClientStoreId, category.updateCategory);
router.delete('/categories/:id', requireStorePermission('catalog.write'), category.deleteCategory);

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

router.get('/crm/export', requireStorePermission('crm.read'), requireStoreFeature('crm'), crm.exportCustomers);
router.put('/crm/settings', requireStorePermission('settings.write'), requireStoreFeature('crm'), crm.updateRules);
router.post('/crm/bulk-tags', requireStorePermission('crm.write'), requireStoreFeature('crm'), crm.bulkTags);
router.post('/crm/:userId/privacy-requests', requireStorePermission('crm.write'), requireStoreFeature('crm'), crm.createPrivacyRequest);
router.patch('/crm/:userId/privacy-requests/:requestId', requireStorePermission('crm.write'), requireStoreFeature('crm'), crm.updatePrivacyRequest);
router.get('/crm/:userId', requireStorePermission('crm.read'), requireStoreFeature('crm'), crm.get);
router.put('/crm/:userId/restrictions', requireStorePermission('crm.write'), requireStoreFeature('crm'), crm.updateRestrictions);
router.put('/crm/:userId', requireStorePermission('crm.write'), requireStoreFeature('crm'), crm.update);
router.get('/crm', requireStorePermission('crm.read'), requireStoreFeature('crm'), crm.list);

router.get('/inbox', requireStorePermission('inbox.read'), inbox.list);
router.get('/inbox/:id', requireStorePermission('inbox.read'), inbox.get);
router.post('/inbox/:id/reply', requireStorePermission('inbox.write'), inbox.reply);
router.put('/inbox/:id/status', requireStorePermission('inbox.write'), inbox.updateStatus);

router.get('/audit-logs', requireStorePermission('audit.read'), audit.list);
router.get('/audit-logs/options', requireStorePermission('audit.read'), audit.options);
router.get('/audit-logs/:id', requireStorePermission('audit.read'), audit.get);
router.get('/analytics/funnel', requireStorePermission('marketing.read'), requireStoreFeature('analytics'), analytics.funnel);

router.get('/business/overview', requireStorePermission('orders.read'), business.overview);
router.get('/business/abandoned-carts', requireStorePermission('marketing.read'), business.abandonedCarts);
router.post('/business/abandoned-carts/:id/reminder', requireStorePermission('marketing.write'), business.remindAbandonedCart);
router.post('/business/assistant', requireStorePermission('orders.read'), business.assistant);
router.post('/business/customer-offers', requireStorePermission('marketing.write'), business.customerOffer);
router.put('/business/festival', requireStorePermission('marketing.write'), business.updateFestival);
router.get('/settings', requireStorePermission('settings.read'), settings.getSettings);
router.put('/settings', requireStorePermission('settings.write'), stripClientStoreId, settings.updateSettings);
router.get('/settings/payment-readiness', requireStorePermission('settings.read'), settings.getPaymentReadiness);
router.get('/settings/shipping-readiness', requireStorePermission('settings.read'), delivery.readiness);
router.get('/design', requireStorePermission('settings.read'), customization.getSellerDesign);
router.put('/design', requireStorePermission('settings.write'), customization.updateSellerDesign);
router.post('/design/publish', requireStorePermission('settings.write'), customization.publishSellerDesign);

router.use('/uploads', requireStorePermission('catalog.write'), require('./uploadRoutes'));

router.get('/instagram', requireStorePermission('instagram.read'), requireStoreFeature('socialStudio'), instagram.status);
router.get('/instagram/connect-url', requireStorePermission('instagram.write'), requireStoreFeature('socialStudio'), instagram.connectUrl);
router.get('/instagram/media', requireStorePermission('instagram.read'), requireStoreFeature('socialStudio'), instagram.media);
router.post('/instagram', requireStorePermission('instagram.write'), requireStoreFeature('socialStudio'), instagram.saveStub);

router.get('/shipping/provider', requireStorePermission('orders.read'), delivery.readiness);

function requireBulkInventoryPermission(req, res, next) {
  if (String(req.body?.action || '') !== 'out-of-stock') return next();
  return requireStorePermission('inventory.write')(req, res, next);
}

module.exports = router;
