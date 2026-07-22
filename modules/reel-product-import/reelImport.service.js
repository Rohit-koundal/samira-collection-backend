const ReelImport = require('./reelImport.model');
const ReelCandidate = require('./reelCandidate.model');
const ProductDraft = require('../../models/ProductDraft');
const { candidateToDraft } = require('./reelImport.mapper');
const { badRequest, normalizeOverrides, objectId, parseIdList } = require('./reelImport.validation');

async function getJob(jobId) {
  objectId(jobId, 'job id');
  const job = await ReelImport.findById(jobId).populate('createdBy', 'name email');
  if (!job) throw notFound('Reel import job not found');
  return job;
}

async function getCandidates(jobId) {
  await getJob(jobId);
  return ReelCandidate.find({ job: jobId, status: { $ne: 'merged' } })
    .populate('adminOverrides.category', 'name')
    .sort('groupNumber');
}

async function updateCandidate(jobId, candidateId, body = {}) {
  objectId(candidateId, 'candidate id');
  const candidate = await ReelCandidate.findOne({ _id: candidateId, job: jobId });
  if (!candidate) throw notFound('Candidate not found');
  if (candidate.status === 'draft_created') throw badRequest('A created draft cannot be modified here', 'CANDIDATE_LOCKED');
  if (body.adminOverrides !== undefined) candidate.adminOverrides = normalizeOverrides(body.adminOverrides);
  if (body.status !== undefined) {
    if (!['suggested', 'approved', 'ignored'].includes(body.status)) throw badRequest('Invalid candidate status', 'INVALID_CANDIDATE_STATUS');
    candidate.status = body.status;
  }
  if (body.selectedFrameIds !== undefined) {
    const ids = new Set(parseIdList(body.selectedFrameIds, 'selectedFrameIds', { min: 1, max: 4 }));
    candidate.frames.forEach((frame) => { frame.selected = ids.has(String(frame._id)); });
  }
  await candidate.save();
  return candidate;
}

async function mergeCandidates(jobId, candidateIds) {
  const ids = parseIdList(candidateIds, 'candidateIds', { min: 2, max: 20 });
  const candidates = await ReelCandidate.find({ _id: { $in: ids }, job: jobId, status: { $in: ['suggested', 'approved', 'ignored'] } });
  if (candidates.length !== ids.length) throw badRequest('All merge candidates must belong to this active job', 'INVALID_MERGE_SELECTION');
  const existingMerged = await ReelCandidate.findOne({ job: jobId, mergedFrom: { $all: ids, $size: ids.length } });
  if (existingMerged) return existingMerged;
  const framesByKey = new Map();
  candidates.flatMap((candidate) => candidate.frames || []).forEach((frame) => {
    const key = frame.storageKey || frame.url;
    const current = framesByKey.get(key);
    if (!current || Number(frame.qualityScore || 0) > Number(current.qualityScore || 0)) framesByKey.set(key, frame.toObject?.() || frame);
  });
  const frames = [...framesByKey.values()].sort((a, b) => Number(b.qualityScore || 0) - Number(a.qualityScore || 0));
  frames.forEach((frame, index) => { frame.selected = index < 4; delete frame._id; });
  const groupNumber = Number((await ReelCandidate.findOne({ job: jobId }).sort('-groupNumber').select('groupNumber'))?.groupNumber || 0) + 1;
  const strongest = [...candidates].sort((a, b) => Number(b.confidence?.overall || 0) - Number(a.confidence?.overall || 0))[0];
  const merged = await ReelCandidate.create({
    job: jobId,
    groupNumber,
    status: 'suggested',
    sourceRange: {
      startSeconds: Math.min(...candidates.map((candidate) => Number(candidate.sourceRange?.startSeconds || 0))),
      endSeconds: Math.max(...candidates.map((candidate) => Number(candidate.sourceRange?.endSeconds || 0))),
    },
    frames,
    suggestions: strongest.suggestions,
    confidence: strongest.confidence,
    adminOverrides: strongest.adminOverrides,
    mergedFrom: ids,
  });
  await ReelCandidate.updateMany({ _id: { $in: ids }, job: jobId }, { $set: { status: 'merged', mergedInto: merged._id } });
  await refreshDetectedCount(jobId);
  return merged;
}

