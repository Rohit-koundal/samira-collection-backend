const { Queue } = require('bullmq');
const { getReelImportConfig } = require('../config/reelImport');

const QUEUE_NAME = 'reel-product-import';
let queue;

function getRedisConnection() {
  if (!process.env.REDIS_URL) return null;
  try {
    const redisUrl = new URL(process.env.REDIS_URL);
    return {
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
      username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
      password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
      db: redisUrl.pathname && redisUrl.pathname !== '/' ? Number(redisUrl.pathname.slice(1)) : 0,
      tls: redisUrl.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null,
    };
  } catch {
    const error = new Error('REDIS_URL is invalid.');
    error.code = 'REEL_QUEUE_CONFIGURATION_INVALID';
    throw error;
  }
}

function getQueue() {
  const connection = getRedisConnection();
  if (!connection) return null;
  if (!queue) queue = new Queue(QUEUE_NAME, { connection });
  return queue;
}

async function enqueueReelImport({ jobId, storageKey }) {
  const config = getReelImportConfig();
  const payload = { jobId: String(jobId), storageKey: String(storageKey) };
  const activeQueue = getQueue();

  if (activeQueue) {
    await activeQueue.add('process-reel', payload, {
      jobId: String(jobId),
      attempts: config.maxAttempts,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 100 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 500 },
    });
    return { mode: 'redis' };
  }

  setTimeout(() => {
    require('../workers/reelImport.processor').processReelImportJob(payload)
      .catch((error) => console.error(JSON.stringify({
        event: 'reel_import_dev_worker_failed',
        jobId: payload.jobId,
        code: error.code || 'PROCESSING_FAILED',
        message: error.message,
      })));
  }, 25);
  return { mode: 'in-process' };
}

async function removeQueuedReelImport(jobId) {
  const activeQueue = getQueue();
  if (!activeQueue) return false;
  const queuedJob = await activeQueue.getJob(String(jobId));
  if (!queuedJob) return false;
  const state = await queuedJob.getState();
  if (['waiting', 'delayed', 'paused'].includes(state)) {
    await queuedJob.remove();
    return true;
  }
  return false;
}

async function closeReelImportQueue() {
  if (queue) await queue.close();
  queue = null;
}

module.exports = {
  QUEUE_NAME,
  closeReelImportQueue,
  enqueueReelImport,
  getRedisConnection,
  removeQueuedReelImport,
};
