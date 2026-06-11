import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { billsRouter }    from './routes/bills.js';
import { creditsRouter }  from './routes/credits.js';
import { settingsRouter } from './routes/settings.js';
import { createHealthRouter } from './routes/health.js';
import { errorHandler, notFound } from './middleware/error.js';
import { requestId } from './middleware/request-id.js';
import { accessLog } from './middleware/access-log.js';
import { createCsrfGuard } from './middleware/csrf.js';
import { logger } from './logger.js';
import { closeDb, isDbClosed, backupOnStart } from './db.js'; // import side-effect initializes DB + runs migrations

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT     = Number(process.env.PORT || 3000);
const HOST     = process.env.HOST || '127.0.0.1';
const NODE_ENV = process.env.NODE_ENV || 'development';

// --- Trust model -------------------------------------------------------------
// This app has NO authentication. The default deployment binds to 127.0.0.1 so
// only the local user can reach it. Operators who flip HOST to a non-loopback
// address must opt in explicitly via BILLTRACKER_ALLOW_NETWORK=1, which prints
// a loud warning. This prevents accidentally exposing an unauthenticated CRUD
// API to the LAN by setting a single env var.
function isLoopbackHost(h) {
  if (!h) return true;
  const lower = h.toLowerCase();
  return lower === '127.0.0.1' || lower === 'localhost' || lower === '::1' || lower === '::ffff:127.0.0.1';
}

if (!isLoopbackHost(HOST) && process.env.BILLTRACKER_ALLOW_NETWORK !== '1') {
  logger.error('refusing to start on a non-loopback HOST without BILLTRACKER_ALLOW_NETWORK=1', {
    host: HOST,
    hint: 'This app has no authentication. Set BILLTRACKER_ALLOW_NETWORK=1 only on a trusted, isolated network.',
  });
  process.exit(2);
}

// Allowed Host header values to mitigate DNS rebinding against a localhost
// service. Comma-separated env override; default covers the typical loopback
// names plus the configured HOST:PORT.
const HOST_ALLOWLIST = (() => {
  const fromEnv = (process.env.BILLTRACKER_HOST_ALLOWLIST || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const defaults = new Set([
    `localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`,
    'localhost', '127.0.0.1', '[::1]',
  ]);
  if (!isLoopbackHost(HOST)) {
    defaults.add(`${HOST}:${PORT}`.toLowerCase());
    defaults.add(HOST.toLowerCase());
  }
  for (const v of fromEnv) defaults.add(v);
  return defaults;
})();

const app = express();

// Express strips X-Powered-By header so we don't advertise the stack.
app.disable('x-powered-by');

// Trust proxy is OFF by default. Even 'loopback' allows X-Forwarded-For
// spoofing from any local-user process, which would let a co-tenant on a
// shared machine bypass per-IP rate limiters by forging that header. Operators
// who *do* run a real reverse proxy should set BILLTRACKER_TRUST_PROXY to a
// concrete IP (or 'loopback') and document the assumption.
const TRUST_PROXY = process.env.BILLTRACKER_TRUST_PROXY;
if (TRUST_PROXY && TRUST_PROXY !== '0' && TRUST_PROXY.toLowerCase() !== 'false') {
  app.set('trust proxy', TRUST_PROXY);
} else {
  app.set('trust proxy', false);
}

// Per-request id + structured access log run first so all subsequent
// middleware (including helmet/cors) can be correlated in logs.
app.use(requestId);
app.use(accessLog);

// DNS-rebinding mitigation: reject requests whose Host header isn't in the
// allowlist. Health/static can still serve when the operator scripts a
// different name by extending BILLTRACKER_HOST_ALLOWLIST.
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (!host || !HOST_ALLOWLIST.has(host)) {
    if (req.log) req.log.warn('host.header.rejected', { host });
    return res.status(421).json({ error: 'Misdirected request: Host header not allowed' });
  }
  return next();
});

// CSRF mitigation. The API has no authentication, so a malicious page the
// user visits in any browser on the same machine could otherwise issue
// state-changing requests against http://127.0.0.1:3000/api/* using "simple
// requests" (form-urlencoded POSTs without a preflight). See middleware/csrf.js
// for the full rationale.
app.use('/api', createCsrfGuard({ allowedHosts: HOST_ALLOWLIST }));


// HSTS and CSP upgrade-insecure-requests are disabled because this app is designed
// for plain-HTTP loopback use; emitting HSTS over HTTP is meaningless, and the
// upgrade directive would silently rewrite any future http:// URL to https://.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src':  ["'self'"],
      'script-src':   ["'self'"],
      'script-src-attr': ["'none'"],
      'style-src':    ["'self'"],
      'style-src-attr': ["'none'"],
      'font-src':     ["'self'"],
      'img-src':      ["'self'", 'data:'],
      'connect-src':  ["'self'"],
      'object-src':   ["'none'"],
      'form-action':  ["'self'"],
      'frame-ancestors': ["'none'"],
      'base-uri':     ["'self'"]
    }
  },
  strictTransportSecurity: false,
  crossOriginEmbedderPolicy: false
}));

app.use(compression());

// Shutdown flag - declared early so middleware below can reference it.
let shuttingDown = false;

// --- Rate limiters (BEFORE body parsing) -------------------------------------
// Limiters must run before express.json so an attacker cannot force the parser
// to allocate memory for oversized bodies before the limit applies. Limiters
// only inspect headers/IP so they work fine pre-parse.
const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  return writeLimiter(req, res, next);
});

