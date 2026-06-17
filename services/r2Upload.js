const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

let r2Client;

function isR2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID
    && process.env.R2_ACCESS_KEY_ID
    && process.env.R2_SECRET_ACCESS_KEY
    && process.env.R2_BUCKET_NAME
    && process.env.R2_PUBLIC_URL,
  );
}

function getR2Client() {
  if (!r2Client) {
    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return r2Client;
}

function getR2Folder() {
  return String(process.env.R2_FOLDER || 'products').replace(/^\/+|\/+$/g, '');
}

function buildPublicUrl(objectKey) {
  const base = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  return `${base}/${objectKey}`;
}

async function uploadImageToR2(file) {
  const ext = path.extname(file.originalname) || '.jpg';
  const safeName = String(file.originalname).replace(/[^a-z0-9.]+/gi, '-').toLowerCase();
  const suffix = crypto.randomBytes(4).toString('hex');
  const objectKey = `${getR2Folder()}/${Date.now()}-${safeName}-${suffix}${ext}`;
  const buffer = await fs.readFile(file.path);

  await getR2Client().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey,
    Body: buffer,
    ContentType: file.mimetype || 'image/jpeg',
    CacheControl: 'public, max-age=31536000',
  }));

  return {
    url: buildPublicUrl(objectKey),
    publicId: objectKey,
    originalName: file.originalname,
  };
}

module.exports = {
  isR2Configured,
  uploadImageToR2,
};
