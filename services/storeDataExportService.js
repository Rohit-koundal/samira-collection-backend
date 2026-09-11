const { once } = require('node:events');
const crypto = require('node:crypto');
const Banner = require('../models/Banner');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const AuditLog = require('../models/AuditLog');
const BannerEngagement = require('../models/BannerEngagement');
const Campaign = require('../models/Campaign');
const Cart = require('../models/Cart');
const Category = require('../models/Category');
const CheckoutAttempt = require('../models/CheckoutAttempt');
const ContactMessage = require('../models/ContactMessage');
const Conversation = require('../models/Conversation');
const Coupon = require('../models/Coupon');
const CouponCustomerUsage = require('../models/CouponCustomerUsage');
const CustomerCrm = require('../models/CustomerCrm');
const InstagramConnection = require('../models/InstagramConnection');
const InventoryPurchaseOrder = require('../models/InventoryPurchaseOrder');
const InventoryTransaction = require('../models/InventoryTransaction');
const Order = require('../models/Order');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const ReelCandidate = require('../models/ReelCandidate');
const ReelImport = require('../models/ReelImport');
const ReportView = require('../models/ReportView');
const ReturnExchange = require('../models/ReturnExchange');
const Review = require('../models/Review');
const ReviewReport = require('../models/ReviewReport');
const ReviewVote = require('../models/ReviewVote');
const Settings = require('../models/Settings');
const Shipment = require('../models/Shipment');
const StoreContentVersion = require('../models/StoreContentVersion');
const StorefrontDesignVersion = require('../models/StorefrontDesignVersion');
const StoreMember = require('../models/StoreMember');
const StorePortfolioOperation = require('../models/StorePortfolioOperation');
const Subscriber = require('../models/Subscriber');
const SubscriptionPayment = require('../models/SubscriptionPayment');
const SocialProductImport = require('../models/SocialProductImport');
const User = require('../models/User');
const VariantGroup = require('../models/VariantGroup');
const { Connection: SocialAccount, Thread: SocialThread, Message: SocialMessage, Post: SocialPost } = require('../modules/social-workspace/models');
const { ApiError } = require('../utils/apiError');

const COLLECTIONS = [
  ['analyticsEvents', AnalyticsEvent, 'storeId'], ['auditLogs', AuditLog, 'storeId'],
  ['categories', Category, 'storeId'], ['products', Product, 'storeId'], ['productDrafts', ProductDraft, 'storeId'],
  ['variantGroups', VariantGroup, 'storeId'], ['orders', Order, 'storeId'], ['shipments', Shipment, 'storeId'],
  ['returns', ReturnExchange, 'storeId'], ['carts', Cart, 'storeId'], ['reviews', Review, 'storeId'],
  ['reviewVotes', ReviewVote, 'storeId'], ['reviewReports', ReviewReport, 'storeId'],
  ['coupons', Coupon, 'storeId'], ['couponCustomerUsage', CouponCustomerUsage, 'storeId'],
  ['banners', Banner, 'storeId'], ['bannerEngagements', BannerEngagement, 'storeId'], ['campaigns', Campaign, 'storeId'],
  ['checkoutAttempts', CheckoutAttempt, 'storeId'], ['contacts', ContactMessage, 'storeId'],
  ['conversations', Conversation, 'storeId'], ['messages', Message, 'storeId'], ['notifications', Notification, 'storeId'],
  ['inventoryTransactions', InventoryTransaction, 'storeId'], ['inventoryPurchaseOrders', InventoryPurchaseOrder, 'storeId'],
  ['customerProfiles', CustomerCrm, 'storeId'], ['subscribers', Subscriber, 'storeId'], ['settings', Settings, 'storeId'],
  ['storefrontVersions', StorefrontDesignVersion, 'storeId'], ['teamMemberships', StoreMember, 'store'],
  ['reportViews', ReportView, 'storeId'], ['reelImports', ReelImport, 'storeId'], ['socialProductImports', SocialProductImport, 'storeId'],
  ['socialAccounts', SocialAccount, 'storeId'], ['socialThreads', SocialThread, 'storeId'], ['socialMessages', SocialMessage, 'storeId'],
  ['socialPosts', SocialPost, 'storeId'], ['instagramConnection', InstagramConnection, 'storeId'],
  ['subscriptionPayments', SubscriptionPayment, 'store'], ['portfolioOperations', StorePortfolioOperation, 'store'],
];

