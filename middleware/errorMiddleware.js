const { ApiError } = require('../utils/apiError');
const { log } = require('../utils/logger');

function notFound(req, res, next) {
  const error = new ApiError('NOT_FOUND', `Not found - ${req.originalUrl}`);
  next(error);
}

function send(res, statusCode, code, message, extra = {}) {
  return res.status(statusCode).json({
    success: false,
    code,
    message,
    ...extra,
  });
}

function errorHandler(error, req, res, next) { // eslint-disable-line no-unused-vars
  if (error instanceof ApiError) {
    return send(res, error.statusCode, error.errorCode, error.message, error.details ? { details: error.details } : {});
  }
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue || {})[0] || 'field';
    return send(res, 400, 'DUPLICATE_KEY', `${field} already exists`);
  }
  if (error.name === 'ValidationError') {
    return send(res, 400, 'VALIDATION_ERROR', Object.values(error.errors).map((item) => item.message).join(', '));
  }
  if (error.name === 'CastError') {
    return send(res, 400, 'VALIDATION_ERROR', `Invalid ${error.path}`);
  }
  if (error.message?.includes('Only jpg')) {
    return send(res, 400, 'VALIDATION_ERROR', error.message);
  }
  if (error.code === 'LIMIT_FILE_SIZE') {
    return send(res, 400, 'VALIDATION_ERROR', 'Uploaded file is too large.');
  }
  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
    return send(res, 400, 'VALIDATION_ERROR', 'Too many images uploaded. Maximum 8 images are allowed.');
  }
  if (error.message?.includes('R2')) {
    return send(res, 502, 'STORAGE_ERROR', error.message);
  }

  const statusCode = error.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);
  const isServerError = statusCode >= 500;
  const safeMessage = isServerError && process.env.NODE_ENV === 'production'
    ? 'The request could not be completed. Please try again.'
    : error.message;

  if (isServerError) {
    log('error', error.message, {
      requestId: req.requestId,
      userId: req.user?._id,
      storeId: req.store?._id,
      method: req.method,
      path: req.originalUrl,
    });
  }

  return send(res, statusCode, error.errorCode || error.code || (isServerError ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'), safeMessage, {
    stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
  });
}

module.exports = { notFound, errorHandler };
