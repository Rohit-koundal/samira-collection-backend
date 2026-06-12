function normalizePhone(phone = '') {
  const raw = String(phone).trim();
  const digits = raw.replace(/\D/g, '');
  const indianLocal = digits.replace(/^91/, '');
  if (/^[6-9]\d{9}$/.test(indianLocal)) return indianLocal;
  if (raw.startsWith('+') && /^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
  return '';
}

function requireValidPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    const error = new Error('Enter a valid mobile number with country code');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

module.exports = { normalizePhone, requireValidPhone };
