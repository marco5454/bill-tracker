import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestApp } from './helpers/route-harness.js';

describe('request-id middleware', () => {
  let ctx;
  before(async () => { ctx = await bootTestApp(); });
  after(async () => { await ctx.close(); });

  test('generates X-Request-Id when client does not send one', async () => {
    const r = await ctx.get('/api/bills');
    assert.equal(r.status, 200);
    const id = r.headers.get('x-request-id');
    assert.ok(id, 'missing X-Request-Id response header');
    // UUID v4 shape
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test('echoes a safe client-supplied X-Request-Id', async () => {
    const desired = 'client-correlation-12345';
    const r = await ctx.get('/api/bills', {
      headers: { 'X-Request-Id': desired },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-request-id'), desired);
  });

  test('rejects unsafe X-Request-Id and replaces with a UUID', async () => {
    const cases = [
      'short',                // <8 chars
      'x'.repeat(80),         // >64 chars
      'has spaces and!sym',   // disallowed chars
      'tab\tinside',           // control char (still sendable as header)
    ];
    for (const bad of cases) {
      const r = await ctx.get('/api/bills', {
        headers: { 'X-Request-Id': bad },
      });
      assert.equal(r.status, 200);
      const got = r.headers.get('x-request-id');
      assert.notEqual(got, bad, `accepted unsafe id: ${JSON.stringify(bad)}`);
      assert.match(got, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
  });

  test('each request gets a distinct id when no header is supplied', async () => {
    const r1 = await ctx.get('/api/bills');
    const r2 = await ctx.get('/api/bills');
    assert.notEqual(r1.headers.get('x-request-id'), r2.headers.get('x-request-id'));
  });
});
