const { spawn } = require('child_process');

async function probeVideo(filePath, { timeoutMs = 20_000 } = {}) {
  const executable = process.env.FFPROBE_PATH || 'ffprobe';
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
  const output = await spawnCaptured(executable, args, timeoutMs);
  let metadata;
  try {
    metadata = JSON.parse(output);
  } catch {
    throw videoError('Video metadata could not be read', 'CORRUPT_VIDEO', 400);
  }
  const stream = (metadata.streams || []).find((entry) => entry.codec_type === 'video');
  const durationSeconds = Number(stream?.duration || metadata.format?.duration || 0);
  if (!stream || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw videoError('Uploaded video is empty or corrupt', 'CORRUPT_VIDEO', 400);
  }
  return {
    durationSeconds,
    width: Number(stream.width || 0),
    height: Number(stream.height || 0),
    codec: String(stream.codec_name || ''),
    format: String(metadata.format?.format_name || ''),
  };
}

function spawnCaptured(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(processorUnavailable(error));
      return;
    }
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(videoError('Video validation timed out', 'VIDEO_PROBE_TIMEOUT', 408));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) child.kill('SIGKILL');
    });
    child.stderr.on('data', () => {});
    child.on('error', (error) => finish(processorUnavailable(error)));
    child.on('close', (code) => {
      if (code !== 0) return finish(videoError('Uploaded video could not be validated', 'CORRUPT_VIDEO', 400));
      return finish(null, stdout);
    });
  });
}

function processorUnavailable(cause) {
  const error = videoError('Video processing service is not available', 'VIDEO_PROCESSOR_UNAVAILABLE', 503);
  error.cause = cause;
  return error;
}

function videoError(message, code, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

module.exports = { probeVideo, _private: { spawnCaptured } };
