// Liveness + readiness endpoints.
//
//   GET /api/health        — liveness. Always 200 when this process can serve
//                             requests. No DB round-trip. Cheap, safe to poll
//                             aggressively.
//   GET /api/health/ready  — readiness. 200 only when the DB is open and
//                             accepts a trivial query, AND the server is not
//                             currently shutting down. Otherwise 503.
//
// All external collaborators (`isShuttingDown`, `pingDb`, `isDbClosed`) are
// injected so this router can be unit-tested without touching the real DB.
import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pingDb as defaultPingDb, isDbClosed as defaultIsDbClosed } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pkgVersion = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  if (pkg && typeof pkg.version === 'string') pkgVersion = pkg.version;
} catch {
  // best-effort; default 'unknown'
}

const startedAt = Date.now();

export function createHealthRouter({
  isShuttingDown = () => false,
  pingDb = defaultPingDb,
  isDbClosed = defaultIsDbClosed,
} = {}) {
  const router = Router();
  const env = process.env.NODE_ENV || 'development';

  router.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      env,
      version: pkgVersion,
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
    });
  });

  router.get('/ready', (_req, res) => {
    const checks = {};
    let ok = true;

    if (isShuttingDown()) {
      checks.shutdown = { ok: false, reason: 'shutting down' };
      ok = false;
    }

    if (isDbClosed()) {
      checks.db = { ok: false, reason: 'database is closed' };
      ok = false;
    } else {
      const r = pingDb();
      if (r.ok) {
        const entry = { ok: true, durationMs: r.durationMs };
        if (r.slow) entry.slow = true;
        checks.db = entry;
      } else {
        checks.db = { ok: false, reason: r.error };
        ok = false;
      }
    }

    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'fail',
      env,
      version: pkgVersion,
      time: new Date().toISOString(),
      checks,
    });
  });

  return router;
}
