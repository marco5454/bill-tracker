// Lightweight access logger. Logs at request start (debug) and on response
// finish (info / warn / error depending on status). Health-check polling is
// demoted to debug to avoid drowning the log stream.
import { performance } from 'node:perf_hooks';

const HEALTH_PATH = '/api/health';

export function accessLog(req, res, next) {
  const log = req.log;
  if (!log) return next(); // request-id must run before us; degrade gracefully

  const startedAt = performance.now();
  // Capture the full path at request entry. Once Express dispatches into a
  // subrouter, req.path becomes relative to the mount, so we anchor on
  // originalUrl (sans query string) for stable, accurate access records.
  const fullPath = (req.originalUrl || req.url || '').split('?')[0] || '/';
  const isHealth = fullPath === HEALTH_PATH;

  log.debug('http.request.received', {
    method: req.method,
    path: fullPath,
    ip: req.ip,
  });

  let recorded = false;
  const finalize = () => {
    if (recorded) return;
    recorded = true;
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const status = res.statusCode;
    const fields = {
      method: req.method,
      path: fullPath,
      status,
      durationMs,
      ip: req.ip,
    };
    const lenHeader = res.getHeader('Content-Length');
    if (lenHeader != null) fields.contentLength = Number(lenHeader);

    if (status >= 500) log.error('http.request.completed', fields);
    else if (status >= 400) log.warn('http.request.completed', fields);
    else if (isHealth) log.debug('http.request.completed', fields);
    else log.info('http.request.completed', fields);
  };

  res.on('finish', finalize);
  res.on('close', finalize);
  next();
}
