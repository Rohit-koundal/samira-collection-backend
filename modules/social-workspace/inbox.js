const { Connection, Thread, Message } = require('./models');
const { decryptSecret } = require('../../utils/secretBox');
const meta = require('./meta');
function attachmentUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
async function record(account, { id, participantId, participantName, text, attachments = [], direction, sentAt, externalThreadId }) {
  if (!id || !participantId || !['inbound', 'outbound'].includes(direction)) return null;
  const parsedDate = new Date(sentAt || 0);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.getTime() > Date.now() + 60000 || parsedDate.getTime() < 1) return null;
  const time = parsedDate;
  const thread = await Thread.findOneAndUpdate({ connectionId: account._id, participantId: String(participantId) }, {
    $setOnInsert: { storeId: account.storeId, provider: account.provider },
    $set: { ...(participantName ? { participantName: String(participantName).slice(0, 160) } : {}), ...(externalThreadId ? { externalId: externalThreadId } : {}) },
  }, { new: true, upsert: true });
  let message;
  try {
    message = await Message.findOneAndUpdate({ connectionId: account._id, externalId: String(id) }, { $setOnInsert: {
      storeId: account.storeId, threadId: thread._id, direction, text: String(text || '').slice(0, 10000), sentAt: time,
      attachments: attachments.slice(0, 20).map(a => ({ type: a.type || 'file', url: attachmentUrl(a.url) })).filter(a => a.url), status: direction === 'inbound' ? 'received' : 'sent',
    } }, { new: true, upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  await Thread.updateOne({ _id: thread._id, $or: [{ lastMessageAt: { $lte: time } }, { lastMessageAt: null }] }, { $set: { lastMessageAt: time, preview: String(text || (attachments.length ? 'Attachment' : 'Message')).slice(0, 200) } });
  if (direction === 'inbound') {
    await Thread.updateOne({ _id: thread._id, $or: [{ lastInboundAt: { $lt: time } }, { lastInboundAt: null }] }, { $set: { lastInboundAt: time, resolved: false } });
  }
  return { thread, message };
}
async function ingestHistory(account, conversation) {
  const participant = (conversation.participants?.data || []).find(p => ![account.accountId, account.pageId].includes(p.id));
  if (!participant) return;
  // History is processed oldest first. Only actual customer messages extend the reply window.
  for (const item of [...(conversation.messages?.data || [])].reverse()) {
    const outgoing = [account.accountId, account.pageId].includes(item.from?.id);
    await record(account, { id: item.id, participantId: participant.id, participantName: participant.name || participant.username, text: item.message, direction: outgoing ? 'outbound' : 'inbound', sentAt: item.created_time, externalThreadId: conversation.id,
      attachments: (item.attachments?.data || []).map(a => ({ type: a.mime_type?.startsWith('image') ? 'image' : 'file', url: a.image_data?.url || a.video_data?.url || a.file_url })) });
  }
  // Keep even an attachment-only conversation visible if Meta omits the message body.
  await Thread.updateOne({ connectionId: account._id, participantId: participant.id }, { $set: { externalId: conversation.id, historyCursor: conversation.messages?.paging?.next ? conversation.messages.paging.cursors?.after || '' : '' } });
}
const fields = 'id,updated_time,participants,messages.limit(25){id,message,from,to,created_time,attachments}';
async function syncAccount(req, res) {
  const account = await Connection.findOneAndUpdate({ _id: req.params.id, storeId: req.socialStore._id, $or: [{ syncLease: null }, { syncLease: { $lt: new Date() } }] }, { $set: { syncLease: new Date(Date.now() + 120000) } }, { new: true }).select('+token');
  if (!account) throw meta.fail('Account not found or an inbox sync is already running.', 409);
  try {
    if (!meta.capabilities(account).inbox) throw meta.fail('Messaging permission is missing. Reconnect this account.');
    const after = req.body.older ? account.syncCursor : '';
    if (req.body.older && !after) return res.json({ success: true, hasMore: false });
    const result = await meta.request(`${account.pageId}/conversations`, { token: decryptSecret(account.token), params: { platform: account.provider === 'instagram' ? 'instagram' : 'messenger', fields, limit: 20, after } });
    for (const conversation of result.data || []) await ingestHistory(account, conversation);
    const cursor = result.paging?.next ? result.paging.cursors?.after || '' : '';
    // Refreshing the first page must not discard an in-progress older-history cursor.
    await Connection.updateOne({ _id: account._id }, { $set: { lastSyncedAt: new Date(), status: 'connected', lastError: '', ...(req.body.older || !account.syncCursor ? { syncCursor: cursor } : {}) } });
    res.json({ success: true, hasMore: Boolean(cursor) });
  } catch (error) {
    await Connection.updateOne({ _id: account._id }, { $set: { lastError: error.message, ...([190, 102].includes(error.metaCode) ? { status: 'expired' } : {}) } }); throw error;
  } finally { await Connection.updateOne({ _id: account._id }, { $unset: { syncLease: 1 } }); }
}
async function list(req, res) {
  const filter = { storeId: req.socialStore._id };
  if (['facebook', 'instagram'].includes(req.query.provider)) filter.provider = req.query.provider;
  if (req.query.state === 'unread') filter.$expr = { $gt: ['$lastInboundAt', { $ifNull: ['$readAt', new Date(0)] }] };
  if (req.query.state === 'open') filter.resolved = false;
  if (req.query.state === 'resolved') filter.resolved = true;
  if (req.query.search) { const expression = String(req.query.search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); filter.$or = [{ participantName: new RegExp(expression, 'i') }, { preview: new RegExp(expression, 'i') }]; }
  const page = Math.max(0, Math.min(1000, parseInt(req.query.page, 10) || 0));
  const rows = await Thread.find(filter).sort({ lastMessageAt: -1, _id: -1 }).skip(page * 30).limit(31).lean();
  const unread = await Thread.countDocuments({ storeId: req.socialStore._id, $expr: { $gt: ['$lastInboundAt', { $ifNull: ['$readAt', new Date(0)] }] } });
  res.json({ threads: rows.slice(0, 30).map(t => ({ ...t, canReply: meta.replyAllowed(t), unread: new Date(t.lastInboundAt || 0) > new Date(t.readAt || 0) })), hasMore: rows.length > 30, unread });
}
async function detail(req, res) {
  const thread = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id }).lean();
  if (!thread) throw meta.fail('Conversation not found.', 404);
  const filter = { threadId: thread._id, storeId: thread.storeId };
  if (req.query.before && /^[a-f\d]{24}$/i.test(req.query.before)) {
    const pivot = await Message.findOne({ _id: req.query.before, threadId: thread._id, storeId: thread.storeId }).lean();
    if (!pivot) throw meta.fail('Message not found.', 404);
    filter.$or = [{ sentAt: { $lt: pivot.sentAt } }, { sentAt: pivot.sentAt, _id: { $lt: pivot._id } }];
  }
  const messages = await Message.find(filter).sort({ sentAt: -1, _id: -1 }).limit(51).lean();
  res.json({ thread: { ...thread, canReply: meta.replyAllowed(thread) }, messages: messages.slice(0, 50).reverse(), hasMore: messages.length > 50 });
}
async function update(req, res) {
  const set = {};
  if (typeof req.body.resolved === 'boolean') set.resolved = req.body.resolved;
  const thread = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id });
  if (!thread) throw meta.fail('Conversation not found.', 404);
  // Mark the last displayed inbound timestamp, rather than messages arriving after the read.
  let readAt;
  if (req.body.readAt) { const time = new Date(req.body.readAt); if (Number.isFinite(time.getTime()) && time <= new Date() && time > new Date(thread.readAt || 0)) readAt = time; }
  await Thread.updateOne({ _id: thread._id }, { $set: set, ...(readAt ? { $max: { readAt } } : {}) }); res.json({ success: true });
}
async function older(req, res) {
  const thread = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id });
  if (!thread?.externalId || !thread.historyCursor) throw meta.fail('No older messages are available from Meta.');
  const account = await Connection.findOne({ _id: thread.connectionId, storeId: req.socialStore._id }).select('+token');
  if (!account) throw meta.fail('Reconnect this account first.');
  const result = await meta.request(`${thread.externalId}/messages`, { token: decryptSecret(account.token), params: { fields: 'id,message,from,to,created_time,attachments', after: thread.historyCursor, limit: 25 } });
  await ingestHistory(account, { id: thread.externalId, participants: { data: [{ id: thread.participantId, name: thread.participantName }] }, messages: result });
  res.json({ success: true });
}
async function reply(req, res) {
  const text = String(req.body.text || '').trim(), clientId = String(req.body.clientId || '');
  if (!text || text.length > 1000 || !/^[\w-]{16,80}$/.test(clientId)) throw meta.fail('Write a reply of up to 1,000 characters.');
  const thread = await Thread.findOne({ _id: req.params.id, storeId: req.socialStore._id });
  if (!thread) throw meta.fail('Conversation not found.', 404);
  const existing = await Message.findOne({ threadId: thread._id, clientId });
  if (existing) return res.json({ message: existing });
  if (!meta.replyAllowed(thread)) throw meta.fail('The 24-hour reply window has closed. Wait for a new customer message or continue in Meta Business Suite.', 409, 'REPLY_WINDOW_CLOSED');
  const account = await Connection.findOne({ _id: thread.connectionId, storeId: thread.storeId, status: 'connected' }).select('+token');
  if (!account || !meta.capabilities(account).inbox) throw meta.fail('Reconnect this account with messaging access.');
  let message;
  try { message = await Message.create({ storeId: thread.storeId, threadId: thread._id, connectionId: account._id, clientId, direction: 'outbound', text, status: 'sending', sentAt: new Date() }); }
  catch (error) { if (error.code !== 11000) throw error; return res.json({ message: await Message.findOne({ threadId: thread._id, clientId }) }); }
  let accepted = false;
  try {
    const result = await meta.request(`${account.pageId}/messages`, { token: decryptSecret(account.token), method: 'POST', params: { recipient: { id: thread.participantId }, message: { text }, ...(account.provider === 'facebook' ? { messaging_type: 'RESPONSE' } : {}) } });
    if (!result.message_id) throw Object.assign(meta.fail('Meta did not confirm delivery. Check the conversation before sending again.'), { ambiguous: true });
    accepted = true;
    // Echo webhooks can arrive before the send response; merge without duplicating the bubble.
    await Message.deleteOne({ connectionId: account._id, externalId: result.message_id, _id: { $ne: message._id } });
    message.externalId = result.message_id; message.status = 'sent';
    await message.save();
    await Thread.updateOne({ _id: thread._id, $or: [{ lastMessageAt: { $lte: message.sentAt } }, { lastMessageAt: null }] }, { $set: { lastMessageAt: message.sentAt, preview: text.slice(0, 200) } });
  } catch (error) {
    message.status = accepted || error.ambiguous ? 'unknown' : 'failed'; message.error = accepted ? 'Meta accepted the reply but local confirmation was interrupted. Sync and check the conversation before sending again.' : error.message; await message.save();
  }
  res.json({ message });
}
async function webhook(req, res) {
  if (!meta.verifySignature(req.body, req.headers['x-hub-signature-256'])) return res.sendStatus(403);
  let payload; try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  for (const entry of (payload.entry || []).slice(0, 100)) {
    const provider = payload.object === 'instagram' ? 'instagram' : 'facebook';
    for (const event of (entry.messaging || []).slice(0, 100)) {
      if (!event.message?.mid) continue;
      const account = await Connection.findOne({ provider, accountId: String(entry.id), status: 'connected' });
      if (!account) continue;
      if (event.message.is_deleted) {
        await Message.updateOne({ connectionId: account._id, externalId: event.message.mid }, { $set: { text: 'This message was removed on Meta.', attachments: [] } });
        continue;
      }
      const outgoing = event.message.is_echo || [account.accountId, account.pageId].includes(String(event.sender?.id));
      await record(account, { id: event.message.mid, participantId: outgoing ? event.recipient?.id : event.sender?.id, direction: outgoing ? 'outbound' : 'inbound', text: event.message.is_deleted ? 'This message was removed on Meta.' : event.message.text, sentAt: event.timestamp,
        attachments: (event.message.attachments || []).map(a => ({ type: a.type, url: a.payload?.url })) });
    }
  }
  res.sendStatus(200);
}
function verifyWebhook(req, res) {
  if (meta.config().verifyToken && req.query['hub.mode'] === 'subscribe' && meta.equal(req.query['hub.verify_token'], meta.config().verifyToken)) return res.status(200).type('text').send(String(req.query['hub.challenge'] || ''));
  return res.sendStatus(403);
}
module.exports = { record, ingestHistory, syncAccount, list, detail, update, older, reply, webhook, verifyWebhook };
