const slugify = require('../../utils/slugify');

function candidateToDraft(candidate, job, userId) {
  const overrides = candidate.adminOverrides || {};
  const suggestions = candidate.suggestions || {};
  const selectedFrames = (candidate.frames || []).filter((frame) => frame.selected).slice(0, 4);
  const frames = selectedFrames.length ? selectedFrames : (candidate.frames || []).slice(0, 4);
  const images = frames.map((frame, index) => ({
    url: frame.url,
    publicId: frame.storageKey,
    primary: index === 0,
  }));
  const name = overrides.name || suggestions.name || 'Reel Product ' + candidate.groupNumber;
  const price = Number(overrides.price || 0);
  const originalPrice = Number(overrides.originalPrice || price);
  return {
    name,
    slug: slugify(name) + '-' + String(candidate._id).slice(-6),
    image: images[0]?.url || '',
    images,
    videos: [],
    category: overrides.category || undefined,
    subCategory: overrides.subCategory || suggestions.subcategory || '',
    price,
    sellingPrice: price,
    originalPrice,
    stock: Number(overrides.stock || 0),
    sizes: overrides.sizes || [],
    colors: [overrides.primaryColor || suggestions.primaryColor].filter(Boolean),
    fabric: '',
    occasion: overrides.occasion || suggestions.occasion?.[0] || '',
    tags: overrides.tags?.length ? overrides.tags : suggestions.tags || [],
    description: '',
    highlights: [],
    status: 'draft',
    createdBy: userId,
    sourceType: 'reel-import',
    sourceJobId: job._id,
    sourceCandidateId: candidate._id,
  };
}

module.exports = { candidateToDraft };
