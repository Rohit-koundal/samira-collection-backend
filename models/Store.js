const mongoose = require('mongoose');

const STORE_STATUSES = ['DRAFT', 'ONBOARDING', 'PUBLISHED', 'SUSPENDED'];

const addressShape = {
  fullName: String,
  mobile: String,
  pincode: String,
  state: String,
  city: String,
  houseNo: String,
  area: String,
  landmark: String,
};

const storeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 80 },
  legalName: { type: String, trim: true, maxlength: 120 },
  logo: String,
  coverImage: String,
  bio: { type: String, maxlength: 1000 },
  instagramHandle: { type: String, trim: true, maxlength: 80 },
  instagramUrl: { type: String, trim: true, maxlength: 300 },
  whatsappNumber: { type: String, trim: true, maxlength: 20 },
  supportEmail: { type: String, trim: true, maxlength: 120 },
  supportPhone: { type: String, trim: true, maxlength: 20 },
  currency: { type: String, default: 'INR', maxlength: 8 },
  timezone: { type: String, default: 'Asia/Kolkata', maxlength: 60 },
  pickupAddress: addressShape,
  returnAddress: addressShape,
  paymentReady: { type: Boolean, default: false },
  shippingReady: { type: Boolean, default: false },
  status: { type: String, enum: STORE_STATUSES, default: 'ONBOARDING', index: true },
  isDefault: { type: Boolean, default: false, index: true },
  publishedAt: Date,
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  customDomain: { type: String, trim: true, lowercase: true, maxlength: 120 },
}, { timestamps: true });

storeSchema.index({ isDefault: 1, status: 1 });
storeSchema.index({ customDomain: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Store', storeSchema);
module.exports.STORE_STATUSES = STORE_STATUSES;
