const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const variantSchema = new mongoose.Schema({
  sku: String,
  size: { type: String, default: '' },
  color: { type: String, default: '' },
  stock: { type: Number, default: 0, min: 0 },
  price: Number,
  originalPrice: Number,
  images: [{ url: String, publicId: String, primary: { type: Boolean, default: false } }],
  isActive: { type: Boolean, default: true },
}, { _id: true });

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  brand: { type: String, default: 'Samira Collection' },
  shortDescription: String,
  description: String,
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  subCategory: String,
  price: { type: Number, required: true },
  originalPrice: Number,
  discountPercentage: Number,
  images: [{ url: String, publicId: String, primary: { type: Boolean, default: false } }],
  videos: [{ url: String, publicId: String, thumbnail: String }],
  sizes: [String],
  colors: [String],
  fabric: String,
  occasion: String,
  variantGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'VariantGroup' },
  variantName: String,
  variantColor: String,
  variantSize: String,
  variants: { type: [variantSchema], default: [] },
  stock: { type: Number, required: true, default: 0 },
  lowStockAlert: { type: Number, default: 5 },
  sku: { type: String, unique: true, sparse: true },
  tags: [String],
  primaryImage: String,
  highlights: [String],
  careInstructions: String,
  returnPolicy: String,
  metaTitle: String,
  metaDescription: String,
  metaKeywords: String,
  rating: { type: Number, default: 0 },
  numReviews: { type: Number, default: 0 },
  isFeatured: { type: Boolean, default: false },
  isNewArrival: { type: Boolean, default: false },
  isBestSeller: { type: Boolean, default: false },
  showOnHomepage: { type: Boolean, default: false },
  showInTrending: { type: Boolean, default: false },
  showInFestive: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  isArchived: { type: Boolean, default: false, index: true },
  deletedAt: Date,
}, { timestamps: true });

productSchema.plugin(storeIdPlugin);
productSchema.index({ storeId: 1, slug: 1 });
productSchema.index({ storeId: 1, sku: 1 });
productSchema.index({ storeId: 1, category: 1, createdAt: -1 });
productSchema.index({ storeId: 1, isActive: 1, createdAt: -1 });

productSchema.pre('save', function syncVariantStock(next) {
  if (Array.isArray(this.variants) && this.variants.length) {
    this.stock = this.variants
      .filter((variant) => variant && variant.isActive !== false)
      .reduce((sum, variant) => sum + Math.max(0, Number(variant.stock || 0)), 0);
  }
  next();
});

module.exports = mongoose.model('Product', productSchema);
