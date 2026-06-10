const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  storeName: { type: String, default: 'Samira Collection' },
  contactEmail: String,
  contactPhone: String,
  whatsappNumber: String,
  address: String,
  freeShippingMinAmount: { type: Number, default: 999 },
  deliveryCharge: { type: Number, default: 99 },
  codEnabled: { type: Boolean, default: true },
  codCharge: { type: Number, default: 0 },
  codMaxAmount: Number,
  razorpayEnabled: { type: Boolean, default: false },
  upiEnabled: { type: Boolean, default: true },
  cardPaymentEnabled: { type: Boolean, default: true },
  netBankingEnabled: { type: Boolean, default: true },
  walletEnabled: { type: Boolean, default: true },
  socialLinks: Object,
  footerText: String,
  returnPolicy: String,
  privacyPolicy: String,
  termsConditions: String,
}, { timestamps: true });

module.exports = mongoose.model('Settings', settingsSchema);
