const fs = require('fs/promises');
const mongoose = require('mongoose');
const path = require('path');
const Category = require('../../models/Category');
const ProductDraft = require('../../models/ProductDraft');
const ReelCandidate = require('../../models/ReelCandidate');
const ReelImport = require('../../models/ReelImport');
const { getReelImportConfig } = require('../../config/reelImport');
const { enqueueReelImport, removeQueuedReelImport } = require('../../queues/reelImport.queue');
const { deleteObject, getStorageProvider, objectExists, uploadOriginalVideo } = require('../../services/mediaStorage.service');
const { inspectVideo } = require('../../services/videoMetadata.service');
const slugify = require('../../utils/slugify');
const {
  escapeRegExp,
  parsePagination,
  safeOriginalFilename,
  validateVideoFile,
  validationError,
} = require('./reelImport.validation');

async function createImport(req, res, next) {
  const file = req.file;
  if (!file && req.body?.sourceVideo) {
    return createImportFromStoredVideo(req, res, next);
  }
  try {
    const fileError = validateVideoFile(file);
    if (fileError) throw fileError;
    const config = getReelImportConfig();
    const metadata = await inspectVideo(file.path);
    if (metadata.durationSeconds > config.maxDurationSeconds) {
      throw validationError('VIDEO_TOO_LONG', `Video duration must be ${config.maxDurationSeconds} seconds or less.`);
    }

    const stored = await uploadOriginalVideo(file);
    const retentionExpiresAt = new Date(Date.now() + config.originalRetentionDays * 86400000);
    let reelImport;
    try {
      reelImport = await ReelImport.create({
        createdBy: req.user._id,
        sourceVideo: {
          ...stored,
          originalFilename: safeOriginalFilename(file.originalname),
          mimeType: file.mimetype,
          sizeBytes: file.size,
          ...metadata,
        },
        status: 'uploaded',
        progress: { percentage: 5, currentStep: 'Validating video', message: 'Video uploaded and validated.' },
        processingConfig: {
          framesPerSecond: config.framesPerSecond,
          sceneThreshold: config.sceneThreshold,
          duplicateThreshold: config.exactDuplicateSimilarity,
          clusteringThreshold: config.sameProductSimilarity,
        },
        retentionExpiresAt,
      });
      await enqueueReelImport({ jobId: reelImport._id, storageKey: stored.storageKey });
      reelImport.status = 'queued';
      reelImport.progress = { percentage: 8, currentStep: 'Queued', message: 'The reel is waiting for the processing worker.' };
      await reelImport.save();
    } catch (error) {
      if (reelImport) {
        reelImport.status = 'failed';
        reelImport.error = { code: error.code || 'REEL_QUEUE_UNAVAILABLE', safeMessage: error.message };
        await reelImport.save().catch(() => null);
      } else {
        await deleteObject(stored).catch(() => null);
      }
      throw error;
    }
    return res.status(202).json({ success: true, data: formatJob(reelImport) });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    return next(error);
  } finally {
    if (file?.path) await fs.unlink(file.path).catch(() => null);
  }
}

