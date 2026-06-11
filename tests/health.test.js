import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { bootTestApp } from './helpers/route-harness.js';
import { createHealthRouter } from '../server/routes/health.js';

// Helpers ---------------------------------------------------------------

function startApp(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        async get(path) {
          const r = await fetch(`http://127.0.0.1:${port}${path}`);
          const text = await r.text();
          return { status: r.status, body: text ? JSON.parse(text) : null };
        },
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function mountHealth(opts) {
  const app = express();
  app.use('/api/health', createHealthRouter(opts));
  return startApp(app);
}

// Liveness via the standard harness -------------------------------------

describe('GET /api/health (liveness)', () => {
  let ctx;
  before(async () => { ctx = await bootTestApp(); });
  after(async () => { await ctx.close(); });

  test('returns 200 with required fields', async () => {
    const r = await ctx.get('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.ok(typeof r.body.env === 'string');
    assert.ok(typeof r.body.version === 'string');
    assert.ok(typeof r.body.uptimeS === 'number' && r.body.uptimeS >= 0);
    assert.match(r.body.time, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('still 200 even when shutdown flag is set', async () => {
    ctx.setShuttingDown(true);
    try {
      const r = await ctx.get('/api/health');
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'ok');
    } finally {
      ctx.setShuttingDown(false);
    }
  });
});

// Readiness with injected dependencies (no real DB needed). This avoids
// poisoning other tests by closing the shared db module.

describe('GET /api/health/ready', () => {
  test('200 when DB ping succeeds and not shutting down', async () => {
    const ctx = await mountHealth({
      isShuttingDown: () => false,
      pingDb: () => ({ ok: true, durationMs: 0.42 }),
      isDbClosed: () => false,
    });
    try {
      const r = await ctx.get('/api/health/ready');
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'ok');
      assert.equal(r.body.checks.db.ok, true);
      assert.equal(r.body.checks.db.durationMs, 0.42);
      assert.ok(!('shutdown' in r.body.checks));
    } finally {
      await ctx.close();
    }
  });

  test('503 when shutting down (reports shutdown check failed)', async () => {
    const ctx = await mountHealth({
      isShuttingDown: () => true,
      pingDb: () => ({ ok: true, durationMs: 0.5 }),
      isDbClosed: () => false,
    });
    try {
      const r = await ctx.get('/api/health/ready');
      assert.equal(r.status, 503);
      assert.equal(r.body.status, 'fail');
      assert.equal(r.body.checks.shutdown.ok, false);
      // db ping still ran and is healthy
      assert.equal(r.body.checks.db.ok, true);
    } finally {
      await ctx.close();
    }
  });

  test('503 when DB is closed (skips ping)', async () => {
    let pingCalled = false;
    const ctx = await mountHealth({
      isShuttingDown: () => false,
      pingDb: () => { pingCalled = true; return { ok: true }; },
      isDbClosed: () => true,
    });
    try {
      const r = await ctx.get('/api/health/ready');
      assert.equal(r.status, 503);
      assert.equal(r.body.status, 'fail');
      assert.equal(r.body.checks.db.ok, false);
      assert.match(r.body.checks.db.reason, /closed/i);
      assert.equal(pingCalled, false, 'pingDb should be skipped when isDbClosed() returns true');
    } finally {
      await ctx.close();
    }
  });

  test('503 when DB ping reports an error', async () => {
    const ctx = await mountHealth({
      isShuttingDown: () => false,
      pingDb: () => ({ ok: false, error: 'disk I/O error' }),
      isDbClosed: () => false,
    });
    try {
      const r = await ctx.get('/api/health/ready');
      assert.equal(r.status, 503);
      assert.equal(r.body.status, 'fail');
      assert.equal(r.body.checks.db.ok, false);
      assert.equal(r.body.checks.db.reason, 'disk I/O error');
    } finally {
      await ctx.close();
    }
  });
});

// pingDb() unit test against the real DB via the harness ----------------

describe('pingDb()', () => {
  test('returns ok=true with a numeric durationMs on a live db', async () => {
    const ctx = await bootTestApp();
    try {
      const r = ctx.db.pingDb();
      assert.equal(r.ok, true);
      assert.ok(typeof r.durationMs === 'number' && r.durationMs >= 0);
    } finally {
      await ctx.close();
    }
  });
});
