const mongoose = require('mongoose');
const { Schema } = mongoose;
const tenant = { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true };
const connection = new Schema({
  storeId: tenant, provider: { type: String, enum: ['facebook', 'instagram'], required: true },
  accountId: { type: String, required: true }, pageId: String, name: String, username: String,
  facebookUserId: String, token: { type: String, select: false }, permissions: [String],
  status: { type: String, default: 'connected' }, lastError: String, subscribed: Boolean,
  lastSyncedAt: Date, syncCursor: String, syncLease: Date, expiresAt: Date,
}, { timestamps: true });
// A Meta identity cannot silently be attached to another merchant's workspace.
connection.index({ provider: 1, accountId: 1 }, { unique: true });
const oauth = new Schema({
  storeId: tenant, userId: { type: Schema.Types.ObjectId, required: true }, workspace: String,
  stateHash: { type: String, unique: true }, ticketHash: String, nonceHash: String,
  phase: { type: String, default: 'created' }, encryptedAccounts: { type: String, select: false },
  facebookUserId: { type: String, select: false },
  expiresAt: { type: Date, expires: 0 },
}, { timestamps: true });
const thread = new Schema({
  storeId: tenant, connectionId: { type: Schema.Types.ObjectId, required: true }, provider: String,
  participantId: { type: String, required: true }, participantName: String, externalId: String,
  lastMessageAt: Date, lastInboundAt: Date, readAt: Date, preview: String,
  resolved: { type: Boolean, default: false }, historyCursor: String,
}, { timestamps: true });
thread.index({ connectionId: 1, participantId: 1 }, { unique: true });
thread.index({ storeId: 1, lastMessageAt: -1, _id: -1 });
const message = new Schema({
  storeId: tenant, threadId: { type: Schema.Types.ObjectId, required: true, index: true },
  connectionId: Schema.Types.ObjectId, externalId: { type: String }, clientId: String,
  direction: { type: String, enum: ['inbound', 'outbound'] }, text: String,
  attachments: [new Schema({ type: String, url: String }, { _id: false })], sentAt: Date,
  status: { type: String, default: 'received' }, error: String,
}, { timestamps: true });
message.index({ connectionId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } });
message.index({ threadId: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });
const target = new Schema({
  connectionId: Schema.Types.ObjectId, provider: String, name: String,
  status: { type: String, default: 'queued' }, containerId: String, childIds: [String],
  externalId: String, permalink: String, error: String, startedAt: Date,
}, { _id: false });
const post = new Schema({
  storeId: tenant, createdBy: Schema.Types.ObjectId, productId: Schema.Types.ObjectId,
  productName: String, productPrice: Number, productUrl: String, caption: String,
  kind: { type: String, enum: ['photos', 'reel'], default: 'photos' }, images: [String],
  preparedImages: [String], videoUrl: String,
  videoStatus: { type: String, default: 'none' }, videoError: String,
  status: { type: String, default: 'draft' }, targets: [target],
  leaseUntil: Date, workerId: String, attempts: { type: Number, default: 0 },
}, { timestamps: true, optimisticConcurrency: true });
post.index({ storeId: 1, createdAt: -1 });
module.exports = {
  Connection: mongoose.model('SocialAccount', connection), OAuth: mongoose.model('SocialOAuth', oauth),
  Thread: mongoose.model('SocialThread', thread), Message: mongoose.model('SocialMessage', message),
  Post: mongoose.model('SocialPost', post),
  Deletion: mongoose.model('SocialDeletion', new Schema({ code: { type: String, unique: true }, expiresAt: { type: Date, expires: 0 } }, { timestamps: true })),
};
