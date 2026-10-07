import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

export function notFound(req, res) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let status = err.status || 500;
  let message = err.message || 'Internal server error';
  let details = err.details;
  if (err.name === 'ValidationError') {
    status = 400;
    details = Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message]));
    message = 'Validation failed';
  } else if (err.name === 'CastError') {
    status = 400;
    message = `Invalid value for ${err.path}`;
  } else if (err.code === 11000) {
    status = 409;
    message = `Duplicate value: ${Object.keys(err.keyValue || {}).join(', ')} already exists`;
    details = err.keyValue;
  } else if (err.name === 'MulterError') {
    status = 400;
  }
  if (status >= 500) logger.error(req.method, req.originalUrl, err);
  res.status(status).json({ message: status >= 500 && env.isProd ? 'Internal server error' : message, details });
}
