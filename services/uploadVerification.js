const fs = require('fs/promises');
const path = require('path');

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const MODEL_TYPES = new Set(['model/gltf-binary', 'model/vnd.usdz+zip']);
const MAX_USDZ_ENTRIES = 256;
const SAFE_USDZ_EXTENSIONS = new Set([
  '.usd',
  '.usda',
  '.usdc',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.tif',
  '.tiff',
  '.exr',
  '.hdr',
]);

async function verifyUploadSignature(file, expectedKind) {
  if (expectedKind === 'model') return verifyModelFile(file);

  const handle = await fs.open(file.path, 'r');
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const detected = detectType(buffer.subarray(0, bytesRead));
    const allowed = expectedKind === 'image' ? IMAGE_TYPES : VIDEO_TYPES;
    if (!detected || !allowed.has(detected.mime)) throw signatureError(expectedKind);
    file.detectedMime = detected.mime;
    file.detectedExtension = detected.extension;
    return detected;
  } finally {
    await handle.close();
  }
}

async function verifyModelFile(file) {
  const requestedExtension = String(
    file.requestedModelExtension || path.extname(String(file.originalname || '')).slice(1),
  ).toLowerCase();
  if (!['glb', 'usdz'].includes(requestedExtension)) throw signatureError('model');

  const buffer = await fs.readFile(file.path);
  const detected = detectType(buffer.subarray(0, Math.min(buffer.length, 64)));
  if (!detected || !MODEL_TYPES.has(detected.mime) || detected.extension !== requestedExtension) {
    throw signatureError('model');
  }
  if (requestedExtension === 'glb') validateGlbBuffer(buffer);
  else validateUsdzBuffer(buffer);

  file.detectedMime = detected.mime;
  file.detectedExtension = detected.extension;
  return detected;
}

function detectType(buffer) {
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'glTF') {
    return { mime: 'model/gltf-binary', extension: 'glb' };
  }
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    return { mime: 'model/vnd.usdz+zip', extension: 'usdz' };
  }
  if (buffer.length >= 12
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff) return { mime: 'image/jpeg', extension: 'jpg' };
  if (buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  if (buffer.length >= 4
    && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mime: 'video/webm', extension: 'webm' };
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand === 'qt  ') return { mime: 'video/quicktime', extension: 'mov' };
    return { mime: 'video/mp4', extension: 'mp4' };
  }
  return null;
}

function validateGlbBuffer(buffer) {
  if (buffer.length < 20
    || buffer.subarray(0, 4).toString('ascii') !== 'glTF'
    || buffer.readUInt32LE(4) !== 2
    || buffer.readUInt32LE(8) !== buffer.length) {
    throw signatureError('GLB model');
  }

  let cursor = 12;
  let chunkIndex = 0;
  let json;
  while (cursor < buffer.length) {
    if (cursor + 8 > buffer.length) throw signatureError('GLB model');
    const chunkLength = buffer.readUInt32LE(cursor);
    const chunkType = buffer.readUInt32LE(cursor + 4);
    const chunkStart = cursor + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkLength % 4 !== 0 || chunkEnd > buffer.length) throw signatureError('GLB model');
    if (chunkIndex === 0 && chunkType !== 0x4e4f534a) throw signatureError('GLB model');
    if (chunkIndex > 1 || (chunkIndex === 1 && chunkType !== 0x004e4942)) {
      throw unsafeModelError('GLB contains unsupported chunks');
    }
    if (chunkIndex === 0) {
      try {
        const jsonText = buffer.subarray(chunkStart, chunkEnd).toString('utf8').replace(/[\u0000 ]+$/g, '');
        json = JSON.parse(jsonText);
      } catch {
        throw signatureError('GLB model');
      }
    }
    chunkIndex += 1;
    cursor = chunkEnd;
  }
  if (cursor !== buffer.length || chunkIndex < 1 || !json || typeof json !== 'object') {
    throw signatureError('GLB model');
  }
  if (json.asset?.version !== '2.0') throw unsafeModelError('GLB must declare glTF 2.0');
  if ((json.buffers || []).some((entry) => entry?.uri)) {
    throw unsafeModelError('GLB must embed its binary resources');
  }
  if ((json.images || []).some((entry) => entry?.uri && !isSafeEmbeddedImage(entry.uri))) {
    throw unsafeModelError('GLB contains an unsafe external image reference');
  }
  return true;
}

