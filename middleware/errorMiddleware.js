function notFound(req, res, next) {
  const error = new Error('Route not found');
  error.statusCode = 404;
  error.code = 'ROUTE_NOT_FOUND';
  next(error);
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const normalized = normalizeError(error, res.statusCode);
  req.log?.[normalized.statusCode >= 500 ? 'error' : 'warn']?.({
    event: 'request_error',
    code: normalized.code,
    status: normalized.statusCode,
    error,
  });
  if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
  return res.status(normalized.statusCode).json({
    message: normalized.message,
    code: normalized.code,
    details: normalized.details,
    requestId: req.id,
    stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
  });
}

function normalizeError(error, currentStatus) {
  if (error.code === 11000) {
    const field = Object.keys(error.keyPattern || error.keyValue || {})[0] || 'field';
    return { statusCode: 409, code: 'DUPLICATE_VALUE', message: `${field} already exists` };
  }
  if (error.name === 'ValidationError') {
    return {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: Object.entries(error.errors || {}).map(([field, item]) => ({ field, message: item.message })),
    };
  }
  if (error.name === 'CastError') {
    return { statusCode: 400, code: 'INVALID_IDENTIFIER', message: 'Invalid resource identifier' };
  }
  if (error instanceof SyntaxError && error.type === 'entity.parse.failed') {
    return { statusCode: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON' };
  }
  if (error.code === 'LIMIT_FILE_SIZE') {
    return { statusCode: 413, code: 'UPLOAD_TOO_LARGE', message: 'Uploaded file exceeds the size limit' };
  }
  if (['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE', 'LIMIT_PART_COUNT', 'LIMIT_FIELD_COUNT'].includes(error.code)) {
    return { statusCode: 400, code: 'UPLOAD_LIMIT_EXCEEDED', message: 'Upload request exceeds the allowed limits' };
  }
  const requestedStatus = Number(error.statusCode || (currentStatus >= 400 ? currentStatus : 500));
  const statusCode = requestedStatus >= 400 && requestedStatus <= 599 ? requestedStatus : 500;
  const safeClientError = statusCode < 500;
  return {
    statusCode,
    code: String(error.code || (safeClientError ? 'REQUEST_FAILED' : 'INTERNAL_ERROR')).slice(0, 80),
    message: safeClientError ? String(error.message || 'Request failed').slice(0, 500) : 'An unexpected error occurred',
    details: safeClientError && Array.isArray(error.details) ? error.details : undefined,
  };
}

module.exports = { errorHandler, notFound, normalizeError };
