const express = require('express');
const mongoose = require('mongoose');
const { protect } = require('../../middleware/authMiddleware');
const { requireStoreMember } = require('../../middleware/storeMiddleware');
const { ensureDefaultStore } = require('../../services/storeService');
const StoreMember = require('../../models/StoreMember');
const { Connection } = require('./models');
const meta = require('./meta');
const oauth = require('./oauth');
const inbox = require('./inbox');
const publishing = require('./publishing');
const { getStorageProvider } = require('../../services/mediaStorage.service');
const { rateLimit } = require('express-rate-limit');
const { logAudit } = require('../../services/auditService');
const { wrap } = oauth;
const router = express.Router();
router.use(protect);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.user.role === 'admin' && req.user.activeMode === 'admin') {
    return ensureDefaultStore().then(store => { req.socialStore = store; req.socialWorkspace = 'admin'; req.socialAllows = () => true; next(); }).catch(next);
  }
  if (req.user.activeMode !== 'seller') return res.status(403).json({ message: 'Open the admin or seller workspace to manage social accounts.' });
  return requireStoreMember(req, res, error => { if (error) return next(error); req.socialStore = req.store; req.socialWorkspace = 'seller'; req.socialAllows = permission => StoreMember.roleAllows(req.storeMember.role, permission); next(); });
});
const allow = (...permissions) => (req, res, next) => permissions.some(p => req.socialAllows(p)) ? next() : res.status(403).json({ message: 'Your store role does not have access to this action.' });
const writes = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: req => String(req.user._id), message: { message: 'Too many social actions. Please wait a minute.' } });
router.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) res.once('finish', () => {
    logAudit({ req, storeId: req.socialStore._id, action: 'SOCIAL_WORKSPACE_REQUEST', entityType: 'SocialWorkspace', entityId: req.params.id,
      summary: `${req.method} social workspace ${String(req.route?.path || '').replace(/:[\w]+/g, 'record')} request`,
      outcome: res.statusCode >= 500 ? 'FAILED' : res.statusCode >= 400 ? 'REJECTED' : 'SUCCESS' });
  });
  next();
});
router.param('id', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : res.status(400).json({ message: 'Invalid record identifier.' }));
router.get('/status', allow('inbox.read', 'marketing.read', 'instagram.read'), wrap(async (req, res) => {
  const c = meta.config();
  const missing = [['META_APP_ID', c.appId], ['META_APP_SECRET', c.secret], ['META_REDIRECT_URI', c.callback], ['META_WEBHOOK_VERIFY_TOKEN', c.verifyToken]].filter(([, value]) => !value).map(([key]) => key);
  const accounts = await Connection.find({ storeId: req.socialStore._id }).sort({ provider: 1, name: 1 }).lean();
  const memberships = req.socialWorkspace === 'seller' ? await StoreMember.find({ user: req.user._id, status: 'ACTIVE' }).populate('store', 'name slug').lean() : [];
  res.json({ configured: !missing.length, missing, mediaStorage: getStorageProvider(), store: { id: req.socialStore._id, name: req.socialStore.name },
    stores: memberships.map(m => ({ id: m.store?._id, name: m.store?.name })).filter(s => s.id),
    permissions: { connect: req.socialAllows('instagram.write'), inbox: req.socialAllows('inbox.read'), reply: req.socialAllows('inbox.write'), publish: req.socialAllows('marketing.write'), catalog: req.socialAllows('catalog.read') || req.socialAllows('inbox.read') },
    accounts: accounts.map(({ token, facebookUserId, permissions, syncLease, ...a }) => ({ ...a, ...(a.expiresAt && a.expiresAt <= new Date() ? { status: 'expired' } : {}), capabilities: meta.capabilities({ ...a, permissions }) })),
  });
}));
router.post('/connect', writes, allow('instagram.write'), wrap(oauth.start));
router.get('/pending/:id', allow('instagram.write'), wrap(oauth.pending));
router.post('/pending/:id', writes, allow('instagram.write'), wrap(oauth.activate));
router.delete('/accounts/:id', writes, allow('instagram.write'), wrap(oauth.disconnect));
router.post('/accounts/:id/sync', writes, allow('inbox.read'), wrap(inbox.syncAccount));
router.get('/threads', allow('inbox.read'), wrap(inbox.list));
router.get('/threads/:id', allow('inbox.read'), wrap(inbox.detail));
router.patch('/threads/:id', allow('inbox.read'), wrap(inbox.update));
router.post('/threads/:id/history', writes, allow('inbox.read'), wrap(inbox.older));
router.post('/threads/:id/reply', writes, allow('inbox.write'), wrap(inbox.reply));
router.get('/products', allow('catalog.read', 'inbox.read', 'marketing.read'), wrap(publishing.products));
router.get('/posts', allow('marketing.read'), wrap(publishing.list));
router.get('/posts/:id', allow('marketing.read'), wrap(publishing.get));
router.post('/posts', writes, allow('marketing.write'), wrap(publishing.saveDraft));
router.put('/posts/:id', writes, allow('marketing.write'), wrap(publishing.saveDraft));
router.post('/posts/:id/video', writes, allow('marketing.write'), wrap(publishing.generate));
router.post('/posts/:id/publish', writes, allow('marketing.write'), wrap(publishing.publish));
router.post('/posts/:id/retry', writes, allow('marketing.write'), wrap(publishing.retry));
router.delete('/posts/:id', writes, allow('marketing.write'), wrap(publishing.remove));
router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.statusCode || (error.name === 'CastError' || error.name === 'ValidationError' ? 400 : error.code === 11000 || error.name === 'VersionError' ? 409 : 500);
  res.status(status).json({ message: status >= 500 ? 'Social studio could not complete this request. Please try again.' : error.name === 'CastError' ? 'Invalid record identifier.' : error.code === 11000 || error.name === 'VersionError' ? 'This record changed. Refresh before trying again.' : error.message, code: error.code === 'REPLY_WINDOW_CLOSED' ? error.code : 'SOCIAL_ERROR' });
});
module.exports = router;
