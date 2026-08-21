const { newRequestId } = require('../utils/logger');

function requestContext(req, res, next) {
  req.requestId = String(req.headers['x-request-id'] || '').trim() || newRequestId();
  res.setHeader('x-request-id', req.requestId);
  next();
}

module.exports = { requestContext };
