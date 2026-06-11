// Helpers for route tests: spin up an isolated Express app backed by a fresh
// temp SQLite database so tests do not touch the project's real data dir.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

import { errorHandler, notFound } from '../../server/middleware/error.js';
import { requestId } from '../../server/middleware/request-id.js';

/**
 * Boot an isolated app + listening server bound to 127.0.0.1 on a random port.
 *
 * Usage:
 *   const ctx = await bootTestApp();
 *   await fetch(`${ctx.baseUrl}/api/bills`);
 *   await ctx.close();
 *
 * Each call creates a fresh temp data dir; importing the routes triggers a
 * one-time DB module load. To keep tests truly isolated we cache-bust by
 * appending a query string to the dynamic import URL.
 */
export async function bootTestApp() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'billtracker-test-'));
  process.env.BILLTRACKER_DATA_DIR = tmpDir;

  // Cache-bust each module so a fresh DB is opened against the new dir.
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2);
  const billsMod    = await import(`../../server/routes/bills.js?t=${stamp}`);
  const creditsMod  = await import(`../../server/routes/credits.js?t=${stamp}`);
  const settingsMod = await import(`../../server/routes/settings.js?t=${stamp}`);
  const healthMod   = await import(`../../server/routes/health.js?t=${stamp}`);
  const dbMod       = await import(`../../server/db.js?t=${stamp}`);

  let shuttingDown = false;

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(requestId);
  app.use('/api/health', healthMod.createHealthRouter({ isShuttingDown: () => shuttingDown }));
  app.use('/api/bills',    billsMod.billsRouter);
  app.use('/api/credits',  creditsMod.creditsRouter);
  app.use('/api/settings', settingsMod.settingsRouter);
  app.use('/api', notFound);
  app.use(errorHandler);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.once('listening', res));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    tmpDir,
    db: dbMod,
    setShuttingDown(v) { shuttingDown = !!v; },
    async get(path, init) {
      const r = await fetch(baseUrl + path, init);
      const text = await r.text();
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: r.status, body, headers: r.headers };
    },
    async send(method, path, body, extraHeaders) {
      const r = await fetch(baseUrl + path, {
        method,
        headers: { 'content-type': 'application/json', ...(extraHeaders || {}) },
        body: body == null ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let json;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: r.status, body: json, headers: r.headers };
    },
    async close() {
      await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));
      try { dbMod.closeDb(); } catch {}
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    },
  };
}
