const fs = require('fs/promises');
const ReelImport = require('./reelImport.model');
const ReelCandidate = require('./reelCandidate.model');
const service = require('./reelImport.service');
const { safeReelImportConfig, reelImportConfig } = require('../../config/reelImport');
const { verifyUploadSignature } = require('../../services/uploadVerification');
const { cleanupTempFiles, deleteMedia, uploadVideo } = require('../../services/mediaStorage');
const { probeVideo } = require('../../services/videoProcessingService');
const { enqueueReelImport, removeQueuedReelImport } = require('../../queues/reelImport.queue');
const { paginationEnvelope, parsePagination } = require('../../utils/requestValidation');
const { safeOriginalFilename } = require('./reelImport.upload');
const { badRequest, objectId, parseProcessingConfig } = require('./reelImport.validation');

async function getConfig(req, res) {
  res.json({ success: true, data: safeReelImportConfig() });
}

async function createImport(req, res, next) {
  let uploaded;
  let job;
  try {
    if (!req.file) throw badRequest('Please select an MP4, MOV, or WebM video', 'VIDEO_REQUIRED');
    await verifyUploadSignature(req.file, 'video');
    const metadata = await probeVideo(req.file.path);
    require('./reelImport.validation').validateProbedVideo(req.file, metadata);
    uploaded = await uploadVideo(req.file, { folder: 'reel-imports/original' });
    job = await ReelImport.create({
      createdBy: req.user._id,
      sourceVideo: {
        provider: uploaded.provider,
        storageKey: uploaded.publicId,
        url: uploaded.url,
        originalFilename: safeOriginalFilename(req.file.originalname),
        mimeType: req.file.detectedMime || req.file.mimetype,
        sizeBytes: req.file.size,
        durationSeconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
      },
      status: 'uploaded',
      progress: { percentage: 1, currentStep: 'Uploaded', message: 'Video uploaded and validated' },
      processingConfig: parseProcessingConfig(req.body),
    });
    try {
      const queued = await enqueueReelImport(job._id);
      job.queueJobId = queued.queueJobId;
      job.status = 'queued';
      job.progress = { percentage: 2, currentStep: 'Queued', message: 'Video is waiting for background processing' };
      await job.save();
    } catch (error) {
      job.status = 'failed';
      job.error = { code: error.code || 'REEL_QUEUE_UNAVAILABLE', safeMessage: 'The processing queue is unavailable. Please retry shortly.' };
      job.progress = { percentage: 1, currentStep: 'Queue unavailable', message: job.error.safeMessage };
      job.completedAt = new Date();
      await job.save();
      throw error;
    }
    return res.status(202).json({ success: true, message: 'Reel import queued', data: { job } });
  } catch (error) {
    if (uploaded && !job) {
      await deleteMedia({ ...uploaded, resourceType: 'video' }).catch(() => null);
    }
    return next(error);
  } finally {
    await cleanupTempFiles(req.file ? [req.file] : []);
  }
}

async function listImports(req, res) {
  const { page, limit, skip, sort } = parsePagination(req.query, {
    defaultLimit: 12,
    maxLimit: 50,
    allowedSorts: ['createdAt', 'updatedAt', 'status'],
  });
  const query = {};
  const allowedStatuses = ['uploading', 'uploaded', 'queued', 'processing', 'review_required', 'creating_drafts', 'completed', 'failed', 'cancelled'];
  if (req.query.status) {
    if (!allowedStatuses.includes(String(req.query.status))) throw badRequest('Invalid reel import status', 'INVALID_REEL_STATUS');
    query.status = String(req.query.status);
  }
  if (req.query.search) {
    const search = String(req.query.search).trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (search) query['sourceVideo.originalFilename'] = { $regex: search, $options: 'i' };
  }
  const [items, total] = await Promise.all([
    ReelImport.find(query).populate('createdBy', 'name email').sort(sort).skip(skip).limit(limit),
    ReelImport.countDocuments(query),
  ]);
  res.json({ success: true, data: paginationEnvelope(items, total, page, limit) });
}

async function getImport(req, res) {
  const job = await service.getJob(req.params.jobId);
  res.json({ success: true, data: { job } });
}

async function listCandidates(req, res) {
  const candidates = await service.getCandidates(req.params.jobId);
  res.json({ success: true, data: { candidates } });
}

async function patchCandidate(req, res) {
  const candidate = await service.updateCandidate(req.params.jobId, req.params.candidateId, req.body);
  res.json({ success: true, message: 'Candidate saved', data: { candidate } });
}

