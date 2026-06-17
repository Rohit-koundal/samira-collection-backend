const sharp = require('sharp');

const VARIANTS = {
  thumb: { width: 120, height: 150, fit: 'cover' },
  card: { width: 400, height: 500, fit: 'cover' },
  full: { width: 1600, height: 2000, fit: 'inside' },
};

async function validateImageFile(filePath) {
  const input = sharp(filePath, { failOn: 'none' }).rotate();
  const metadata = await input.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('Invalid or unsupported image file. Please upload a valid JPG, PNG, or WEBP image.');
  }
  if (metadata.width < 50 || metadata.height < 50) {
    throw new Error('Image is too small. Please upload a product image at least 50x50 pixels.');
  }

  return metadata;
}

async function generateImageVariants(filePath) {
  await validateImageFile(filePath);
  const input = sharp(filePath, { failOn: 'none' }).rotate();
  const variants = {};

  for (const [name, options] of Object.entries(VARIANTS)) {
    const buffer = await input
      .clone()
      .resize({
        width: options.width,
        height: options.height,
        fit: options.fit,
        withoutEnlargement: true,
      })
      .webp({ quality: name === 'full' ? 85 : 80 })
      .toBuffer();

    if (!buffer.length) {
      throw new Error(`Failed to process image variant "${name}". The file may be corrupted.`);
    }

    variants[name] = buffer;
  }

  return variants;
}

module.exports = { generateImageVariants, validateImageFile, VARIANTS };