function prepare(store, input = {}) {
  const revision = Number(input.baseRevision);
  if (!Number.isInteger(revision) || revision !== Number(store.portfolioRevision || 0)) throw new ApiError('DUPLICATE_REQUEST', 'This store changed in another session. Reload before exporting.');
  const reason = String(input.reason || '').trim();
  if (reason.length < 3 || reason.length > 500) throw new ApiError('VALIDATION_ERROR', 'Add a reason for this client data export');
  return { revision, reason };
}

async function writeLine(res, value, hash) {
  const line = `${JSON.stringify(value)}\n`;
  if (hash) hash.update(line, 'utf8');
  if (!res.write(line)) await once(res, 'drain');
}

async function streamStoreData(res, store) {
  const exportedAt = new Date().toISOString();
  const hash = crypto.createHash('sha256');
  const collectionCounts = { store: 1 };
  let totalRecords = 1;
  await writeLine(res, { type: 'manifest', format: 'samira-store-data', version: 2, checksum: 'sha256', storeId: String(store._id), storeSlug: store.slug, exportedAt }, hash);
  await writeLine(res, { type: 'store', data: store.toObject ? store.toObject() : store }, hash);
  const customerIds = new Set();
  for (const [collection, Model, field] of COLLECTIONS) {
    const query = field === 'scopeId' ? { scopeType: 'STORE', scopeId: store._id } : { [field]: store._id };
    collectionCounts[collection] = 0;
    for await (const record of Model.find(query).lean().cursor()) {
      if (record.user) customerIds.add(String(record.user));
      await writeLine(res, { type: 'record', collection, data: record }, hash);
      collectionCounts[collection] += 1;
      totalRecords += 1;
    }
  }
  const reelJobIds = await ReelImport.find({ storeId: store._id }).distinct('_id');
  collectionCounts.reelCandidates = 0;
  if (reelJobIds.length) {
    for await (const candidate of ReelCandidate.find({ job: { $in: reelJobIds } }).lean().cursor()) {
      await writeLine(res, { type: 'record', collection: 'reelCandidates', data: candidate }, hash);
      collectionCounts.reelCandidates += 1;
      totalRecords += 1;
    }
  }
  collectionCounts.contentVersions = 0;
  for await (const version of StoreContentVersion.find({ scopeType: 'STORE', scopeId: store._id }).lean().cursor()) {
    await writeLine(res, { type: 'record', collection: 'contentVersions', data: version }, hash);
    collectionCounts.contentVersions += 1;
    totalRecords += 1;
  }
  if (store.owner) customerIds.add(String(store.owner));
  collectionCounts.customersAndStaff = 0;
  if (customerIds.size) {
    const projection = 'name phone email role activeMode availableModes isPhoneVerified isBlocked createdAt updatedAt lastLoginAt';
    for await (const user of User.find({ _id: { $in: [...customerIds] } }).select(projection).lean().cursor()) {
      await writeLine(res, { type: 'record', collection: 'customersAndStaff', data: user }, hash);
      collectionCounts.customersAndStaff += 1;
      totalRecords += 1;
    }
  }
  await writeLine(res, {
    type: 'complete',
    exportedAt: new Date().toISOString(),
    totalRecords,
    collectionCounts,
    checksum: { algorithm: 'sha256', value: hash.digest('hex'), covers: 'all UTF-8 NDJSON lines before this completion record' },
  });
}

module.exports = { prepare, streamStoreData };
