require('dotenv').config();
const { Worker } = require('bullmq');
const { QUEUE_NAME, getRedisConnection } = require('../queues/reelImport.queue');
const { reelImportConfig, isReelImportEnabled } = require('../config/reelImport');
const { processReelImportJob } = require('./reelImport.processor');

if (!isReelImportEnabled()) throw new Error('ENABLE_REEL_PRODUCT_IMPORT must be true to start the reel worker');
const connection = getRedisConnection();
if (!connection) throw new Error('REDIS_URL is required for the reel worker');

const worker = new Worker(QUEUE_NAME, async (queueJob) => (
  processReelImportJob(queueJob.data.jobId, (percentage) => queueJob.updateProgress(percentage))
), {
  connection,
  concurrency: reelImportConfig().workerConcurrency,
  lockDuration: reelImportConfig().timeoutMinutes * 60 * 1000,
});

worker.on('failed', (job, error) => {
  console.error(JSON.stringify({ level: 'error', event: 'reel_job_failed', jobId: job?.data?.jobId, code: error?.code || 'REEL_PROCESSING_FAILED' }));
});

async function shutdown() {
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
