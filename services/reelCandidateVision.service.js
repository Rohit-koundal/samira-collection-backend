const {
  analyzeReelCandidateFiles,
  analyzeReelCandidateImages,
  isVisionEnabled,
} = require('./quickAddVision.service');

function clean(value, max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(value, maxItems = 8) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(items.map((item) => clean(item, 60)).filter(Boolean))].slice(0, maxItems);
}

function defaultCandidateSuggestion(groupNumber) {
  return {
    name: `Product ${groupNumber}`,
    category: '',
    categoryName: '',
    subcategory: '',
    primaryColor: '',
    secondaryColors: [],
    pattern: '',
    fabric: '',
    occasion: [],
    tags: ['reel-import'],
    altText: `Reel product candidate ${groupNumber}`,
    shortDescription: '',
    description: '',
    sizingMode: 'confirm',
  };
}

function unavailableCandidateAnalysis(groupNumber, reason = '') {
  return {
    suggestions: defaultCandidateSuggestion(groupNumber),
    confidence: {
      name: 0,
      category: 0,
      primaryColor: 0,
      pattern: 0,
      fabric: 0,
      occasion: 0,
      overall: 0,
    },
    analysis: {
      status: 'unavailable',
      source: '',
      model: '',
      analyzedAt: null,
      error: clean(reason || 'Smart suggestions are not configured.', 240),
    },
  };
}

function failedCandidateAnalysis(groupNumber, error) {
  const fallback = unavailableCandidateAnalysis(groupNumber, error?.message || 'Product details could not be identified.');
  fallback.analysis.status = 'failed';
  fallback.analysis.analyzedAt = new Date();
  return fallback;
}

function toCandidateAnalysis(result, groupNumber) {
  if (!result?.enabled) return unavailableCandidateAnalysis(groupNumber, result?.reason);
  const suggestion = result.suggestion || {};
  const colors = cleanList(suggestion.colors);
  const tags = cleanList(suggestion.tags);
  return {
    suggestions: {
      name: clean(suggestion.name, 120) || `Product ${groupNumber}`,
      category: clean(suggestion.categoryId, 80),
      categoryName: clean(suggestion.categoryName, 80),
      subcategory: clean(suggestion.subCategory, 80),
      primaryColor: colors[0] || '',
      secondaryColors: colors.slice(1),
      pattern: clean(suggestion.pattern, 80),
      fabric: clean(suggestion.fabric, 80),
      occasion: cleanList(suggestion.occasion, 4),
      tags: tags.length ? [...new Set([...tags, 'reel-import'])].slice(0, 8) : ['reel-import'],
      altText: clean(suggestion.shortDescription || suggestion.name, 200),
      shortDescription: clean(suggestion.shortDescription, 200),
      description: clean(suggestion.description, 800),
      sizingMode: ['sized', 'free-size'].includes(suggestion.sizingMode) ? suggestion.sizingMode : 'confirm',
    },
    confidence: {
      name: Number(result.confidence?.name || 0),
      category: Number(result.confidence?.category || 0),
      primaryColor: Number(result.confidence?.primaryColor || 0),
      pattern: Number(result.confidence?.pattern || 0),
      fabric: Number(result.confidence?.fabric || 0),
      occasion: Number(result.confidence?.occasion || 0),
      overall: Number(result.confidence?.overall || 0),
    },
    analysis: {
      status: 'completed',
      source: clean(result.analysis?.source, 80),
      model: clean(result.analysis?.model, 80),
      analyzedAt: result.analysis?.analyzedAt || new Date(),
      error: '',
    },
  };
}

async function analyzeCandidateFiles({ groupNumber, filePaths, categories, subcategories }) {
  if (!isVisionEnabled()) return unavailableCandidateAnalysis(groupNumber);
  try {
    const result = await analyzeReelCandidateFiles({ filePaths, categories, subcategories });
    return toCandidateAnalysis(result, groupNumber);
  } catch (error) {
    return failedCandidateAnalysis(groupNumber, error);
  }
}

async function analyzeCandidateImages({ groupNumber, imageUrls, categories, subcategories }) {
  if (!isVisionEnabled()) return unavailableCandidateAnalysis(groupNumber);
  try {
    const result = await analyzeReelCandidateImages({ imageUrls, categories, subcategories });
    return toCandidateAnalysis(result, groupNumber);
  } catch (error) {
    return failedCandidateAnalysis(groupNumber, error);
  }
}

module.exports = {
  analyzeCandidateFiles,
  analyzeCandidateImages,
  defaultCandidateSuggestion,
  failedCandidateAnalysis,
  isVisionEnabled,
  toCandidateAnalysis,
  unavailableCandidateAnalysis,
};
