function normalizePhone(phone = '') {
  const digits = String(phone).replace(/\D/g, '').replace(/^91/, '');
  return /^[6-9]\d{9}$/.test(digits) ? digits : '';
}

function requireValidPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    const error = new Error('Valid 10-digit Indian mobile number is required');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

module.exports = { normalizePhone, requireValidPhone };
