const fs = require('fs');
const path = require('path');

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

function isVisionEnabled() {
  return Boolean(String(process.env.GEMINI_API_KEY || '').trim());
}

function mimeFromName(name = '') {
  const ext = path.extname(String(name)).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function localUploadPath(imageUrl = '') {
  const raw = String(imageUrl || '').split('?')[0];
  const match = raw.match(/\/uploads\/([^/?#]+)$/i);
  if (!match) return '';
  return path.join(__dirname, '..', 'uploads', match[1]);
}

function resolveFetchUrl(imageUrl = '') {
  const raw = String(imageUrl || '').trim();
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;

  // Prefer the running local API for relative /uploads paths.
  // PUBLIC_API_URL may point at production and would fail for local files.
  const localOrigin = `http://127.0.0.1:${process.env.SERVER_PORT || 5000}`;
  const configured = String(process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  const origin = /localhost|127\.0\.0\.1/i.test(configured) || !configured ? (configured || localOrigin) : localOrigin;
  return `${origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

async function readImage(imageUrl = '') {
  const raw = String(imageUrl || '').trim();
  if (!raw) throw new Error('Image is required');

  const diskPath = localUploadPath(raw);
  if (diskPath && fs.existsSync(diskPath)) {
    const buffer = fs.readFileSync(diskPath);
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Image is too large to analyze');
    return { mimeType: mimeFromName(diskPath), data: buffer.toString('base64') };
  }

  const absolute = resolveFetchUrl(raw);
  const response = await fetch(absolute, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('Could not read the uploaded photo');
  const mimeType = (response.headers.get('content-type') || mimeFromName(absolute)).split(';')[0];
  if (!mimeType.startsWith('image/')) throw new Error('Only product photos can be analyzed');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Image is too large to analyze');
  return { mimeType, data: buffer.toString('base64') };
}

function parseModelJson(text = '') {
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return {};
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return {};
  }
}

function clip(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function asList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return items.map((item) => clip(item, 40)).filter(Boolean).slice(0, 8);
}

function modelsToTry() {
  const preferred = clip(process.env.GEMINI_MODEL, 80) || 'gemini-2.0-flash';
  return [...new Set([preferred, ...FALLBACK_MODELS])];
}

function buildPrompt(categories, subcategories) {
  const categoryNames = categories.map((item) => item.name).filter(Boolean).slice(0, 40);
  return [
    'You are a fashion catalog assistant for an Indian clothing boutique (sarees, lehengas, suits, kurtis, gowns, tops, skirts, jumpsuits).',
    'Look carefully at the product photo. Identify the garment from what you see — do not use any filename.',
    'Return JSON only.',
    'Rules:',
    '- name: short shoppable title from what is visible (color + garment type + notable detail). Example: "Wine Embroidered Anarkali Suit".',
    '- categoryName: pick the closest match from the store category list when possible.',
    '- subCategory: only if it clearly fits a listed subcategory, otherwise empty.',
    '- colors: visible garment colors only.',
    '- fabric: only if visually likely (silk sheen, cotton weave, georgette drape). Leave empty if unsure.',
    '- occasion: only if styling clearly suggests one (wedding, festive, casual, party). Leave empty if unsure.',
    '- tags: 2-6 short searchable words from what you see.',
    '- shortDescription: one line for the product card.',
    '- description: 1-2 sentences describing the visible garment. No invented care claims, no price, no stock.',
    `Store categories: ${categoryNames.join(', ') || 'none'}.`,
    `Known subcategories: ${(subcategories || []).slice(0, 40).join(', ') || 'none'}.`,
    'JSON shape: {"name":"","categoryName":"","subCategory":"","colors":[],"fabric":"","occasion":"","tags":[],"shortDescription":"","description":""}',
  ].join(' ');
}

async function callGeminiModel(model, { image, categories, subcategories }) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  const prompt = buildPrompt(categories, subcategories);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: image.mimeType, data: image.data } },
          ],
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
      }),
    },
  );

  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) {
    const error = new Error(payload?.error?.message || 'Model unavailable');
    error.retryModel = true;
    throw error;
  }
  if (response.status === 400) {
    const detail = String(payload?.error?.message || '');
    const error = new Error(detail || 'Photo analysis is unavailable right now');
    error.retryModel = /not found|not supported|unknown model|invalid model/i.test(detail);
    throw error;
  }
  if (response.status === 429) {
    throw new Error('Photo reading is busy right now. You can still add the product, or try again in a minute.');
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message || 'Photo analysis is unavailable right now');
  }
  if (payload?.promptFeedback?.blockReason) {
    throw new Error('This photo could not be analyzed. You can still fill the listing yourself.');
  }
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('\n') || '';
  return parseModelJson(text);
}

async function callGemini(input) {
  let lastError = new Error('Photo analysis is unavailable right now');
  for (const model of modelsToTry()) {
    try {
      return await callGeminiModel(model, input);
    } catch (error) {
      lastError = error;
      if (!error.retryModel) throw error;
    }
  }
  throw lastError;
}

function matchCategory(categories, categoryName) {
  const needle = clip(categoryName, 80).toLowerCase();
  if (!needle) return null;
  return categories.find((item) => clip(item.name, 80).toLowerCase() === needle)
    || categories.find((item) => {
      const name = clip(item.name, 80).toLowerCase();
      return name.length >= 3 && (needle.includes(name) || name.includes(needle));
    })
    || null;
}

exports.isVisionEnabled = isVisionEnabled;

exports.getQuickAddVisionStatus = () => ({
  enabled: isVisionEnabled(),
  reason: isVisionEnabled()
    ? 'Photo reading is on. Upload a product photo to identify name, category, colors and details.'
    : 'Photo reading is off. Add a free GEMINI_API_KEY in backend/.env, then restart the server.',
});

exports.analyzeQuickAddImage = async ({ imageUrl, categories = [], subcategories = [] } = {}) => {
  if (!isVisionEnabled()) {
    return {
      enabled: false,
      reason: 'Add a free GEMINI_API_KEY in backend/.env (from https://aistudio.google.com/apikey), then restart the server.',
    };
  }

  const safeCategories = (Array.isArray(categories) ? categories : [])
    .map((item) => ({ _id: item?._id, name: clip(item?.name, 80) }))
    .filter((item) => item._id && item.name)
    .slice(0, 40);
  const safeSubcategories = (Array.isArray(subcategories) ? subcategories : [])
    .map((item) => clip(item, 80))
    .filter(Boolean)
    .slice(0, 40);

  const image = await readImage(imageUrl);
  const raw = await callGemini({ image, categories: safeCategories, subcategories: safeSubcategories });
  const matched = matchCategory(safeCategories, raw.categoryName);
  const name = clip(raw.name, 120);
  if (!name) {
    throw new Error('Could not identify this garment from the photo. Try a clearer front-facing product shot.');
  }

  return {
    enabled: true,
    suggestion: {
      name,
      categoryId: matched?._id ? String(matched._id) : '',
      categoryName: matched?.name || '',
      subCategory: clip(raw.subCategory, 80),
      colors: asList(raw.colors),
      fabric: clip(raw.fabric, 80),
      occasion: clip(raw.occasion, 80),
      tags: asList(raw.tags),
      shortDescription: clip(raw.shortDescription, 200),
      description: clip(raw.description, 800),
    },
  };
};