async function createImportFromStoredVideo(req, res, next) {
  try {
    const source = req.body.sourceVideo || {};
    const config = getReelImportConfig();
    const provider = getStorageProvider();
    const sizeBytes = Number(source.sizeBytes || 0);
    if (!provider || provider !== source.provider || !source.storageKey) {
      throw validationError('INVALID_STORAGE_REFERENCE', 'The uploaded video does not have a valid storage reference.');
    }
    if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(String(source.mimeType || '').toLowerCase())) {
      throw validationError('UNSUPPORTED_VIDEO_FORMAT', 'Only MP4, MOV, and WebM videos are supported.');
    }
    if (!sizeBytes || sizeBytes > config.maxFileSizeMb * 1024 * 1024) {
      throw validationError('VIDEO_TOO_LARGE', `The reel must be ${config.maxFileSizeMb}MB or smaller.`);
    }
    const storedVideo = {
      provider,
      storageKey: String(source.storageKey),
      url: String(source.url || ''),
    };
    if (!await objectExists(storedVideo)) {
      throw validationError('STORED_VIDEO_NOT_FOUND', 'The uploaded video could not be found in R2.');
    }
    const existing = await ReelImport.findOne({
      createdBy: req.user._id,
      'sourceVideo.storageKey': storedVideo.storageKey,
    });
    if (existing) return res.status(200).json({ success: true, data: formatJob(existing) });

    const reelImport = await ReelImport.create({
      createdBy: req.user._id,
      sourceVideo: {
        ...storedVideo,
        originalFilename: safeOriginalFilename(source.originalFilename),
        mimeType: source.mimeType,
        sizeBytes,
        durationSeconds: 0,
      },
      status: 'uploaded',
      progress: { percentage: 5, currentStep: 'Validating video', message: 'R2 upload verified. Preparing background processing.' },
      processingConfig: {
        framesPerSecond: config.framesPerSecond,
        sceneThreshold: config.sceneThreshold,
        duplicateThreshold: config.exactDuplicateSimilarity,
        clusteringThreshold: config.sameProductSimilarity,
      },
      retentionExpiresAt: new Date(Date.now() + config.originalRetentionDays * 86400000),
    });
    try {
      await enqueueReelImport({ jobId: reelImport._id, storageKey: storedVideo.storageKey });
      reelImport.status = 'queued';
      reelImport.progress = { percentage: 8, currentStep: 'Queued', message: 'The reel is waiting for the processing worker.' };
      await reelImport.save();
    } catch (error) {
      reelImport.status = 'failed';
      reelImport.progress = { percentage: 5, currentStep: 'Processing unavailable', message: 'The video is safely stored in R2 and can be retried.' };
      reelImport.error = {
        code: error.code || 'REEL_QUEUE_UNAVAILABLE',
        safeMessage: 'The video was uploaded, but background processing is not available yet. Configure the worker and retry.',
      };
      await reelImport.save();
      return res.status(202).json({
        success: true,
        data: formatJob(reelImport),
        warning: reelImport.error.safeMessage,
      });
    }
    return res.status(202).json({ success: true, data: formatJob(reelImport) });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    return next(error);
  }
}

async function getUploadCapabilities(req, res) {
  const config = getReelImportConfig();
  res.json({
    success: true,
    data: {
      directUploadSupported: false,
      uploadEndpoint: '/admin/reel-imports',
      formats: ['MP4', 'MOV', 'WebM'],
      maxDurationSeconds: config.maxDurationSeconds,
      maxFileSizeMb: config.maxFileSizeMb,
    },
  });
}

