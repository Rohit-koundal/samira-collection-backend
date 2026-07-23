const ReelCandidate = require('../models/ReelCandidate');
const ReelImport = require('../models/ReelImport');
const { getReelImportConfig } = require('../config/reelImport');

async function processReelImportJob({ jobId, storageKey }) {
  const job = await ReelImport.findOne({ _id: jobId, 'sourceVideo.storageKey': storageKey }).select('+sourceVideo.url');
  if (!job) throw processingError('REEL_JOB_NOT_FOUND', 'The reel import job no longer exists.');
  if (job.status === 'cancelled' || job.cancellationRequested) return { cancelled: true };
  if (job.status === 'review_required' || job.status === 'completed') return { idempotent: true };

  const started = Date.now();
  job.status = 'processing';
  job.startedAt = job.startedAt || new Date();
  job.attemptCount += 1;
  job.error = undefined;
  job.progress = { percentage: 10, currentStep: 'Preparing video', message: 'The worker is validating and preparing the reel.' };
  await job.save();

  try {
    const result = await requestAiWorker(job);
    const refreshed = await ReelImport.findById(jobId);
    if (!refreshed || refreshed.status === 'cancelled' || refreshed.cancellationRequested) return { cancelled: true };

    await persistCandidates(refreshed, result.candidates || []);
    refreshed.statistics = {
      ...refreshed.statistics?.toObject?.() || refreshed.statistics || {},
      ...(result.statistics || {}),
      detectedProducts: (result.candidates || []).length,
    };
    refreshed.status = 'review_required';
    refreshed.progress = { percentage: 100, currentStep: 'Ready for review', message: 'Possible products are ready for admin review.' };
    refreshed.completedAt = new Date();
    refreshed.error = undefined;
    await refreshed.save();
    structuredLog('reel_import_completed', jobId, {
      durationMs: Date.now() - started,
      candidates: result.candidates?.length || 0,
    });
    return result;
  } catch (error) {
    const failed = await ReelImport.findById(jobId);
    if (failed && failed.status !== 'cancelled') {
      failed.status = 'failed';
      failed.progress = { percentage: failed.progress?.percentage || 10, currentStep: 'Processing failed', message: safeProcessingMessage(error) };
      failed.error = { code: error.code || 'REEL_PROCESSING_FAILED', safeMessage: safeProcessingMessage(error) };
      failed.completedAt = new Date();
      await failed.save();
    }
    structuredLog('reel_import_failed', jobId, {
      durationMs: Date.now() - started,
      code: error.code || 'REEL_PROCESSING_FAILED',
    });
    throw error;
  }
}

async function requestAiWorker(job) {
  const config = getReelImportConfig();
  const baseUrl = String(process.env.AI_VIDEO_WORKER_URL || '').replace(/\/$/, '');
  const token = process.env.AI_VIDEO_WORKER_SERVICE_TOKEN;
  if (!baseUrl || !token) {
    throw processingError('AI_WORKER_UNAVAILABLE', 'The video processing worker is not configured.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMinutes * 60 * 1000);
  try {
    const response = await fetch(`${baseUrl}/internal/reel-processing/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jobId: String(job._id),
        videoSource: {
          provider: job.sourceVideo.provider,
          storageKey: job.sourceVideo.storageKey,
          url: job.sourceVideo.url,
        },
        processingConfig: job.processingConfig,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw processingError(data.code || 'AI_WORKER_FAILED', data.message || 'Video processing failed.');
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw processingError('REEL_WORKER_TIMEOUT', 'Video processing timed out. You can retry this import.');
    if (error.code) throw error;
    throw processingError('AI_WORKER_UNAVAILABLE', 'The video processing worker could not be reached.');
  } finally {
    clearTimeout(timeout);
  }
}

async function persistCandidates(job, candidates) {
  const existing = await ReelCandidate.countDocuments({ job: job._id });
  if (existing) return;
  if (!candidates.length) throw processingError('NO_USABLE_FRAMES', 'No usable product frames were detected. Try better lighting and slower transitions.');
  await ReelCandidate.insertMany(candidates.map((candidate, index) => ({
    job: job._id,
    groupNumber: index + 1,
    status: 'suggested',
    sourceRange: candidate.sourceRange || {},
    frames: (candidate.frames || []).map((frame, frameIndex) => ({
      ...frame,
      selected: frame.selected ?? frameIndex < 4,
    })),
    suggestions: candidate.suggestions || {},
    confidence: candidate.confidence || {},
    adminOverrides: {},
  })));
}

function safeProcessingMessage(error) {
  const safeCodes = new Set([
    'AI_WORKER_UNAVAILABLE',
    'AI_WORKER_FAILED',
    'REEL_WORKER_TIMEOUT',
    'NO_USABLE_FRAMES',
    'INVALID_VIDEO',
    'FFMPEG_UNAVAILABLE',
    'STORAGE_FAILURE',
  ]);
  if (safeCodes.has(error.code)) return error.message;
  return 'The reel could not be processed. Please retry or upload a clearer video.';
}

function processingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function structuredLog(event, jobId, details = {}) {
  console.log(JSON.stringify({ event, jobId: String(jobId), ...details }));
}

module.exports = { processReelImportJob, processingError, safeProcessingMessage };
