const mongoose = require('mongoose');
const { reelImportConfig } = require('../../config/reelImport');

function validateProbedVideo(file, metadata) {
  const config = reelImportConfig();
  if (!file || !Number(file.size)) throw badRequest('Please upload a non-empty video', 'EMPTY_VIDEO');
  if (file.size > config.maxFileSizeMb * 1024 * 1024) throw badRequest('Video exceeds the configured file-size limit', 'VIDEO_TOO_LARGE');
  if (!metadata?.durationSeconds || metadata.durationSeconds > config.maxDurationSeconds) {
    throw badRequest('Video duration must be ' + config.maxDurationSeconds + ' seconds or less', 'VIDEO_TOO_LONG');
  }
  if (!metadata.width || !metadata.height) throw badRequest('Video dimensions could not be read', 'CORRUPT_VIDEO');
  return metadata;
}

function parseProcessingConfig(body = {}) {
  const defaults = reelImportConfig();
  return {
    framesPerSecond: bounded(body.framesPerSecond, defaults.framesPerSecond, 0.25, 12),
    sceneThreshold: bounded(body.sceneThreshold, defaults.sceneThreshold, 0.01, 0.99),
    duplicateThreshold: bounded(body.duplicateThreshold, defaults.exactDuplicateSimilarity, 0.5, 1),
    clusteringThreshold: bounded(body.clusteringThreshold, defaults.sameProductSimilarity, 0.5, 1),
  };
}

function normalizeOverrides(value = {}) {
  const allowed = {};
  for (const field of ['name', 'subCategory', 'primaryColor', 'pattern', 'occasion']) {
    if (value[field] !== undefined) allowed[field] = cleanText(value[field], field === 'name' ? 160 : 120);
  }
  if (value.category !== undefined && value.category !== '') allowed.category = objectId(value.category, 'category');
  for (const field of ['price', 'originalPrice', 'stock']) {
    if (value[field] !== undefined && value[field] !== '') {
      const number = Number(value[field]);
      if (!Number.isFinite(number) || number < 0 || (field === 'stock' && !Number.isInteger(number))) {
        throw badRequest(field + ' is invalid', 'INVALID_CANDIDATE_OVERRIDE');
      }
      allowed[field] = number;
    }
  }
  for (const field of ['tags', 'sizes']) {
    if (value[field] !== undefined) allowed[field] = cleanList(value[field], field === 'tags' ? 20 : 30);
  }
  return allowed;
}

function parseIdList(value, field, { min = 1, max = 100 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw badRequest(field + ' must contain between ' + min + ' and ' + max + ' items', 'INVALID_ID_LIST');
  }
  return [...new Set(value.map((entry) => objectId(entry, field)))];
}

function objectId(value, field = 'id') {
  const text = String(value || '');
  if (!mongoose.isValidObjectId(text)) throw badRequest('Invalid ' + field, 'INVALID_OBJECT_ID');
  return text;
}

function cleanList(value, maxItems) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(entries.map((entry) => cleanText(entry, 100)).filter(Boolean))].slice(0, maxItems);
}

function cleanText(value, max) {
  return String(value || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function bounded(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw badRequest('Processing configuration is invalid', 'INVALID_PROCESSING_CONFIG');
  return number;
}

function badRequest(message, code) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

module.exports = {
  badRequest,
  cleanList,
  cleanText,
  normalizeOverrides,
  objectId,
  parseIdList,
  parseProcessingConfig,
  validateProbedVideo,
};