async function mergeCandidates(req, res) {
  const candidate = await service.mergeCandidates(req.params.jobId, req.body.candidateIds);
  res.status(201).json({ success: true, message: 'Product groups merged', data: { candidate } });
}

async function splitCandidate(req, res) {
  const candidate = await service.splitCandidate(req.params.jobId, req.params.candidateId, req.body.frameIds);
  res.status(201).json({ success: true, message: 'Product group split', data: { candidate } });
}

async function moveFrame(req, res) {
  objectId(req.body.targetCandidateId, 'target candidate id');
  objectId(req.body.frameId, 'frame id');
  const candidates = await service.moveFrame(
    req.params.jobId,
    req.params.candidateId,
    req.body.frameId,
    req.body.targetCandidateId,
  );
  res.json({ success: true, message: 'Image moved', data: candidates });
}

async function createDrafts(req, res) {
  const drafts = await service.createDrafts(req.params.jobId, req.body.candidateIds, req.user._id);
  res.status(201).json({ success: true, message: 'Selected product drafts created', data: { drafts } });
}

async function retryImport(req, res) {
  const job = await service.getJob(req.params.jobId);
  if (!['failed', 'cancelled'].includes(job.status)) throw badRequest('Only failed or cancelled imports can be retried', 'REEL_RETRY_NOT_ALLOWED');
  job.status = 'queued';
  job.cancellationRequested = false;
  job.completedAt = undefined;
  job.error = undefined;
  job.progress = { percentage: 2, currentStep: 'Queued', message: 'Video is waiting for background processing' };
  const queued = await enqueueReelImport(job._id);
  job.queueJobId = queued.queueJobId;
  await job.save();
  res.status(202).json({ success: true, message: 'Reel import queued again', data: { job } });
}

async function cancelImport(req, res) {
  const job = await service.getJob(req.params.jobId);
  if (['completed', 'review_required', 'failed', 'cancelled'].includes(job.status)) {
    throw badRequest('This import cannot be cancelled in its current state', 'REEL_CANCEL_NOT_ALLOWED');
  }
  job.cancellationRequested = true;
  if (['uploading', 'uploaded', 'queued'].includes(job.status)) {
    await removeQueuedReelImport(job.queueJobId).catch(() => false);
    job.status = 'cancelled';
    job.completedAt = new Date();
    job.progress = { percentage: Number(job.progress?.percentage || 0), currentStep: 'Cancelled', message: 'Processing was cancelled' };
  } else {
    job.progress.message = 'Cancellation requested. The worker will stop at a safe checkpoint.';
  }
  await job.save();
  res.json({ success: true, message: job.status === 'cancelled' ? 'Import cancelled' : 'Cancellation requested', data: { job } });
}

async function deleteImport(req, res) {
  const job = await service.getJob(req.params.jobId);
  if (['processing', 'creating_drafts'].includes(job.status)) {
    throw badRequest('Cancel processing before deleting this import', 'REEL_DELETE_NOT_ALLOWED');
  }
  await removeQueuedReelImport(job.queueJobId).catch(() => false);
  const candidates = await ReelCandidate.find({ job: job._id });
  const retainedKeys = new Set(candidates.filter((candidate) => candidate.productDraft)
    .flatMap((candidate) => candidate.frames.map((frame) => frame.storageKey)));
  const uniqueFrames = new Map();
  for (const candidate of candidates) {
    for (const frame of candidate.frames) {
      if (!retainedKeys.has(frame.storageKey)) uniqueFrames.set(frame.storageKey, frame);
    }
  }
  await Promise.allSettled([
    deleteMedia({
      provider: job.sourceVideo.provider,
      publicId: job.sourceVideo.storageKey,
      url: job.sourceVideo.url,
      resourceType: 'video',
    }),
    ...[...uniqueFrames.values()].map((frame) => deleteMedia({
      provider: frame.provider,
      publicId: frame.storageKey,
      url: frame.url,
      resourceType: 'image',
    })),
  ]);
  await ReelCandidate.deleteMany({ job: job._id });
  await job.deleteOne();
  res.json({ success: true, message: 'Reel import deleted' });
}

module.exports = {
  cancelImport,
  createDrafts,
  createImport,
  deleteImport,
  getConfig,
  getImport,
  listCandidates,
  listImports,
  mergeCandidates,
  moveFrame,
  patchCandidate,
  retryImport,
  splitCandidate,
};