// Stricter limiter on destructive / heavy settings endpoints. Applied to both
// the GET export (bypasses the write limiter above) and the destructive
// import/reset POSTs. 10 requests / 5 min / IP is plenty for a human and far
// too few for a brute-force or scrape.
const sensitiveSettingsLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sensitive operations, slow down' },
});
app.use('/api/settings/export', sensitiveSettingsLimiter);
app.use('/api/settings/import', sensitiveSettingsLimiter);
app.use('/api/settings/reset',  sensitiveSettingsLimiter);

// --- Body parsing (AFTER limiters) -------------------------------------------
// Most endpoints have tiny bodies (a single bill/credit row tops out around
// ~1.3 KB). Only /api/settings/import legitimately needs a multi-MB payload.
// Cap the global parser tightly and mount the larger parser only on the
// import route, which is already gated by sensitiveSettingsLimiter above.
app.use('/api/settings/import', express.json({ limit: '5mb' }));
app.use(express.json({ limit: '200kb' }));

// Reject new requests once shutdown begins.
app.use((_req, res, next) => {
  if (shuttingDown) {
    res.set('Connection', 'close');
    return res.status(503).json({ error: 'Server shutting down' });
  }
  return next();
});

// --- LAN exposure split ------------------------------------------------------
// When the operator binds to a non-loopback HOST (to serve the PWA shell to
// phones on the LAN) we still keep the unauthenticated CRUD API loopback-only
// by default. Phones load the static shell over LAN, the service worker
// caches it, and the in-app probe of /api/health returns 403 -> the client
// transparently switches to its local IndexedDB store.
//
// Operators who *do* want LAN clients to talk to the API (single-trusted-LAN
// scenarios) opt in with BILLTRACKER_API_LAN=1.
const API_LAN = process.env.BILLTRACKER_API_LAN === '1';
function isLoopbackIp(ip) {
  if (!ip) return false;
  // express normalises to '::ffff:127.0.0.1' for IPv4-mapped IPv6
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
app.use('/api', (req, res, next) => {
  if (API_LAN) return next();
  if (isLoopbackIp(req.ip)) return next();
  if (req.log) req.log.warn('api.lan.rejected', { ip: req.ip, path: req.path });
  return res.status(403).json({ error: 'API restricted to loopback. Set BILLTRACKER_API_LAN=1 to expose.' });
});

// Health (liveness + readiness)
app.use('/api/health', createHealthRouter({ isShuttingDown: () => shuttingDown }));

// API routes
app.use('/api/bills',    billsRouter);
app.use('/api/credits',  creditsRouter);
app.use('/api/settings', settingsRouter);

// In production, also serve the built client.
const distDir = join(__dirname, '..', 'dist');
if (NODE_ENV === 'production' && existsSync(distDir)) {
  app.use(express.static(distDir, { index: 'index.html', maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(distDir, 'index.html')));
}

// 404 + error handling
app.use('/api', notFound);
app.use(errorHandler);

const server = app.listen(PORT, HOST, () => {
  logger.info('billtracker.api.listening', {
    host: HOST, port: PORT, env: NODE_ENV,
    network: !isLoopbackHost(HOST),
  });
  // Run the on-start DB snapshot after the server starts accepting
  // connections. A slow disk (network mount, throttled volume) shouldn't
  // delay readiness; backupOnStart already swallows IO failures internally.
  backupOnStart().catch((err) => {
    logger.warn('backup.onstart.failed', { error: err });
  });
});

// Tighten socket-level timeouts so a stuck client cannot hold a connection
// open through shutdown forever.
server.headersTimeout    = 65_000; // must exceed keepAliveTimeout
server.keepAliveTimeout  = 60_000;
server.requestTimeout    = 60_000;

// --- Graceful shutdown -------------------------------------------------------
// On SIGINT/SIGTERM:
//   1. Set shuttingDown so new requests get 503.
//   2. server.close() stops accepting new connections and waits for active ones.
//   3. After SHUTDOWN_TIMEOUT_MS, force-close remaining sockets.
//   4. Checkpoint + close the database.
//   5. Exit with 0 (clean) or 1 (forced/errored).
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10_000);

function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('billtracker.shutdown.start', { reason });

  let exited = false;
  const finish = (code) => {
    if (exited) return;
    exited = true;
    try {
      if (!isDbClosed()) closeDb();
    } catch (e) {
      logger.error('billtracker.shutdown.db_close_failed', { error: e });
    }
    logger.info('billtracker.shutdown.complete', { code });
    process.exit(code);
  };

  // Hard timeout: if anything is wedged, force exit.
  const timer = setTimeout(() => {
    logger.warn('billtracker.shutdown.timeout', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    try { server.closeAllConnections?.(); } catch {}
    finish(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();

  // Stop accepting new connections; wait for in-flight to finish.
  server.close((err) => {
    clearTimeout(timer);
    if (err) {
      logger.error('billtracker.shutdown.close_error', { error: err });
      return finish(1);
    }
    finish(exitCode);
  });

  // Drop idle keep-alive connections immediately so close() doesn't wait on them.
  try { server.closeIdleConnections?.(); } catch {}
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('billtracker.uncaughtException', { error: err });
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('billtracker.unhandledRejection', { error: reason });
  shutdown('unhandledRejection', 1);
});
