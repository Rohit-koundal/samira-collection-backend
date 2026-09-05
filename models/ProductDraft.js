const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const imageSchema = new mongoose.Schema({
  url: String,
  publicId: String,
  primary: { type: Boolean, default: false },
}, { _id: false });

const videoSchema = new mongoose.Schema({
  url: String,
  publicId: String,
  thumbnail: String,
}, { _id: false });

const sizeChartRowSchema = new mongoose.Schema({
  size: String,
  acrossShoulder: Number,
  sleeveLength: Number,
  bust: Number,
  chest: Number,
  waist: Number,
  frontLength: Number,
  bottomLength: Number,
  hips: Number,
  outseamLength: Number,
  inseamLength: Number,
}, { _id: false });

const productDraftSchema = new mongoose.Schema({
  name: String,
  slug: String,
  sku: String,
  image: String,
  images: [imageSchema],
  videos: [videoSchema],
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  subCategory: String,
  price: Number,
  originalPrice: Number,
  sellingPrice: Number,
  stock: Number,
  sizes: [String],
  sizingMode: { type: String, enum: ['auto', 'sized', 'free-size'], default: 'auto' },
  sizeChartProfile: { type: String, default: 'auto' },
  sizeChart: {
    unit: { type: String, enum: ['in', 'cm'], default: 'in' },
    columns: { type: [String], default: [] },
    rows: { type: [sizeChartRowSchema], default: [] },
  },
  sizeFitNotes: String,
  colors: [String],
  fabric: String,
  occasion: String,
  tags: [String],
  description: String,
  highlights: [String],
  status: { type: String, enum: ['draft', 'published'], default: 'draft' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  publishedProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  sourceType: { type: String, enum: ['reel-import'], default: undefined },
  sourceJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReelImport', default: undefined },
  sourceCandidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReelCandidate', unique: true, sparse: true, default: undefined },
  confidence: { type: Number, min: 0, max: 1 },
  detectedColors: [String],
  detectedPattern: String,
  suggestedCategory: String,
  suggestedTags: [String],
  draftTitle: String,
  draftDescription: String,
}, { timestamps: true });

productDraftSchema.plugin(storeIdPlugin);

module.exports = mongoose.model('ProductDraft', productDraftSchema);
