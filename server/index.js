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
import { errorHandler, notFound } from './middleware/error.js';
import { closeDb } from './db.js'; // import side-effect initializes DB

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT     = Number(process.env.PORT || 3000);
const HOST     = process.env.HOST || '127.0.0.1';
const NODE_ENV = process.env.NODE_ENV || 'development';

const app = express();

app.disable('x-powered-by');

// Security headers. CSP allows only same-origin assets + Google Fonts (used by Inter).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src':  ["'self'"],
      'script-src':   ["'self'"],
      'style-src':    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src':     ["'self'", 'https://fonts.gstatic.com'],
      'img-src':      ["'self'", 'data:'],
      'connect-src':  ["'self'"],
      'object-src':   ["'none'"],
      'frame-ancestors': ["'none'"],
      'base-uri':     ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(compression());
app.use(express.json({ limit: '5mb' }));

// Shutdown flag - declared early so middleware below can reference it.
let shuttingDown = false;

// Reasonable rate limit on writes only.
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

// Reject new requests once shutdown begins.
app.use((_req, res, next) => {
  if (shuttingDown) {
    res.set('Connection', 'close');
    return res.status(503).json({ error: 'Server shutting down' });
  }
  return next();
});

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true, env: NODE_ENV }));

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
  // eslint-disable-next-line no-console
  console.log(`[billtracker] api listening on http://${HOST}:${PORT}  (${NODE_ENV})`);
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
  // eslint-disable-next-line no-console
  console.log(`[billtracker] shutting down (${reason})…`);

  let exited = false;
  const finish = (code) => {
    if (exited) return;
    exited = true;
    try { closeDb(); } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[billtracker] error closing db:', e);
    }
    // eslint-disable-next-line no-console
    console.log(`[billtracker] shutdown complete (exit ${code}).`);
    process.exit(code);
  };

  // Hard timeout: if anything is wedged, force exit.
  const timer = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.warn(`[billtracker] shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit.`);
    try { server.closeAllConnections?.(); } catch {}
    finish(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();

  // Stop accepting new connections; wait for in-flight to finish.
  server.close((err) => {
    clearTimeout(timer);
    if (err) {
      // eslint-disable-next-line no-console
      console.error('[billtracker] server.close error:', err);
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
  // eslint-disable-next-line no-console
  console.error('[billtracker] uncaughtException:', err);
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[billtracker] unhandledRejection:', reason);
  shutdown('unhandledRejection', 1);
});
