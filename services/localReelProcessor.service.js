const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { downloadObject, putBufferToR2, getStorageProvider } = require('./mediaStorage.service');
const { buildPublicUrl, isR2Configured } = require('./r2Upload');

const MAX_FRAMES = 24;
const MAX_PRODUCTS = 8;
const FRAMES_PER_PRODUCT = 3;

function run(binary, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('Video processing timed out.'), { code: 'REEL_WORKER_TIMEOUT' }));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(error.code === 'ENOENT' ? 'FFmpeg is not available for local reel processing.' : error.message), {
        code: 'FFMPEG_UNAVAILABLE',
      }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.slice(-280) || 'FFmpeg failed.'), { code: 'FFMPEG_UNAVAILABLE' }));
    });
  });
}

async function probeVideo(filePath) {
  const { stdout } = await run(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { timeoutMs: 60000 });

  const payload = JSON.parse(stdout || '{}');
  const videoStream = (payload.streams || []).find((stream) => stream.codec_type === 'video') || {};
  const durationSeconds = Number(payload.format?.duration || videoStream.duration || 0);
  return {
    durationSeconds: Math.max(0, Math.round(durationSeconds * 1000) / 1000),
    width: Number(videoStream.width || 0),
    height: Number(videoStream.height || 0),
    codec: String(videoStream.codec_name || ''),
  };
}

async function extractFrames(videoPath, outputDir, fps = 0.5) {
  await fsp.mkdir(outputDir, { recursive: true });
  const safeFps = Math.max(0.4, Math.min(1, Number(fps) || 0.5));
  const pattern = path.join(outputDir, 'frame-%04d.jpg');
  await run(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', videoPath,
    '-vf', `fps=${safeFps},scale=720:-2`,
    '-q:v', '4',
    '-frames:v', String(MAX_FRAMES),
    pattern,
  ], { timeoutMs: 4 * 60 * 1000 });

  const files = (await fsp.readdir(outputDir))
    .filter((name) => /^frame-\d+\.jpg$/i.test(name))
    .sort();
  return files.map((name, index) => ({
    path: path.join(outputDir, name),
    timestampSeconds: index / safeFps,
  }));
}

function chunkFrames(frames) {
  if (!frames.length) return [];
  const groups = [];
  for (let index = 0; index < frames.length; index += FRAMES_PER_PRODUCT) {
    groups.push(frames.slice(index, index + FRAMES_PER_PRODUCT));
    if (groups.length >= MAX_PRODUCTS) break;
  }
  return groups;
}

async function uploadFrame(frame, jobId, groupNumber) {
  if (getStorageProvider() !== 'r2' || !isR2Configured()) {
    throw Object.assign(new Error('Cloud storage is required to save product frames.'), { code: 'STORAGE_FAILURE' });
  }
  const buffer = await fsp.readFile(frame.path);
  const key = `reel-imports/candidates/${jobId}/${String(groupNumber).padStart(3, '0')}-${String(Math.round(frame.timestampSeconds * 1000)).padStart(10, '0')}.jpg`;
  const stored = await putBufferToR2(buffer, key, 'image/jpeg');
  return {
    provider: 'r2',
    storageKey: stored.storageKey,
    url: stored.url || buildPublicUrl(stored.storageKey),
    timestampSeconds: Math.round(frame.timestampSeconds * 1000) / 1000,
    qualityScore: 0.72,
    sharpnessScore: 0.7,
    exposureScore: 0.7,
    visibilityScore: 0.7,
  };
}

async function updateProgress(job, percentage, currentStep, message) {
  job.progress = { percentage, currentStep, message };
  await job.save().catch(() => null);
}

/**
 * Local reel processor used when the Python AI worker is not configured.
 * Extracts a small set of frames with bundled ffmpeg and groups them into review candidates.
 */
async function processReelLocally(job) {
  if (!ffmpegPath || !ffprobePath) {
    throw Object.assign(new Error('FFmpeg is not available for local reel processing.'), { code: 'FFMPEG_UNAVAILABLE' });
  }
  if (!getStorageProvider()) {
    throw Object.assign(new Error('Cloud storage is required for reel processing.'), { code: 'STORAGE_FAILURE' });
  }

  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), `samira-reel-${String(job._id).slice(0, 8)}-`));
  const extension = String(job.sourceVideo?.mimeType || '').includes('webm') ? '.webm' : '.mp4';
  const videoPath = path.join(workspace, `source-video${extension}`);
  const framesDir = path.join(workspace, 'frames');

  try {
    await updateProgress(job, 20, 'Downloading video', 'Fetching the reel from storage.');
    await downloadObject({
      provider: job.sourceVideo.provider,
      storageKey: job.sourceVideo.storageKey,
      url: job.sourceVideo.url,
    }, videoPath);

    await updateProgress(job, 40, 'Reading video', 'Checking duration and extracting product photos.');
    const metadata = await probeVideo(videoPath);
    const frames = await extractFrames(videoPath, framesDir, 0.5);
    if (!frames.length) {
      throw Object.assign(new Error('No usable product frames were detected. Try a clearer, slower reel.'), { code: 'NO_USABLE_FRAMES' });
    }

    await updateProgress(job, 70, 'Saving product photos', `Found ${frames.length} photos. Uploading them for review.`);
    const groups = chunkFrames(frames);
    const candidates = [];
    for (let index = 0; index < groups.length; index += 1) {
      const groupNumber = index + 1;
      const group = groups[index];
      const persisted = [];
      for (const frame of group) {
        const uploaded = await uploadFrame(frame, String(job._id), groupNumber);
        persisted.push({ ...uploaded, selected: persisted.length < 4 });
      }
      candidates.push({
        groupNumber,
        sourceRange: {
          startSeconds: Math.round(group[0].timestampSeconds * 1000) / 1000,
          endSeconds: Math.round(group[group.length - 1].timestampSeconds * 1000) / 1000,
        },
        frames: persisted,
        suggestions: {
          name: `Product ${groupNumber}`,
          category: '',
          subcategory: '',
          primaryColor: '',
          secondaryColors: [],
          pattern: '',
          occasion: [],
          tags: ['reel-import'],
          altText: `Reel product candidate ${groupNumber}`,
        },
        confidence: {
          category: 0,
          primaryColor: 0,
          pattern: 0,
          occasion: 0,
          overall: 0.45,
        },
      });
    }

    return {
      jobId: String(job._id),
      status: 'review_required',
      metadata,
      statistics: {
        extractedFrames: frames.length,
        rejectedFrames: 0,
        duplicateFrames: 0,
        candidateFrames: frames.length,
        detectedProducts: candidates.length,
      },
      candidates,
    };
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true }).catch(() => null);
  }
}

module.exports = {
  processReelLocally,
};