function validateUsdzBuffer(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw signatureError('USDZ model');
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw signatureError('USDZ model');

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries
    || totalEntries < 1 || totalEntries > MAX_USDZ_ENTRIES
    || totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || centralOffset + centralSize !== eocdOffset) {
    throw unsafeModelError('USDZ archive structure is unsupported');
  }

  const seenNames = new Set();
  const localRanges = [];
  let centralCursor = centralOffset;
  let containsUsdAsset = false;
  let totalAssetBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (centralCursor + 46 > eocdOffset || buffer.readUInt32LE(centralCursor) !== 0x02014b50) {
      throw signatureError('USDZ model');
    }
    const flags = buffer.readUInt16LE(centralCursor + 8);
    const compressionMethod = buffer.readUInt16LE(centralCursor + 10);
    const compressedSize = buffer.readUInt32LE(centralCursor + 20);
    const uncompressedSize = buffer.readUInt32LE(centralCursor + 24);
    const nameLength = buffer.readUInt16LE(centralCursor + 28);
    const extraLength = buffer.readUInt16LE(centralCursor + 30);
    const commentLength = buffer.readUInt16LE(centralCursor + 32);
    const startDisk = buffer.readUInt16LE(centralCursor + 34);
    const externalAttributes = buffer.readUInt32LE(centralCursor + 38);
    const localOffset = buffer.readUInt32LE(centralCursor + 42);
    const centralEntryEnd = centralCursor + 46 + nameLength + extraLength + commentLength;
    if (centralEntryEnd > eocdOffset || nameLength < 1 || nameLength > 512
      || startDisk !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
      || compressionMethod !== 0 || compressedSize !== uncompressedSize
      || (flags & 0x0009) !== 0) {
      throw unsafeModelError('USDZ entries must be unencrypted and uncompressed');
    }

    const nameBytes = buffer.subarray(centralCursor + 46, centralCursor + 46 + nameLength);
    const name = decodeZipName(nameBytes, flags);
    validateArchivePath(name);
    const foldedName = name.toLowerCase();
    if (seenNames.has(foldedName)) throw unsafeModelError('USDZ contains duplicate asset paths');
    seenNames.add(foldedName);

    const isDirectory = name.endsWith('/');
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0xf000;
    if (unixType === 0xa000 || (unixType && unixType !== 0x8000 && unixType !== 0x4000)) {
      throw unsafeModelError('USDZ contains an unsupported filesystem entry');
    }
    if (!isDirectory) {
      const extension = path.posix.extname(foldedName);
      if (!SAFE_USDZ_EXTENSIONS.has(extension)) {
        throw unsafeModelError('USDZ contains an unsupported asset type');
      }
      if (['.usd', '.usda', '.usdc'].includes(extension)) containsUsdAsset = true;
      totalAssetBytes += uncompressedSize;
      if (!Number.isSafeInteger(totalAssetBytes) || totalAssetBytes > 60 * 1024 * 1024) {
        throw unsafeModelError('USDZ expanded content exceeds the safety limit');
      }
    }

    const localRange = validateLocalZipEntry(buffer, {
      centralOffset,
      compressedSize,
      compressionMethod,
      flags,
      localOffset,
      nameBytes,
    });
    localRanges.push(localRange);
    centralCursor = centralEntryEnd;
  }
  if (centralCursor !== eocdOffset || !containsUsdAsset) {
    throw unsafeModelError('USDZ must contain a USD scene asset');
  }

  localRanges.sort((left, right) => left.start - right.start);
  if (localRanges[0]?.start !== 0 || localRanges.at(-1)?.end !== centralOffset) {
    throw unsafeModelError('USDZ contains unexpected embedded data');
  }
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index - 1].end !== localRanges[index].start) {
      throw unsafeModelError('USDZ contains overlapping or hidden data');
    }
  }
  return true;
}

function validateLocalZipEntry(buffer, entry) {
  if (entry.localOffset + 30 > entry.centralOffset || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw signatureError('USDZ model');
  }
  const localFlags = buffer.readUInt16LE(entry.localOffset + 6);
  const localMethod = buffer.readUInt16LE(entry.localOffset + 8);
  const localCompressedSize = buffer.readUInt32LE(entry.localOffset + 18);
  const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const localNameStart = entry.localOffset + 30;
  const localNameEnd = localNameStart + localNameLength;
  const dataStart = localNameEnd + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (localFlags !== entry.flags || localMethod !== entry.compressionMethod
    || localCompressedSize !== entry.compressedSize || dataEnd > entry.centralOffset
    || !buffer.subarray(localNameStart, localNameEnd).equals(entry.nameBytes)) {
    throw unsafeModelError('USDZ local entry metadata is inconsistent');
  }
  return { start: entry.localOffset, end: dataEnd };
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let cursor = buffer.length - 22; cursor >= minimum; cursor -= 1) {
    if (buffer.readUInt32LE(cursor) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(cursor + 20);
    if (cursor + 22 + commentLength === buffer.length) return cursor;
  }
  return -1;
}

function decodeZipName(nameBytes, flags) {
  const name = nameBytes.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1');
  if (!name || name.includes('\ufffd')) throw unsafeModelError('USDZ contains an invalid asset path');
  return name;
}

function validateArchivePath(name) {
  if (name.length > 512 || name.includes('\0') || name.includes('\\')
    || name.startsWith('/') || /^[a-z]:/i.test(name)) {
    throw unsafeModelError('USDZ contains an unsafe asset path');
  }
  const segments = name.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) {
    throw unsafeModelError('USDZ contains an unsafe asset path');
  }
}

function isSafeEmbeddedImage(uri) {
  return /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(String(uri || ''));
}

function signatureError(kind) {
  const error = new Error(`Uploaded file is not a supported ${kind}`);
  error.statusCode = 400;
  error.code = 'INVALID_FILE_SIGNATURE';
  return error;
}

function unsafeModelError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'UNSAFE_MODEL_ARCHIVE';
  return error;
}

module.exports = {
  detectType,
  verifyUploadSignature,
  _private: {
    validateArchivePath,
    validateGlbBuffer,
    validateUsdzBuffer,
  },
};
