const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ADMIN_ROLES, PERMISSIONS } = require('../config/adminPermissions');

const addressSchema = new mongoose.Schema({
  fullName: String,
  mobile: String,
  alternateMobile: String,
  phone: String,
  pincode: String,
  state: String,
  city: String,
  houseNo: String,
  houseNumber: String,
  area: String,
  landmark: String,
  addressType: { type: String, enum: ['Home', 'Work', 'Other'], default: 'Home' },
  isDefault: { type: Boolean, default: false },
});

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true, maxlength: 80 },
  email: { type: String, unique: true, sparse: true, trim: true, lowercase: true },
  phone: { type: String, required: true, unique: true },
  isEmailVerified: { type: Boolean, default: false },
  gender: { type: String, enum: ['male', 'female', 'other', ''], default: '' },
  birthDate: Date,
  alternatePhone: String,
  hintName: String,
  password: { type: String, select: false },
  isPhoneVerified: { type: Boolean, default: false },
  role: { type: String, enum: ['customer', 'admin', 'owner'], default: 'customer' },
  adminRole: { type: String, enum: ADMIN_ROLES },
  permissions: [{ type: String, enum: PERMISSIONS }],
  availableModes: [{ type: String, enum: ['customer', 'admin'] }],
  activeMode: { type: String, enum: ['customer', 'admin'], default: 'customer' },
  addresses: [addressSchema],
  wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  isBlocked: { type: Boolean, default: false },
  tokenVersion: { type: Number, default: 0, select: false },
}, { timestamps: true });

userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ role: 1, isBlocked: 1, createdAt: -1 });

userSchema.pre('validate', function enforceRoleModes(next) {
  if (this.role === 'customer') {
    this.adminRole = undefined;
    this.permissions = [];
    this.availableModes = ['customer'];
    this.activeMode = 'customer';
  } else if (this.role === 'owner') {
    this.adminRole = undefined;
    this.permissions = [];
    this.availableModes = ['customer', 'admin'];
    if (!['customer', 'admin'].includes(this.activeMode)) this.activeMode = 'admin';
  } else {
    if (!this.adminRole) this.adminRole = 'order_manager';
    this.availableModes = ['customer', 'admin'];
    if (!['customer', 'admin'].includes(this.activeMode)) this.activeMode = 'admin';
  }
  next();
});

userSchema.pre('save', async function hashPassword(next) {
  if (!this.password || !this.isModified('password')) return next();
  if (!this.isNew) {
    this.tokenVersion = Number(this.tokenVersion || 0) + 1;
    this.$locals.revokeSessionsAfterPasswordChange = true;
  }
  const configuredRounds = Number(process.env.BCRYPT_ROUNDS);
  const rounds = Number.isInteger(configuredRounds) && configuredRounds >= 10 && configuredRounds <= 15
    ? configuredRounds
    : 12;
  this.password = await bcrypt.hash(this.password, rounds);
  next();
});

userSchema.post('save', async function revokeSessionsAfterPasswordChange() {
  if (!this.$locals.revokeSessionsAfterPasswordChange) return;
  const RefreshSession = require('./RefreshSession');
  await RefreshSession.updateMany(
    { user: this._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: 'password_changed' } },
  );
  this.$locals.revokeSessionsAfterPasswordChange = false;
});

userSchema.methods.matchPassword = async function matchPassword(password) {
  if (!password || !this.password) return false;
  if (/^\$2[aby]\$/.test(this.password)) return bcrypt.compare(password, this.password);
  return password === this.password;
};

userSchema.methods.hasLegacyPlainPassword = function hasLegacyPlainPassword() {
  return this.password && !/^\$2[aby]\$/.test(this.password);
};

module.exports = mongoose.model('User', userSchema);
