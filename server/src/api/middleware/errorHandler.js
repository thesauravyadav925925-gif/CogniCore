const logger = require('../../config/logger');

function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const payload = {
    error: true,
    message: err.message || 'Internal server error',
    name: err.name || 'Error',
  };
  if (process.env.NODE_ENV === 'development' && err.stack) {
    payload.stack = err.stack;
  }
  logger.error(`${req.method} ${req.originalUrl} -> ${err.message}`, { status, name: err.name });
  res.status(status).json(payload);
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: true, message: `Route not found: ${req.method} ${req.originalUrl}` });
}

module.exports = { errorHandler, notFoundHandler };
