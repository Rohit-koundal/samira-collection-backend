const crypto = require('crypto');
const fs = require('fs/promises');

function isCloudinaryConfigured() {
  return Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

async function uploadImage(file, options = {}) {
  return uploadFile(file, 'image', options);
}

async function uploadFile(file, resourceType = 'image', options = {}) {
  if (!isCloudinaryConfigured()) return null;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const baseFolder = process.env.CLOUDINARY_FOLDER || 'samira-products';
  const suffix = String(options.folder || '').replace(/[^a-z0-9/_-]/gi, '').replace(/^\/+|\/+$/g, '');
  const folder = suffix ? `${baseFolder}/${suffix}` : baseFolder;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHash('sha1')
    .update(`folder=${folder}&timestamp=${timestamp}${apiSecret}`)
    .digest('hex');

  const buffer = await fs.readFile(file.path);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: file.mimetype }), file.originalname);
  form.append('api_key', apiKey);
  form.append('timestamp', String(timestamp));
  form.append('folder', folder);
  form.append('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'Cloudinary upload failed');

  return {
    url: data.secure_url,
    publicId: data.public_id,
    originalName: file.originalname,
  };
}

async function uploadVideo(file, options = {}) {
  return uploadFile(file, 'video', options);
}

module.exports = { isCloudinaryConfigured, uploadImage, uploadVideo };
