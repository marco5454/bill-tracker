import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestApp } from './helpers/route-harness.js';

let ctx;
before(async () => { ctx = await bootTestApp(); });
after(async () => { await ctx?.close(); });

describe('GET /api/settings', () => {
  it('returns default currency when none set', async () => {
    const { status, body } = await ctx.get('/api/settings');
    assert.equal(status, 200);
    assert.equal(body.currency, '\u20b1');
  });
});

describe('PUT /api/settings', () => {
  it('updates currency', async () => {
    const { status, body } = await ctx.send('PUT', '/api/settings', { currency: '$' });
    assert.equal(status, 200);
    assert.equal(body.currency, '$');

    const { body: read } = await ctx.get('/api/settings');
    assert.equal(read.currency, '$');
  });

  it('rejects empty currency', async () => {
    const { status } = await ctx.send('PUT', '/api/settings', { currency: '' });
    assert.equal(status, 400);
  });

  it('rejects too-long currency', async () => {
    const { status } = await ctx.send('PUT', '/api/settings', { currency: '123456789' });
    assert.equal(status, 400);
  });
});

describe('GET /api/settings/export + POST /api/settings/import', () => {
  it('round-trips bills and credits', async () => {
    // Seed some data
    const billRes = await ctx.send('POST', '/api/bills', {
      name: 'Rent', amount: 25000, dueDay: 1,
      recurrence: 'Monthly', category: 'Rent', notes: '',
    });
    assert.equal(billRes.status, 201);
    await ctx.send(
      'POST', `/api/bills/${billRes.body.id}/payments/2026-06/toggle`, null,
      { 'If-Match': `"${billRes.body.version}"` },
    );

    const creditRes = await ctx.send('POST', '/api/credits', {
      name: 'Loan X', lender: 'Bank Z', principal: 50000, ratePct: 6,
      interestType: 'simple', termMonths: 6,
      startDate: '2026-01-01', endDate: '2026-07-01', notes: '',
    });
    assert.equal(creditRes.status, 201);

    // Export
    const exp = await ctx.get('/api/settings/export');
    assert.equal(exp.status, 200);
    assert.equal(exp.body.version, 1);
    assert.equal(exp.body.bills.length, 1);
    assert.equal(exp.body.credits.length, 1);
    assert.equal(exp.body.billPayments.length, 1);

    // Reset (clears tables)
    await ctx.send('POST', '/api/settings/reset', { confirm: 'reset' });
    const empty = await ctx.get('/api/bills');
    assert.deepEqual(empty.body, []);

    // Re-import the snapshot
    const imp = await ctx.send('POST', '/api/settings/import', exp.body);
    assert.equal(imp.status, 200);
    assert.deepEqual(imp.body, { ok: true });

    // Verify data restored
    const billsBack = await ctx.get('/api/bills');
    assert.equal(billsBack.body.length, 1);
    assert.equal(billsBack.body[0].name, 'Rent');
    assert.deepEqual(billsBack.body[0].payments, ['2026-06']);

    const creditsBack = await ctx.get('/api/credits');
    assert.equal(creditsBack.body.length, 1);
    assert.equal(creditsBack.body[0].name, 'Loan X');
  });

  it('rejects an import with a malformed bill row', async () => {
    const bad = {
      version: 1, exportedAt: new Date().toISOString(),
      settings: { currency: '\u20b1' },
      bills: [{ id: 'x', name: 'A', recurrence: 'NotARealCadence' }],
      billPayments: [], credits: [], creditPayments: [],
    };
    const { status, body } = await ctx.send('POST', '/api/settings/import', bad);
    assert.equal(status, 400);
    assert.match(body.error, /bill row/i);
  });

  it('rejects an import with a malformed credit row', async () => {
    const bad = {
      version: 1, exportedAt: new Date().toISOString(),
      settings: {}, bills: [], billPayments: [],
      credits: [{ id: 'y', name: 'L', interest_type: 'compound' }],
      creditPayments: [],
    };
    const { status } = await ctx.send('POST', '/api/settings/import', bad);
    assert.equal(status, 400);
  });
});

describe('POST /api/settings/reset', () => {
  it('clears bills/credits but keeps currency setting', async () => {
    await ctx.send('PUT', '/api/settings', { currency: '\u20ac' });
    await ctx.send('POST', '/api/bills', {
      name: 'Tmp', amount: 10, dueDay: 1, recurrence: 'Monthly', category: 'Other', notes: '',
    });
    const { status } = await ctx.send('POST', '/api/settings/reset', { confirm: 'reset' });
    assert.equal(status, 200);
    const { body: bills } = await ctx.get('/api/bills');
    assert.deepEqual(bills, []);
    const { body: settings } = await ctx.get('/api/settings');
    assert.equal(settings.currency, '\u20ac');
  });

  it('rejects reset without confirmation token', async () => {
    const a = await ctx.send('POST', '/api/settings/reset');
    assert.equal(a.status, 400);
    const b = await ctx.send('POST', '/api/settings/reset', {});
    assert.equal(b.status, 400);
    const c = await ctx.send('POST', '/api/settings/reset', { confirm: 'no' });
    assert.equal(c.status, 400);
  });
});
