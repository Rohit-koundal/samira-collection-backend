const { normalizePhone } = require('./phoneUtils');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_PATTERN = /^\d{6}$/;

function validateRegistration(input) {
  const body = requirePlainObject(input);
  rejectUnknown(body, ['name', 'phone', 'email', 'password']);
  const name = cleanString(body.name, 'Name', { min: 2, max: 80 });
  const phone = normalizePhone(body.phone);
  if (!phone) throw validationError('Enter a valid mobile number');
  const email = body.email === undefined || body.email === ''
    ? undefined
    : normalizeRequiredEmail(body.email);
  const password = String(body.password || '');
  if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw validationError('Password must be 8-128 characters and include a letter and number');
  }
  return {
    name,
    phone,
    ...(email ? { email } : {}),
    password,
    role: 'customer',
    activeMode: 'customer',
    availableModes: ['customer'],
    isBlocked: false,
    isPhoneVerified: false,
    isEmailVerified: false,
  };
}

function validateLogin(input) {
  const body = requirePlainObject(input);
  rejectUnknown(body, ['email', 'password']);
  const email = normalizeRequiredEmail(body.email);
  const password = String(body.password || '');
  if (!password || password.length > 128) throw validationError('Email and password are required');
  return { email, password };
}

function validateOtpSend(input, field = 'phone') {
  const body = requirePlainObject(input);
  rejectUnknown(body, [field]);
  if (field === 'email') return { email: normalizeRequiredEmail(body.email) };
  const phone = normalizePhone(body.phone);
  if (!phone) throw validationError('Valid mobile number is required');
  return { phone };
}

function validateOtpVerify(input, field = 'phone') {
  const body = requirePlainObject(input);
  rejectUnknown(body, [field, 'otp']);
  const target = validateOtpSend({ [field]: body[field] }, field);
  const otp = String(body.otp || '');
  if (!OTP_PATTERN.test(otp)) throw validationError('A valid 6-digit OTP is required');
  return { ...target, otp };
}

function validateProfileUpdate(input) {
  const body = requirePlainObject(input);
  const allowed = [
    'name',
    'email',
    'phone',
    'gender',
    'birthDate',
    'alternatePhone',
    'hintName',
    'phoneVerificationToken',
    'emailVerificationToken',
  ];
  rejectUnknown(body, allowed);
  return body;
}

function validateSwitchMode(input) {
  const body = requirePlainObject(input);
  rejectUnknown(body, ['mode', 'activeMode']);
  const mode = String(body.mode || body.activeMode || '').trim().toLowerCase();
  if (!['customer', 'admin'].includes(mode)) throw validationError('Invalid mode');
  return { mode };
}

function validateRefreshRequest(input) {
  const body = requirePlainObject(input);
  rejectUnknown(body, ['refreshToken']);
  if (body.refreshToken !== undefined && typeof body.refreshToken !== 'string') {
    throw validationError('Invalid refresh request');
  }
  return body;
}

function validateRoleUpdate(input) {
  const body = requirePlainObject(input);
  rejectUnknown(body, ['role']);
  const role = String(body.role || '').trim().toLowerCase();
  if (!['customer', 'admin'].includes(role)) throw validationError('Role must be customer or admin');
  return { role };
}

function normalizeRequiredEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) throw validationError('Enter a valid email address');
  return email;
}

function cleanString(value, label, { min = 0, max = 255 } = {}) {
  const result = String(value || '').trim().replace(/[\u0000-\u001F\u007F]/g, '');
  if (result.length < min || result.length > max) {
    throw validationError(`${label} must be between ${min} and ${max} characters`);
  }
  return result;
}

function requirePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError('Invalid request body');
  return value;
}

function rejectUnknown(body, allowed) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw validationError('Request contains unsupported fields');
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}

module.exports = {
  normalizeRequiredEmail,
  validateLogin,
  validateOtpSend,
  validateOtpVerify,
  validateProfileUpdate,
  validateRefreshRequest,
  validateRegistration,
  validateRoleUpdate,
  validateSwitchMode,
  validationError,
};
