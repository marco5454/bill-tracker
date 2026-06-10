// Centralized error handler. Never leaks stack traces to clients.
export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  const payload = {
    error: err.publicMessage || (status >= 500 ? 'Internal server error' : err.message || 'Bad request')
  };
  if (err.details) payload.details = err.details;
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(`[${new Date().toISOString()}]`, req.method, req.path, err);
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
