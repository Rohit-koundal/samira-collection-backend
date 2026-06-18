const mongoose = require('mongoose');

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
<<<<<<< HEAD
  images: [{ url: String, publicId: String, primary: { type: Boolean, default: false } }],
=======
  images: [{
    url: String,
    publicId: String,
  }],
>>>>>>> 4509b61740897cfdd0411da4b7e6430f7ce333fd
  sizes: [String],
  colors: [String],
  fabric: String,
  occasion: String,
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
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);
