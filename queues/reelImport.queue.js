const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const { reelImportConfig } = require('../config/reelImport');

const QUEUE_NAME = 'reel-product-import';
let connection;
let queue;

function getRedisConnection() {
  const url = String(process.env.REDIS_URL || '').trim();
  if (!url) return null;
  if (!connection) connection = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
  return connection;
}

function getQueue() {
  const redis = getRedisConnection();
  if (!redis) return null;
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: redis });
  return queue;
}

async function enqueueReelImport(jobId) {
  const config = reelImportConfig();
  const persistentQueue = getQueue();
  if (persistentQueue) {
    const job = await persistentQueue.add('process-reel', { jobId: String(jobId) }, {
      jobId: 'reel-' + String(jobId),
      attempts: config.maxAttempts,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 7 * 86400, count: 500 },
      removeOnFail: { age: 30 * 86400, count: 1000 },
    });
    return { queueJobId: String(job.id), mode: 'redis' };
  }
  if (process.env.NODE_ENV === 'production') {
    throw queueError('Redis queue is not configured');
  }
  const immediate = setImmediate(() => {
    require('../workers/reelImport.processor').processReelImportJob(String(jobId)).catch(() => {});
  });
  immediate.unref?.();
  return { queueJobId: 'local-' + String(jobId), mode: 'local-development' };
}

async function removeQueuedReelImport(queueJobId) {
  if (!queueJobId || String(queueJobId).startsWith('local-')) return false;
  const persistentQueue = getQueue();
  if (!persistentQueue) return false;
  const job = await persistentQueue.getJob(String(queueJobId));
  if (!job) return false;
  await job.remove();
  return true;
}

function queueError(message) {
  return Object.assign(new Error(message), { statusCode: 503, code: 'REEL_QUEUE_UNAVAILABLE' });
}

module.exports = {
  QUEUE_NAME,
  enqueueReelImport,
  getRedisConnection,
  removeQueuedReelImport,
  _private: { getQueue },
};
