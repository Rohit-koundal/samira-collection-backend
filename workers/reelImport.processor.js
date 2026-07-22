const ReelImport = require('../modules/reel-product-import/reelImport.model');
const ReelCandidate = require('../modules/reel-product-import/reelCandidate.model');
const { reelImportConfig } = require('../config/reelImport');

async function processReelImportJob(jobId, reportProgress = async () => {}) {
  const job = await ReelImport.findById(jobId);
  if (!job || job.status === 'cancelled' || job.cancellationRequested) return { cancelled: true };
  const config = reelImportConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMinutes * 60 * 1000);
  try {
    await updateJob(job, 'processing', 5, 'Preparing video', 'Worker accepted the processing job');
    await reportProgress(5);
    const workerUrl = String(process.env.AI_VIDEO_WORKER_URL || '').replace(/\/$/, '');
    const token = String(process.env.AI_VIDEO_WORKER_SERVICE_TOKEN || '');
    if (!workerUrl || !token) throw safeError('AI video worker is not configured', 'AI_WORKER_NOT_CONFIGURED');
    const response = await fetch(workerUrl + '/internal/reel-processing/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': token },
      body: JSON.stringify({
        jobId: String(job._id),
        videoUrl: job.sourceVideo.url,
        videoStorageKey: job.sourceVideo.storageKey,
        processingConfig: job.processingConfig,
      }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw safeError(result.message || 'Video worker could not process this reel', result.code || 'AI_WORKER_ERROR');
    if (job.cancellationRequested) {
      await updateJob(job, 'cancelled', job.progress.percentage, 'Cancelled', 'Processing was cancelled');
      return { cancelled: true };
    }
    await persistWorkerResult(job, result);
    await updateJob(job, 'review_required', 100, 'Ready for review', 'Possible products and best images are ready');
    job.statistics = { ...job.statistics.toObject?.(), ...(result.statistics || {}), detectedProducts: (result.candidates || []).length };
    job.completedAt = new Date();
    job.error = undefined;
    await job.save();
    await reportProgress(100);
    return { candidates: (result.candidates || []).length };
  } catch (error) {
    job.status = job.cancellationRequested ? 'cancelled' : 'failed';
    job.progress = {
      percentage: Number(job.progress?.percentage || 0),
      currentStep: job.cancellationRequested ? 'Cancelled' : 'Processing failed',
      message: job.cancellationRequested ? 'Processing was cancelled' : safeMessage(error),
    };
    job.error = job.cancellationRequested ? undefined : { code: error.code || 'REEL_PROCESSING_FAILED', safeMessage: safeMessage(error) };
    job.completedAt = new Date();
    job.attemptCount = Number(job.attemptCount || 0) + 1;
    await job.save();
    if (!job.cancellationRequested) throw error;
    return { cancelled: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function persistWorkerResult(job, result) {
  const candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 100) : [];
  const operations = candidates.map((candidate, index) => ({
    updateOne: {
      filter: { job: job._id, groupNumber: Number(candidate.groupNumber || index + 1) },
      update: {
        $set: {
          status: 'suggested',
          sourceRange: candidate.sourceRange || {},
          frames: (candidate.frames || []).slice(0, 100),
          suggestions: candidate.suggestions || {},
          confidence: candidate.confidence || {},
        },
      },
      upsert: true,
    },
  }));
  if (operations.length) await ReelCandidate.bulkWrite(operations);
}

async function updateJob(job, status, percentage, currentStep, message) {
  job.status = status;
  job.progress = { percentage, currentStep, message };
  if (!job.startedAt) job.startedAt = new Date();
  await job.save();
}

function safeMessage(error) {
  if (error?.name === 'AbortError') return 'Video processing timed out. Please retry with a shorter reel.';
  const allowed = new Set([
    'AI_WORKER_NOT_CONFIGURED', 'NO_USABLE_FRAMES', 'INVALID_VIDEO', 'AI_MODEL_UNAVAILABLE',
    'STORAGE_FAILURE', 'FFMPEG_FAILURE', 'WORKER_TIMEOUT',
  ]);
  return allowed.has(error?.code) ? String(error.message).slice(0, 500) : 'Video processing failed. Please retry or upload a clearer reel.';
}

function safeError(message, code) {
  return Object.assign(new Error(String(message).slice(0, 500)), { code, statusCode: 502 });
}

module.exports = { processReelImportJob, _private: { persistWorkerResult, safeMessage } };
