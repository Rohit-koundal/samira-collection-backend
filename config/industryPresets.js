const field = (key, label, unit = '') => ({ key, label, unit, required: false });
const INDUSTRY_PRESETS = [
  { id: 'fashion', name: 'Fashion & Clothing', industry: 'fashion', features: { sizing: true, specifications: true },
    attributes: [field('material', 'Material'), field('fit', 'Fit'), field('pattern', 'Pattern')] },
  { id: 'electronics', name: 'Mobile & Electronics', industry: 'electronics', features: { sizing: false, specifications: true },
    attributes: [field('ram', 'RAM', 'GB'), field('storage', 'Storage', 'GB'), field('processor', 'Processor'), field('battery', 'Battery', 'mAh'), field('camera', 'Camera'), field('warranty', 'Warranty')] },
  { id: 'art', name: 'Art & Paintings', industry: 'art', features: { sizing: false, specifications: true },
    attributes: [field('artist', 'Artist'), field('medium', 'Medium'), field('dimensions', 'Dimensions'), field('framing', 'Framing'), field('authenticity', 'Authenticity')] },
  { id: 'jewellery', name: 'Jewellery', industry: 'jewellery', features: { sizing: false, specifications: true },
    attributes: [field('metal', 'Metal'), field('purity', 'Purity'), field('gemstone', 'Gemstone'), field('weight', 'Weight', 'g'), field('certification', 'Certification')] },
];
const DEFAULT_STRUCTURE = { ...INDUSTRY_PRESETS[0], clientPermissions: { content: true, payments: true } };
module.exports = { INDUSTRY_PRESETS, DEFAULT_STRUCTURE };
