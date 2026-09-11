const mongoose = require('mongoose');

const cyclePrices = new mongoose.Schema({
  monthly: { type: Number, required: true, min: 1, max: 10000000 },
  yearly: { type: Number, required: true, min: 1, max: 10000000 },
  lifetime: { type: Number, required: true, min: 1, max: 10000000 },
}, { _id: false });

const subscriptionPricingSchema = new mongoose.Schema({
  _id: { type: String, default: 'platform' },
  currency: { type: String, enum: ['INR'], default: 'INR' },
  taxMode: { type: String, enum: ['INCLUSIVE', 'EXCLUSIVE'], default: 'INCLUSIVE' },
  gstPercent: { type: Number, min: 0, max: 28, default: 18 },
  prices: {
    BASIC: { type: cyclePrices, required: true },
    PROFESSIONAL: { type: cyclePrices, required: true },
    PREMIUM: { type: cyclePrices, required: true },
  },
  revision: { type: Number, default: 0, min: 0 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  history: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('SubscriptionPricing', subscriptionPricingSchema);