async function listImports(req, res) {
  const { page, limit, skip } = parsePagination(req.query);
  const query = { createdBy: req.user._id };
  const allowedStatuses = ReelImport.schema.path('status').enumValues;
  if (req.query.status && allowedStatuses.includes(req.query.status)) query.status = req.query.status;
  if (req.query.search) {
    query['sourceVideo.originalFilename'] = { $regex: escapeRegExp(req.query.search).slice(0, 100), $options: 'i' };
  }
  const [items, total] = await Promise.all([
    ReelImport.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ReelImport.countDocuments(query),
  ]);
  res.json({
    success: true,
    data: items.map(formatJob),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

async function getImport(req, res) {
  const job = await findOwnedJob(req);
  if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
  res.json({ success: true, data: formatJob(job) });
}

async function listCandidates(req, res) {
  const job = await findOwnedJob(req);
  if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
  const candidates = await ReelCandidate.find({ job: job._id }).sort({ groupNumber: 1 });
  res.json({ success: true, data: candidates.map(formatCandidate) });
}

async function retryImport(req, res, next) {
  try {
    const job = await findOwnedJob(req, '+sourceVideo.url');
    if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
    if (!['failed', 'cancelled'].includes(job.status)) {
      return res.status(409).json({ success: false, message: 'Only failed or cancelled imports can be retried.' });
    }
    job.status = 'queued';
    job.cancellationRequested = false;
    job.completedAt = undefined;
    job.error = undefined;
    job.progress = { percentage: 8, currentStep: 'Queued', message: 'Retry queued.' };
    await job.save();
    try {
      await enqueueReelImport({ jobId: job._id, storageKey: job.sourceVideo.storageKey });
    } catch (error) {
      job.status = 'failed';
      job.error = { code: error.code || 'REEL_QUEUE_UNAVAILABLE', safeMessage: error.message };
      await job.save();
      throw error;
    }
    res.status(202).json({ success: true, data: formatJob(job) });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    next(error);
  }
}

async function cancelImport(req, res) {
  const job = await findOwnedJob(req);
  if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
  if (['completed', 'review_required'].includes(job.status)) {
    return res.status(409).json({ success: false, message: 'This import has already finished processing.' });
  }
  await removeQueuedReelImport(job._id).catch(() => false);
  job.cancellationRequested = true;
  job.status = 'cancelled';
  job.progress = { percentage: job.progress?.percentage || 0, currentStep: 'Cancelled', message: 'Processing was cancelled.' };
  job.completedAt = new Date();
  await job.save();
  res.json({ success: true, data: formatJob(job) });
}

async function deleteImport(req, res, next) {
  try {
    const job = await findOwnedJob(req, '+sourceVideo.url');
    if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
    if (['processing', 'creating_drafts'].includes(job.status)) {
      return res.status(409).json({ success: false, message: 'Cancel processing before deleting this import.' });
    }
    const hasDraft = await ReelCandidate.exists({ job: job._id, productDraft: { $ne: null } });
    if (hasDraft) return res.status(409).json({ success: false, message: 'Imports linked to product drafts cannot be deleted.' });
    await deleteObject(job.sourceVideo).catch(() => false);
    await ReelCandidate.deleteMany({ job: job._id });
    await job.deleteOne();
    res.json({ success: true, message: 'Reel import deleted.' });
  } catch (error) {
    next(error);
  }
}

async function updateCandidate(req, res) {
  const context = await findOwnedCandidate(req);
  if (!context) return res.status(404).json({ success: false, message: 'Candidate not found.' });
  const { candidate } = context;
  const body = req.body || {};
  if (body.status && ['suggested', 'approved', 'ignored'].includes(body.status)) candidate.status = body.status;
  if (body.suggestions && typeof body.suggestions === 'object') {
    candidate.suggestions = { ...candidate.suggestions?.toObject?.() || candidate.suggestions || {}, ...pickSuggestions(body.suggestions) };
  }
  if (body.adminOverrides && typeof body.adminOverrides === 'object') {
    candidate.adminOverrides = { ...(candidate.adminOverrides || {}), ...pickAdminOverrides(body.adminOverrides) };
  }
  if (Array.isArray(body.selectedFrameIds)) {
    const selected = new Set(body.selectedFrameIds.map(String));
    candidate.frames.forEach((frame) => { frame.selected = selected.has(String(frame._id)); });
  }
  candidate.audit.push({ action: 'updated', by: req.user._id, details: { fields: Object.keys(body) } });
  await candidate.save();
  res.json({ success: true, data: formatCandidate(candidate) });
}

async function mergeCandidates(req, res) {
  const ids = uniqueIds(req.body?.candidateIds);
  if (ids.length < 2) return res.status(400).json({ success: false, message: 'Select at least two candidates to merge.' });
  const job = await findOwnedJob(req);
  if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
  const candidates = await ReelCandidate.find({ _id: { $in: ids }, job: job._id, status: { $ne: 'merged' } });
  if (candidates.length !== ids.length) return res.status(400).json({ success: false, message: 'One or more candidates cannot be merged.' });
  if (candidates.some((item) => item.productDraft)) {
    return res.status(409).json({ success: false, message: 'A candidate linked to a draft cannot be merged.' });
  }
  const maxGroup = await ReelCandidate.findOne({ job: job._id }).sort({ groupNumber: -1 }).select('groupNumber');
  const frames = selectBestFrames(dedupeFrames(candidates.flatMap((candidate) => candidate.frames)));
  const best = [...candidates].sort((a, b) => Number(b.confidence?.overall || 0) - Number(a.confidence?.overall || 0))[0];
  const merged = await ReelCandidate.create({
    job: job._id,
    groupNumber: Number(maxGroup?.groupNumber || 0) + 1,
    status: 'suggested',
    sourceRange: calculateRange(frames),
    frames,
    suggestions: best.suggestions,
    confidence: best.confidence,
    adminOverrides: Object.assign({}, ...candidates.map((item) => item.adminOverrides || {})),
    mergedFrom: candidates.map((item) => item._id),
    audit: [{ action: 'merged', by: req.user._id, details: { sources: candidates.map((item) => String(item._id)) } }],
  });
  await ReelCandidate.updateMany({ _id: { $in: ids } }, {
    $set: { status: 'merged', mergedInto: merged._id },
    $push: { audit: { action: 'merged_into', by: req.user._id, at: new Date(), details: { target: String(merged._id) } } },
  });
  res.status(201).json({ success: true, data: formatCandidate(merged) });
}

async function splitCandidate(req, res) {
  const context = await findOwnedCandidate(req);
  if (!context) return res.status(404).json({ success: false, message: 'Candidate not found.' });
  const { job, candidate } = context;
  if (candidate.productDraft || candidate.status === 'merged') {
    return res.status(409).json({ success: false, message: 'This candidate cannot be split.' });
  }
  const selectedIds = new Set(uniqueIds(req.body?.frameIds));
  const timestamp = Number(req.body?.fromTimestamp);
  const moved = candidate.frames.filter((frame) => (
    selectedIds.size ? selectedIds.has(String(frame._id)) : Number.isFinite(timestamp) && frame.timestampSeconds >= timestamp
  ));
  const remaining = candidate.frames.filter((frame) => !moved.some((selected) => String(selected._id) === String(frame._id)));
  if (!moved.length || !remaining.length) {
    return res.status(400).json({ success: false, message: 'A split must leave at least one frame in both products.' });
  }
  const maxGroup = await ReelCandidate.findOne({ job: job._id }).sort({ groupNumber: -1 }).select('groupNumber');
  candidate.frames = selectBestFrames(remaining);
  candidate.sourceRange = calculateRange(candidate.frames);
  candidate.audit.push({ action: 'split_source', by: req.user._id, details: { movedFrames: moved.length } });
  await candidate.save();
  const created = await ReelCandidate.create({
    job: job._id,
    groupNumber: Number(maxGroup?.groupNumber || 0) + 1,
    status: 'suggested',
    sourceRange: calculateRange(moved),
    frames: selectBestFrames(moved),
    suggestions: candidate.suggestions,
    confidence: candidate.confidence,
    adminOverrides: {},
    audit: [{ action: 'split_created', by: req.user._id, details: { source: String(candidate._id) } }],
  });
  res.status(201).json({ success: true, data: { source: formatCandidate(candidate), created: formatCandidate(created) } });
}

async function moveFrame(req, res) {
  const context = await findOwnedCandidate(req);
  if (!context) return res.status(404).json({ success: false, message: 'Candidate not found.' });
  const { job, candidate: source } = context;
  const target = await ReelCandidate.findOne({ _id: req.body?.targetCandidateId, job: job._id, status: { $nin: ['merged', 'draft_created'] } });
  if (!target) return res.status(404).json({ success: false, message: 'Target candidate not found.' });
  const frame = source.frames.id(req.body?.frameId);
  if (!frame) return res.status(404).json({ success: false, message: 'Frame not found.' });
  const plainFrame = frame.toObject();
  frame.deleteOne();
  target.frames.push(plainFrame);
  source.frames = selectBestFrames(source.frames);
  target.frames = selectBestFrames(dedupeFrames(target.frames));
  source.sourceRange = calculateRange(source.frames);
  target.sourceRange = calculateRange(target.frames);
  if (!source.frames.length) source.status = 'ignored';
  source.audit.push({ action: 'frame_moved_out', by: req.user._id, details: { target: String(target._id) } });
  target.audit.push({ action: 'frame_moved_in', by: req.user._id, details: { source: String(source._id) } });
  await Promise.all([source.save(), target.save()]);
  res.json({ success: true, data: { source: formatCandidate(source), target: formatCandidate(target) } });
}

async function createDrafts(req, res, next) {
  try {
    const job = await findOwnedJob(req);
    if (!job) return res.status(404).json({ success: false, message: 'Reel import not found.' });
    const requested = uniqueIds(req.body?.candidateIds);
    const query = {
      job: job._id,
      status: { $nin: ['ignored', 'merged'] },
      ...(requested.length ? { _id: { $in: requested } } : {}),
    };
    const candidates = await ReelCandidate.find(query);
    if (!candidates.length) return res.status(400).json({ success: false, message: 'Select at least one candidate.' });
    job.status = 'creating_drafts';
    job.progress = { percentage: 95, currentStep: 'Creating product drafts', message: 'Saving selected candidates as drafts.' };
    await job.save();
    const drafts = [];
    for (const candidate of candidates) {
      const draft = await createDraftForCandidate(job, candidate, req.user._id);
      drafts.push(draft);
    }
    job.statistics.createdDrafts = await ReelCandidate.countDocuments({ job: job._id, productDraft: { $ne: null } });
    job.status = 'completed';
    job.progress = { percentage: 100, currentStep: 'Completed', message: 'Selected product drafts were created.' };
    job.completedAt = new Date();
    await job.save();
    res.status(201).json({ success: true, data: { drafts: drafts.map(formatDraftReference), job: formatJob(job) } });
  } catch (error) {
    next(error);
  }
}

async function createDraftForCandidate(job, candidate, userId) {
  if (candidate.productDraft) {
    const existing = await ProductDraft.findById(candidate.productDraft);
    if (existing) return existing;
  }
  const duplicate = await ProductDraft.findOne({ sourceCandidateId: candidate._id });
  if (duplicate) {
    candidate.productDraft = duplicate._id;
    candidate.status = 'draft_created';
    await candidate.save();
    return duplicate;
  }
  const overrides = candidate.adminOverrides || {};
  const suggestions = candidate.suggestions || {};
  const name = String(overrides.name || suggestions.name || `Reel product ${candidate.groupNumber}`).trim();
  const selectedFrames = candidate.frames.filter((frame) => frame.selected);
  const frames = (selectedFrames.length ? selectedFrames : candidate.frames.slice(0, 4));
  const category = await resolveCategory(overrides.category || suggestions.category);
  const colors = listValue(overrides.colors || overrides.primaryColor || suggestions.primaryColor);
  const sizes = listValue(overrides.sizes);
  const tags = listValue(overrides.tags || suggestions.tags);
  const price = numberOrZero(overrides.price || overrides.sellingPrice);
  const originalPrice = numberOrZero(overrides.originalPrice || price);
  const draft = await ProductDraft.create({
    name,
    slug: `${slugify(name || 'reel-product')}-${String(candidate._id).slice(-6)}`,
    sku: '',
    image: frames[0]?.url || '',
    images: frames.map((frame, index) => ({ url: frame.url, publicId: frame.storageKey, primary: index === 0 })),
    videos: [],
    category: category?._id,
    subCategory: overrides.subCategory || suggestions.subcategory || '',
    price,
    originalPrice,
    sellingPrice: price,
    stock: numberOrZero(overrides.stock),
    sizes,
    colors,
    fabric: '',
    occasion: listValue(overrides.occasion || suggestions.occasion).join(', '),
    tags,
    description: String(overrides.description || ''),
    highlights: [],
    status: 'draft',
    createdBy: userId,
    sourceType: 'reel-import',
    sourceJobId: job._id,
    sourceCandidateId: candidate._id,
  });
  candidate.productDraft = draft._id;
  candidate.status = 'draft_created';
  candidate.audit.push({ action: 'draft_created', by: userId, details: { draft: String(draft._id) } });
  await candidate.save();
  return draft;
}

async function resolveCategory(value) {
  if (!value) return null;
  if (mongoose.isValidObjectId(value)) return Category.findById(value);
  return Category.findOne({ name: { $regex: `^${escapeRegExp(String(value).trim())}$`, $options: 'i' } });
}

async function findOwnedJob(req, select = '') {
  if (!mongoose.isValidObjectId(req.params.jobId)) return null;
  return ReelImport.findOne({ _id: req.params.jobId, createdBy: req.user._id }).select(select);
}

async function findOwnedCandidate(req) {
  const job = await findOwnedJob(req);
  if (!job || !mongoose.isValidObjectId(req.params.candidateId)) return null;
  const candidate = await ReelCandidate.findOne({ _id: req.params.candidateId, job: job._id });
  return candidate ? { job, candidate } : null;
}

function dedupeFrames(frames) {
  const seen = new Set();
  return frames.filter((frame) => {
    const key = String(frame.storageKey || frame.url || frame._id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((frame) => frame.toObject ? frame.toObject() : { ...frame });
}

function selectBestFrames(frames) {
  const sorted = [...frames].sort((a, b) => Number(b.qualityScore || 0) - Number(a.qualityScore || 0));
  const selectedKeys = new Set(sorted.slice(0, 4).map((frame) => String(frame.storageKey || frame.url || frame._id)));
  return sorted.map((frame) => ({
    ...(frame.toObject ? frame.toObject() : frame),
    selected: selectedKeys.has(String(frame.storageKey || frame.url || frame._id)),
  }));
}

function calculateRange(frames) {
  const times = frames.map((frame) => Number(frame.timestampSeconds)).filter(Number.isFinite);
  return { startSeconds: times.length ? Math.min(...times) : 0, endSeconds: times.length ? Math.max(...times) : 0 };
}

function pickSuggestions(value) {
  return pick(value, ['name', 'category', 'subcategory', 'primaryColor', 'secondaryColors', 'pattern', 'occasion', 'tags', 'altText']);
}

function pickAdminOverrides(value) {
  return pick(value, ['name', 'category', 'subCategory', 'primaryColor', 'colors', 'pattern', 'occasion', 'tags', 'description', 'price', 'originalPrice', 'sellingPrice', 'sizes', 'stock']);
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(source, key)).map((key) => [key, source[key]]));
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(mongoose.isValidObjectId))];
}

function listValue(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function formatJob(job) {
  const data = job.toObject ? job.toObject() : { ...job };
  delete data.sourceVideo?.url;
  data.id = String(data._id);
  return data;
}

function formatCandidate(candidate) {
  const data = candidate.toObject ? candidate.toObject() : { ...candidate };
  data.id = String(data._id);
  return data;
}

function formatDraftReference(draft) {
  return { id: String(draft._id), name: draft.name, status: draft.status };
}

module.exports = {
  cancelImport,
  createDrafts,
  createImport,
  deleteImport,
  getImport,
  getUploadCapabilities,
  listCandidates,
  listImports,
  mergeCandidates,
  moveFrame,
  retryImport,
  splitCandidate,
  updateCandidate,
};
