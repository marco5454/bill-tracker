// Assigns a request ID to every incoming request and attaches a child logger.
//
//   - If the client sends `X-Request-Id` and it looks safe (8..64 chars,
//     alphanumeric / dash / underscore only), we honor it. Anything else is
//     replaced with a freshly generated UUID v4.
//   - The chosen id is echoed back in the `X-Request-Id` response header so
//     clients can correlate retries against server logs.
//   - `req.id` and `req.log` are set for downstream handlers.
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';

const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function requestId(req, res, next) {
  const incoming = req.get && req.get('X-Request-Id');
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  req.log = logger.child({ reqId: id });
  next();
}