async function splitCandidate(jobId, candidateId, frameIds) {
  const selectedIds = new Set(parseIdList(frameIds, 'frameIds', { min: 1, max: 100 }));
  const candidate = await ReelCandidate.findOne({ _id: candidateId, job: jobId, status: { $in: ['suggested', 'approved', 'ignored'] } });
  if (!candidate) throw notFound('Candidate not found');
  const moved = candidate.frames.filter((frame) => selectedIds.has(String(frame._id)));
  const remaining = candidate.frames.filter((frame) => !selectedIds.has(String(frame._id)));
  if (!moved.length || !remaining.length) throw badRequest('Split must leave at least one frame in each product', 'INVALID_SPLIT');
  const groupNumber = Number((await ReelCandidate.findOne({ job: jobId }).sort('-groupNumber').select('groupNumber'))?.groupNumber || 0) + 1;
  const created = await ReelCandidate.create({
    job: jobId,
    groupNumber,
    status: 'suggested',
    sourceRange: rangeFromFrames(moved),
    frames: moved.map((frame, index) => ({ ...(frame.toObject?.() || frame), _id: undefined, selected: index < 4 })),
    suggestions: candidate.suggestions,
    confidence: candidate.confidence,
    adminOverrides: candidate.adminOverrides,
  });
  candidate.frames = remaining;
  candidate.sourceRange = rangeFromFrames(remaining);
  await candidate.save();
  await refreshDetectedCount(jobId);
  return created;
}

async function moveFrame(jobId, sourceCandidateId, frameId, targetCandidateId) {
  if (String(sourceCandidateId) === String(targetCandidateId)) throw badRequest('Choose a different target product', 'INVALID_MOVE_TARGET');
  const [source, target] = await Promise.all([
    ReelCandidate.findOne({ _id: sourceCandidateId, job: jobId, status: { $in: ['suggested', 'approved', 'ignored'] } }),
    ReelCandidate.findOne({ _id: targetCandidateId, job: jobId, status: { $in: ['suggested', 'approved', 'ignored'] } }),
  ]);
  if (!source || !target) throw notFound('Source or target candidate not found');
  if (source.frames.length <= 1) throw badRequest('A product group cannot be left empty', 'EMPTY_CANDIDATE');
  const frame = source.frames.id(frameId);
  if (!frame) throw notFound('Frame not found');
  if (!target.frames.some((entry) => entry.storageKey === frame.storageKey)) {
    target.frames.push({ ...(frame.toObject?.() || frame), _id: undefined, selected: false });
  }
  source.frames.pull(frame._id);
  source.sourceRange = rangeFromFrames(source.frames);
  target.sourceRange = rangeFromFrames(target.frames);
  selectBestFrames(source.frames);
  selectBestFrames(target.frames);
  await Promise.all([source.save(), target.save()]);
  return { source, target };
}

async function createDrafts(jobId, candidateIds, userId) {
  const ids = parseIdList(candidateIds, 'candidateIds', { min: 1, max: 100 });
  const job = await getJob(jobId);
  const candidates = await ReelCandidate.find({ _id: { $in: ids }, job: jobId, status: { $ne: 'merged' } });
  if (candidates.length !== ids.length) throw badRequest('One or more candidates are unavailable', 'INVALID_DRAFT_SELECTION');
  job.status = 'creating_drafts';
  job.progress = { percentage: 95, currentStep: 'Creating product drafts', message: 'Saving selected candidates as drafts' };
  await job.save();
  const drafts = [];
  try {
    for (const candidate of candidates) {
      let draft = candidate.productDraft ? await ProductDraft.findById(candidate.productDraft) : null;
      if (!draft) draft = await ProductDraft.findOne({ sourceCandidateId: candidate._id });
      if (!draft) draft = await ProductDraft.create(candidateToDraft(candidate, job, userId));
      candidate.productDraft = draft._id;
      candidate.status = 'draft_created';
      await candidate.save();
      drafts.push(draft);
    }
  } catch (error) {
    job.status = 'review_required';
    job.progress = { percentage: 100, currentStep: 'Ready for review', message: 'Draft creation could not be completed. Review the candidate fields and retry.' };
    await job.save();
    throw error;
  }
  job.statistics.createdDrafts = await ReelCandidate.countDocuments({ job: jobId, productDraft: { $exists: true } });
  job.status = job.statistics.createdDrafts >= job.statistics.detectedProducts ? 'completed' : 'review_required';
  job.progress = { percentage: 100, currentStep: job.status === 'completed' ? 'Completed' : 'Ready for review', message: 'Product drafts created successfully' };
  if (job.status === 'completed') job.completedAt = new Date();
  await job.save();
  return drafts;
}

function selectBestFrames(frames) {
  [...frames].sort((a, b) => Number(b.qualityScore || 0) - Number(a.qualityScore || 0))
    .forEach((frame, index) => { frame.selected = index < 4; });
}

function rangeFromFrames(frames) {
  const timestamps = frames.map((frame) => Number(frame.timestampSeconds || 0));
  return { startSeconds: Math.min(...timestamps), endSeconds: Math.max(...timestamps) };
}

async function refreshDetectedCount(jobId) {
  const count = await ReelCandidate.countDocuments({ job: jobId, status: { $ne: 'merged' } });
  await ReelImport.updateOne({ _id: jobId }, { $set: { 'statistics.detectedProducts': count } });
}

function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404, code: 'NOT_FOUND' });
}

module.exports = {
  createDrafts,
  getCandidates,
  getJob,
  mergeCandidates,
  moveFrame,
  splitCandidate,
  updateCandidate,
  _private: { rangeFromFrames, selectBestFrames },
};
