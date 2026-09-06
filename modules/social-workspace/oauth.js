const crypto = require('crypto');
const { OAuth, Connection, Thread, Message, Post, Deletion } = require('./models');
const { encryptSecret, decryptSecret } = require('../../utils/secretBox');
const meta = require('./meta');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const cookieName = 'samira_social_oauth';
const random = () => crypto.randomBytes(32).toString('hex');
function cookieOptions() { return { httpOnly: true, secure: meta.config().callback.startsWith('https:'), sameSite: 'lax', path: '/api/social/oauth', maxAge: 10 * 60000 }; }
function callbackBase() { return meta.config().callback.replace(/\/callback$/, ''); }
function requireConfig() {
  const c = meta.config();
  if (!c.appId || !c.secret || !c.callback || !c.verifyToken) throw meta.fail('Connect a Meta developer app in the server settings first.', 400, 'META_NOT_CONFIGURED');
  const url = new URL(c.callback);
  if (url.pathname !== '/api/social/oauth/callback' || (!['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol !== 'https:')) throw meta.fail('The Meta redirect URI must use HTTPS and end with /api/social/oauth/callback.');
}
async function start(req, res) {
  requireConfig();
  const state = random(), ticket = random();
  await OAuth.create({ storeId: req.socialStore._id, userId: req.user._id, workspace: req.socialWorkspace, stateHash: meta.hash(state), ticketHash: meta.hash(ticket), nonceHash: '', expiresAt: new Date(Date.now() + 10 * 60000) });
  // Top-level navigation sets a first-party cookie even when API and web origins differ.
  res.json({ url: `${callbackBase()}/start?ticket=${ticket}&state=${state}` });
}
async function navigate(req, res) {
  requireConfig();
  const nonce = random();
  const session = await OAuth.findOneAndUpdate({ ticketHash: meta.hash(req.query.ticket), stateHash: meta.hash(req.query.state), phase: 'created', expiresAt: { $gt: new Date() } }, { $set: { phase: 'authorizing', nonceHash: meta.hash(nonce) }, $unset: { ticketHash: 1 } });
  if (!session) throw meta.fail('This connection link expired. Start again from Accounts.');
  res.cookie(cookieName, nonce, cookieOptions());
  const c = meta.config(), query = new URLSearchParams({ client_id: c.appId, redirect_uri: c.callback, state: String(req.query.state), response_type: 'code', scope: meta.SCOPES.join(','), auth_type: 'rerequest' });
  res.set('Referrer-Policy', 'no-referrer').redirect(`https://www.facebook.com/${c.version}/dialog/oauth?${query}`);
}
async function callback(req, res) {
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
  const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  const session = cookie && await OAuth.findOneAndUpdate({ stateHash: meta.hash(req.query.state), nonceHash: meta.hash(cookie), phase: 'authorizing', expiresAt: { $gt: new Date() } }, { $set: { phase: 'exchanging' }, $unset: { nonceHash: 1 } }, { new: true });
  const { maxAge, ...clearOptions } = cookieOptions();
  res.clearCookie(cookieName, clearOptions);
  if (!session) return res.status(400).type('text').send('Connection expired or could not be verified. Return to Social studio and connect again.');
  const destination = `${meta.config().frontend}/${session.workspace}/social?storeId=${session.storeId}`;
  if (req.query.error || !req.query.code) { await session.deleteOne(); return res.redirect(destination + '&socialError=cancelled'); }
  try {
    const c = meta.config();
    const short = await meta.request('oauth/access_token', { params: { client_id: c.appId, client_secret: c.secret, redirect_uri: c.callback, code: req.query.code } });
    const long = await meta.request('oauth/access_token', { params: { grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.secret, fb_exchange_token: short.access_token } });
    if (!long.access_token) throw meta.fail('Meta did not return an access token.');
    const identity = await meta.request('me', { token: long.access_token, params: { fields: 'id' } });
    const grant = await meta.request('me/permissions', { token: long.access_token });
    const permissions = (grant.data || []).filter(p => p.status === 'granted').map(p => p.permission);
    if (!permissions.includes('pages_show_list')) throw meta.fail('Page access was not granted.');
    const pages = []; let after;
    for (let i = 0; i < 10; i++) {
      const result = await meta.request('me/accounts', { token: long.access_token, params: { fields: 'id,name,access_token,tasks,instagram_business_account{id,username,name}', limit: 100, after } });
      pages.push(...(result.data || []).filter(p => p.id && p.access_token));
      after = result.paging?.next && result.paging?.cursors?.after;
      if (!after) break;
    }
    session.encryptedAccounts = encryptSecret(JSON.stringify({ pages, permissions, facebookUserId: identity.id, expiresAt: new Date(Date.now() + Number(long.expires_in || 5184000) * 1000) }));
    session.facebookUserId = identity.id; session.phase = 'ready'; session.expiresAt = new Date(Date.now() + 10 * 60000); await session.save();
    return res.redirect(destination + '&connectionSession=' + session._id);
  } catch {
    await session.deleteOne(); return res.redirect(destination + '&socialError=connection');
  }
}
async function pending(req, res) {
  const session = await OAuth.findOne({ _id: req.params.id, storeId: req.socialStore._id, userId: req.user._id, phase: 'ready', expiresAt: { $gt: new Date() } }).select('+encryptedAccounts');
  if (!session) throw meta.fail('Account selection expired. Connect again.', 404);
  const { pages, permissions } = JSON.parse(decryptSecret(session.encryptedAccounts));
  res.json({ pages: pages.map(p => ({ id: p.id, name: p.name, instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username } : null })), missingPermissions: meta.SCOPES.filter(p => !permissions.includes(p)) });
}
async function activate(req, res) {
  const pageIds = [...new Set(Array.isArray(req.body.pageIds) ? req.body.pageIds.map(String) : [])];
  if (!pageIds.length || pageIds.length > 20) throw meta.fail('Choose between 1 and 20 Facebook Pages.');
  const session = await OAuth.findOneAndUpdate({ _id: req.params.id, storeId: req.socialStore._id, userId: req.user._id, phase: 'ready', expiresAt: { $gt: new Date() } }, { $set: { phase: 'activating' } }, { new: true }).select('+encryptedAccounts');
  if (!session) throw meta.fail('Account selection expired or is already connecting.', 409);
  const payload = JSON.parse(decryptSecret(session.encryptedAccounts));
  const results = [];
  try {
    for (const id of pageIds) {
      const page = payload.pages.find(p => p.id === id);
      if (!page) throw meta.fail('Choose a Page returned by your Meta login.');
      const accounts = [{ provider: 'facebook', accountId: id, name: page.name }];
      if (page.instagram_business_account && payload.permissions.includes('instagram_basic')) accounts.push({ provider: 'instagram', accountId: page.instagram_business_account.id, name: page.instagram_business_account.name || page.instagram_business_account.username, username: page.instagram_business_account.username });
      const conflict = await Connection.exists({ $or: accounts.map(a => ({ provider: a.provider, accountId: a.accountId })), storeId: { $ne: session.storeId } });
      if (conflict) throw meta.fail('One of these accounts already belongs to another store. Disconnect it there first.', 409);
      await meta.request(id, { token: page.access_token, params: { fields: 'id' } });
      let subscribed = false;
      try { subscribed = Boolean((await meta.request(`${id}/subscribed_apps`, { token: page.access_token, method: 'POST', params: { subscribed_fields: 'messages,messaging_postbacks,message_reads,message_deliveries' } })).success); } catch { /* Inbox remains available through explicit sync; surface webhook issue. */ }
      for (const account of accounts) {
        const saved = await Connection.findOneAndUpdate({ provider: account.provider, accountId: account.accountId, storeId: session.storeId }, { $set: { ...account, storeId: session.storeId, pageId: id, token: encryptSecret(page.access_token), permissions: payload.permissions, facebookUserId: payload.facebookUserId, expiresAt: payload.expiresAt, status: 'connected', subscribed, lastError: subscribed ? '' : 'Live updates could not be enabled. Check Page webhook permissions; use Sync inbox meanwhile.' } }, { new: true, upsert: true });
        results.push(saved._id);
      }
    }
    await session.deleteOne(); res.json({ connected: results });
  } catch (error) { session.phase = 'ready'; await session.save(); throw error; }
}
async function purgeAccount(account) {
  await Connection.deleteOne({ _id: account._id });
  await Message.deleteMany({ connectionId: account._id }); await Thread.deleteMany({ connectionId: account._id });
  await Post.updateMany({ storeId: account.storeId, 'targets.connectionId': account._id }, { $set: { 'targets.$[target].status': 'disconnected', 'targets.$[target].error': 'Account disconnected.' }, $inc: { __v: 1 } }, { arrayFilters: [{ 'target.connectionId': account._id, 'target.status': { $nin: ['published'] } }] });
}
async function disconnect(req, res) {
  const account = await Connection.findOne({ _id: req.params.id, storeId: req.socialStore._id }).select('+token');
  if (!account) throw meta.fail('Account not found.', 404);
  // A Page subscription serves its linked Instagram too. Only remove it for the last local account.
  const sibling = await Connection.exists({ pageId: account.pageId, _id: { $ne: account._id } });
  if (!sibling) await meta.request(`${account.pageId}/subscribed_apps`, { token: decryptSecret(account.token), method: 'DELETE' }).catch(() => {});
  await purgeAccount(account); res.json({ success: true });
}
async function deauthorize(req, res) {
  const data = meta.signedRequest(req.body.signed_request);
  for (const account of await Connection.find({ facebookUserId: String(data.user_id) })) await purgeAccount(account);
  await OAuth.deleteMany({ facebookUserId: String(data.user_id) });
  const code = crypto.createHmac('sha256', meta.config().secret).update('deleted:' + data.user_id).digest('hex');
  await Deletion.updateOne({ code }, { $set: { expiresAt: new Date(Date.now() + 30 * 86400000) } }, { upsert: true });
  res.json({ url: callbackBase().replace('/oauth', '') + '/deletion-status/' + code, confirmation_code: code });
}
async function deletionStatus(req, res) {
  const found = /^[a-f0-9]{64}$/.test(req.params.code) && await Deletion.exists({ code: req.params.code, expiresAt: { $gt: new Date() } });
  return found ? res.type('text').send('The requested connected-account data has been removed from Social studio.') : res.sendStatus(404);
}
module.exports = { wrap, start, navigate, callback, pending, activate, disconnect, deauthorize, deletionStatus };
