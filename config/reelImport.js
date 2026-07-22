const TERMINAL_REEL_STATUSES = new Set(['review_required', 'completed', 'failed', 'cancelled']);

function isReelImportEnabled(env = process.env) {
  return String(env.ENABLE_REEL_PRODUCT_IMPORT || '').toLowerCase() === 'true';
}

function reelImportConfig(env = process.env) {
  return {
    enabled: isReelImportEnabled(env),
    maxDurationSeconds: boundedNumber(env.MAX_REEL_DURATION_SECONDS, 180, 5, 1800),
    maxFileSizeMb: boundedNumber(env.MAX_REEL_FILE_SIZE_MB, 250, 1, 2048),
    framesPerSecond: boundedNumber(env.REEL_FRAMES_PER_SECOND, 3, 0.25, 12),
    sceneThreshold: boundedNumber(env.REEL_SCENE_THRESHOLD, 0.30, 0.01, 0.99),
    exactDuplicateSimilarity: boundedNumber(env.REEL_EXACT_DUPLICATE_SIMILARITY, 0.96, 0.5, 1),
    sameProductSimilarity: boundedNumber(env.REEL_SAME_PRODUCT_SIMILARITY, 0.88, 0.5, 1),
    differentProductSimilarity: boundedNumber(env.REEL_DIFFERENT_PRODUCT_SIMILARITY, 0.80, 0.1, 1),
    workerConcurrency: boundedNumber(env.REEL_WORKER_CONCURRENCY, 1, 1, 8, true),
    timeoutMinutes: boundedNumber(env.REEL_PROCESSING_TIMEOUT_MINUTES, 20, 1, 180, true),
    maxAttempts: boundedNumber(env.REEL_JOB_MAX_ATTEMPTS, 3, 1, 10, true),
    originalRetentionDays: boundedNumber(env.REEL_ORIGINAL_RETENTION_DAYS, 30, 1, 365, true),
    rejectedFrameRetentionDays: boundedNumber(env.REEL_REJECTED_FRAME_RETENTION_DAYS, 7, 1, 90, true),
    tempFileRetentionHours: boundedNumber(env.REEL_TEMP_FILE_RETENTION_HOURS, 24, 1, 168, true),
  };
}

function requireReelImportEnabled(req, res, next) {
  if (isReelImportEnabled()) return next();
  return res.status(404).json({ message: 'Not found', code: 'FEATURE_DISABLED' });
}

function safeReelImportConfig(env = process.env) {
  const config = reelImportConfig(env);
  return {
    enabled: config.enabled,
    maxDurationSeconds: config.maxDurationSeconds,
    maxFileSizeMb: config.maxFileSizeMb,
    supportedFormats: ['MP4', 'MOV', 'WebM'],
    pollingIntervalMs: 3000,
  };
}

function boundedNumber(value, fallback, min, max, integer = false) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return integer ? Math.round(parsed) : parsed;
}

module.exports = {
  TERMINAL_REEL_STATUSES,
  isReelImportEnabled,
  reelImportConfig,
  requireReelImportEnabled,
  safeReelImportConfig,
};
