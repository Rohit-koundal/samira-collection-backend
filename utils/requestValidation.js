const mongoose = require('mongoose');

class RequestValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'RequestValidationError';
    this.statusCode = 400;
    this.code = 'VALIDATION_ERROR';
    this.details = details;
  }
}

function assertObjectId(value, field = 'id') {
  if (!mongoose.Types.ObjectId.isValid(String(value || ''))) {
    throw new RequestValidationError(`Invalid ${field}`, [{ field, message: `A valid ${field} is required` }]);
  }
  return String(value);
}

function pick(source = {}, allowedFields = []) {
  return allowedFields.reduce((result, field) => {
    if (Object.prototype.hasOwnProperty.call(source, field)) result[field] = source[field];
    return result;
  }, {});
}

function rejectUnknown(source = {}, allowedFields = [], protectedFields = []) {
  const allowed = new Set(allowedFields);
  const protectedSet = new Set(protectedFields);
  const protectedUnknown = Object.keys(source || {}).filter((key) => !allowed.has(key) && protectedSet.has(key));
  if (protectedUnknown.length) {
    throw new RequestValidationError('Protected fields cannot be changed', protectedUnknown.map((field) => ({
      field,
      message: `${field} is not accepted by this endpoint`,
    })));
  }
}

function cleanString(value, { field = 'value', min = 0, max = 500, required = false } = {}) {
  const normalized = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (required && normalized.length < Math.max(1, min)) {
    throw new RequestValidationError(`${field} is required`, [{ field, message: `${field} is required` }]);
  }
  if (normalized.length < min || normalized.length > max) {
    throw new RequestValidationError(`Invalid ${field}`, [{ field, message: `${field} must be between ${min} and ${max} characters` }]);
  }
  return normalized;
}

function cleanMultilineText(value, { field = 'value', min = 0, max = 5000, required = false } = {}) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (required && normalized.length < Math.max(1, min)) {
    throw new RequestValidationError(`${field} is required`, [{ field, message: `${field} is required` }]);
  }
  if (normalized.length < min || normalized.length > max) {
    throw new RequestValidationError(`Invalid ${field}`, [{ field, message: `${field} must be between ${min} and ${max} characters` }]);
  }
  return normalized;
}

function positiveInteger(value, { field = 'quantity', min = 1, max = 100 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new RequestValidationError(`Invalid ${field}`, [{ field, message: `${field} must be an integer between ${min} and ${max}` }]);
  }
  return number;
}

function finiteMoney(value, { field = 'amount', min = 0, max = 100000000 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RequestValidationError(`Invalid ${field}`, [{ field, message: `${field} must be between ${min} and ${max}` }]);
  }
  return Math.round(number * 100) / 100;
}

function parsePagination(query = {}, { defaultLimit = 20, maxLimit = 100, allowedSorts = ['createdAt'] } = {}) {
  const page = positiveInteger(query.page || 1, { field: 'page', min: 1, max: 1000000 });
  const limit = positiveInteger(query.limit || defaultLimit, { field: 'limit', min: 1, max: maxLimit });
  const requestedSort = String(query.sort || '-createdAt').trim();
  const direction = requestedSort.startsWith('-') ? -1 : 1;
  const sortField = requestedSort.replace(/^-/, '');
  if (!allowedSorts.includes(sortField)) {
    throw new RequestValidationError('Invalid sort field', [{ field: 'sort', message: 'The requested sort field is not allowed' }]);
  }
  return { page, limit, skip: (page - 1) * limit, sort: { [sortField]: direction } };
}

function paginationEnvelope(items, total, page, limit) {
  return {
    items,
    pagination: { page, limit, total, pages: total ? Math.ceil(total / limit) : 0 },
  };
}

module.exports = {
  RequestValidationError,
  assertObjectId,
  cleanMultilineText,
  cleanString,
  finiteMoney,
  paginationEnvelope,
  parsePagination,
  pick,
  positiveInteger,
  rejectUnknown,
};
