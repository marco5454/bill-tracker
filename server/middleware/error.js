// Centralized error handler. Never leaks stack traces to clients.
import { logger } from '../logger.js';

export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  const payload = {
    error: err.publicMessage || (status >= 500 ? 'Internal server error' : err.message || 'Bad request')
  };
  if (err.details) payload.details = err.details;
  if (status >= 500) {
    // Route 5xx through the structured logger (with request-scoped child if
    // present) so server errors share log fields and reqId with their access
    // log line. Falling back to the root logger keeps tests/non-request
    // contexts safe.
    const log = (req && req.log) || logger;
    log.error('http.unhandled_error', {
      method: req && req.method,
      path: req && req.path,
      status,
      error: err,
    });
  }
  res.status(status).json(payload);
}

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.publicMessage = message;
    if (details) this.details = details;
  }
}

export function notFound(_req, res) {
  res.status(404).json({ error: 'Not found' });
}
