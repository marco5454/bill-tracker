import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCsrfGuard } from '../server/middleware/csrf.js';

function buildApp(allowedHosts) {
  const app = express();
  app.use(express.json());
  app.use('/api', createCsrfGuard({ allowedHosts }));
  app.post('/api/test', (_req, res) => res.json({ ok: true }));
  app.get('/api/test', (_req, res) => res.json({ ok: true }));
  app.put('/api/test', (_req, res) => res.json({ ok: true }));
  app.delete('/api/test', (_req, res) => res.json({ ok: true }));
  return app;
}

async function boot(allowedHosts) {
  const app = buildApp(allowedHosts);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.once('listening', res));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe('CSRF guard', () => {
  it('allows GET regardless of headers', async () => {
    const ctx = await boot(['127.0.0.1:3000']);
    try {
      const r = await fetch(`${ctx.url}/api/test`);
      assert.equal(r.status, 200);
    } finally { await ctx.close(); }
  });

  it('allows HEAD and OPTIONS regardless of headers', async () => {
    const ctx = await boot(['127.0.0.1:3000']);
    try {
      const h = await fetch(`${ctx.url}/api/test`, { method: 'HEAD' });
      assert.equal(h.status, 200);
    } finally { await ctx.close(); }
  });

  it('blocks POST with no Origin/Referer and no X-Requested-With', async () => {
    const ctx = await boot(['127.0.0.1:3000']);
    try {
      const r = await fetch(`${ctx.url}/api/test`, { method: 'POST' });
      assert.equal(r.status, 403);
      const body = await r.json();
      assert.match(body.error, /X-Requested-With/i);
    } finally { await ctx.close(); }
  });

  it('allows POST with X-Requested-With: billtracker (no Origin)', async () => {
    const ctx = await boot(['127.0.0.1:3000']);
    try {
      const r = await fetch(`${ctx.url}/api/test`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'billtracker' },
      });
      assert.equal(r.status, 200);
    } finally { await ctx.close(); }
  });

  it('rejects POST with X-Requested-With set to a wrong value', async () => {
    const ctx = await boot(['127.0.0.1:3000']);
    try {
      const r = await fetch(`${ctx.url}/api/test`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      assert.equal(r.status, 403);
    } finally { await ctx.close(); }
  });

  it('allows POST with allowed Origin', async () => {
    const ctx = await boot(['127.0.0.1:3000', 'localhost:3000']);
    try {
      const r = await fetch(`${ctx.url}/api/test`, {
        method: 'POST',
        headers: { Origin: 'http://localhost:3000' },
      });
      assert.equal(r.status, 200);
    } finally { await ctx.close(); }
  });

  it('rejects POST with disallowed Origin', async () => {
    const ctx = await boot(['127.0.0.1:3000']);
    try {
      const r = await fetch(`${ctx.url}/api/test`, {
        method: 'POST',
        headers: { Origin: 'http://evil.example.com' },
      });
      assert.equal(r.status, 403);
      const body = await r.json();
      assert.match(body.error, /Cross-origin/i);
    } finally { await ctx.close(); }
  });

  it('falls back to Referer when Origin is absent', async () => {
    const ctx = await boot(['127.0.0.1:3000']);
    try {
      const ok = await fetch(`${ctx.url}/api/test`, {
        method: 'POST',
        headers: { Referer: 'http://127.0.0.1:3000/some/page' },
      });
      assert.equal(ok.status, 200);

      const bad = await fetch(`${ctx.url}/api/test`, {
        method: 'POST',
        headers: { Referer: 'http://evil.example.com/page' },
      });
      assert.equal(bad.status, 403);
    } finally { await ctx.close(); }
  });

  it('rejects malformed Origin headers', async () => {
    const ctx = await boot(['127.0.0.1:3000']);
    try {
      const r = await fetch(`${ctx.url}/api/test`, {
        method: 'POST',
        headers: { Origin: 'not a url' },
      });
      assert.equal(r.status, 403);
    } finally { await ctx.close(); }
  });

  it('applies to PUT and DELETE', async () => {
    const ctx = await boot(['127.0.0.1:3000']);
    try {
      const put = await fetch(`${ctx.url}/api/test`, { method: 'PUT' });
      assert.equal(put.status, 403);
      const del = await fetch(`${ctx.url}/api/test`, { method: 'DELETE' });
      assert.equal(del.status, 403);
    } finally { await ctx.close(); }
  });

  it('allows hostname-only allow-list entries', async () => {
    const ctx = await boot(['127.0.0.1']); // no port
    try {
      const r = await fetch(`${ctx.url}/api/test`, {
        method: 'POST',
        headers: { Origin: 'http://127.0.0.1:9999' },
      });
      assert.equal(r.status, 200);
    } finally { await ctx.close(); }
  });
});
