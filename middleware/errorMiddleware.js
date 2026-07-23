function notFound(req, res, next) {
  const error = new Error(`Not found - ${req.originalUrl}`);
  res.status(404);
  next(error);
}

function errorHandler(error, req, res, next) {
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue || {})[0] || 'field';
    return res.status(400).json({ message: `${field} already exists` });
  }
  if (error.name === 'ValidationError') {
    return res.status(400).json({ message: Object.values(error.errors).map((item) => item.message).join(', ') });
  }
  if (error.message?.includes('Only jpg')) {
    return res.status(400).json({ message: error.message });
  }
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'Uploaded file is too large.' });
  }
  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ message: 'Too many images uploaded. Maximum 8 images are allowed.' });
  }
  if (error.message?.includes('R2')) {
    return res.status(502).json({ message: error.message });
  }
  const statusCode = error.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);
  const safeMessage = statusCode >= 500 && process.env.NODE_ENV === 'production'
    ? 'The request could not be completed. Please try again.'
    : error.message;
  res.status(statusCode).json({
    message: safeMessage,
    code: error.code,
    stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
  });
}

module.exports = { notFound, errorHandler };
