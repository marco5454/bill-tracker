import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestApp } from './helpers/route-harness.js';

let ctx;
before(async () => { ctx = await bootTestApp(); });
after(async () => { await ctx?.close(); });

const validCredit = {
  name: 'Car Loan',
  lender: 'Bank A',
  principal: 100_000,
  ratePct: 12,
  interestType: 'simple',
  termMonths: 12,
  startDate: '2026-01-01',
  endDate: '2027-01-01',
  notes: '',
};

describe('POST /api/credits', () => {
  it('creates a simple-interest credit', async () => {
    const { status, body } = await ctx.send('POST', '/api/credits', validCredit);
    assert.equal(status, 201);
    assert.equal(body.name, 'Car Loan');
    assert.equal(body.interestType, 'simple');
    assert.equal(body.principal, 100_000);
    assert.deepEqual(body.payments, []);
    assert.ok(body.id);
  });

  it('creates an addon credit', async () => {
    const { status, body } = await ctx.send('POST', '/api/credits', {
      ...validCredit, name: 'Appliance', interestType: 'addon', ratePct: 1,
    });
    assert.equal(status, 201);
    assert.equal(body.interestType, 'addon');
  });

  it('rejects endDate before startDate', async () => {
    const { status, body } = await ctx.send('POST', '/api/credits', {
      ...validCredit,
      startDate: '2026-06-01',
      endDate: '2026-05-01',
    });
    assert.equal(status, 400);
    assert.match(body.error, /endDate/);
  });

  it('rejects bad interestType', async () => {
    const { status } = await ctx.send('POST', '/api/credits', { ...validCredit, interestType: 'compound' });
    assert.equal(status, 400);
  });

  it('rejects bad isoDate', async () => {
    const { status } = await ctx.send('POST', '/api/credits', { ...validCredit, startDate: '01/01/2026' });
    assert.equal(status, 400);
  });

  it('rejects termMonths=0', async () => {
    const { status } = await ctx.send('POST', '/api/credits', { ...validCredit, termMonths: 0 });
    assert.equal(status, 400);
  });
});

describe('PUT /api/credits/:id', () => {
  it('updates lender + ratePct, bumps version, sets ETag', async () => {
    const { body: created } = await ctx.send('POST', '/api/credits', { ...validCredit, name: 'Loan B' });
    const { status, body, headers } = await ctx.send(
      'PUT', `/api/credits/${created.id}`,
      { ...validCredit, name: 'Loan B', lender: 'Bank C', ratePct: 8 },
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(status, 200);
    assert.equal(body.lender, 'Bank C');
    assert.equal(body.ratePct, 8);
    assert.equal(body.version, created.version + 1);
    assert.equal(headers.get('etag'), `"${body.version}"`);
  });

  it('returns 404 for unknown id', async () => {
    const { status } = await ctx.send(
      'PUT', '/api/credits/missing', validCredit,
      { 'If-Match': '"1"' },
    );
    assert.equal(status, 404);
  });

  it('returns 428 when If-Match is missing', async () => {
    const { body: created } = await ctx.send('POST', '/api/credits', { ...validCredit, name: 'LoanNoMatch' });
    const { status } = await ctx.send('PUT', `/api/credits/${created.id}`, validCredit);
    assert.equal(status, 428);
  });

  it('returns 412 when If-Match is stale', async () => {
    const { body: created } = await ctx.send('POST', '/api/credits', { ...validCredit, name: 'LoanStale' });
    await ctx.send(
      'PUT', `/api/credits/${created.id}`, validCredit,
      { 'If-Match': `"${created.version}"` },
    );
    const { status, body } = await ctx.send(
      'PUT', `/api/credits/${created.id}`, validCredit,
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(status, 412);
    assert.equal(body.details.currentVersion, created.version + 1);
  });
});

describe('DELETE /api/credits/:id', () => {
  it('removes credit and cascades to payments', async () => {
    const { body: created } = await ctx.send('POST', '/api/credits', { ...validCredit, name: 'Loan C' });
    // Add a payment (bumps version to 2)
    const toggleRes = await ctx.send(
      'POST', `/api/credits/${created.id}/payments/2026-01/toggle`, { amount: 5000 },
      { 'If-Match': `"${created.version}"` },
    );
    const { status } = await ctx.send(
      'DELETE', `/api/credits/${created.id}`, null,
      { 'If-Match': `"${toggleRes.body.version}"` },
    );
    assert.equal(status, 204);
    const { status: getStatus } = await ctx.get(`/api/credits/${created.id}`);
    assert.equal(getStatus, 404);
  });

  it('returns 428 when If-Match missing', async () => {
    const { body: created } = await ctx.send('POST', '/api/credits', { ...validCredit, name: 'LoanDel' });
    const { status } = await ctx.send('DELETE', `/api/credits/${created.id}`);
    assert.equal(status, 428);
  });
});

describe('POST /api/credits/:id/payments/:ym/toggle', () => {
  it('toggles paid with optional explicit amount, ratchets version', async () => {
    const { body: created } = await ctx.send('POST', '/api/credits', { ...validCredit, name: 'Loan D' });
    const id = created.id;

    let { status, body } = await ctx.send(
      'POST', `/api/credits/${id}/payments/2026-02/toggle`, { amount: 16000 },
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(status, 200);
    assert.equal(body.payments.length, 1);
    assert.equal(body.payments[0].ym, '2026-02');
    assert.equal(body.payments[0].amount, 16000);
    assert.equal(body.version, created.version + 1);

    // Toggle again -> removes (using fresh version)
    ({ status, body } = await ctx.send(
      'POST', `/api/credits/${id}/payments/2026-02/toggle`, null,
      { 'If-Match': `"${body.version}"` },
    ));
    assert.equal(status, 200);
    assert.deepEqual(body.payments, []);
    assert.equal(body.version, created.version + 2);
  });

  it('toggles paid without amount (null)', async () => {
    const { body: created } = await ctx.send('POST', '/api/credits', { ...validCredit, name: 'Loan E' });
    const { status, body } = await ctx.send(
      'POST', `/api/credits/${created.id}/payments/2026-03/toggle`, null,
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(status, 200);
    assert.equal(body.payments[0].amount, null);
  });

  it('rejects malformed ym', async () => {
    const { body: created } = await ctx.send('POST', '/api/credits', { ...validCredit, name: 'Loan F' });
    const r2 = await ctx.send(
      'POST', `/api/credits/${created.id}/payments/junk/toggle`, null,
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(r2.status, 400);
  });

  it('returns 428 when If-Match missing', async () => {
    const { body: created } = await ctx.send('POST', '/api/credits', { ...validCredit, name: 'LoanTogNoMatch' });
    const { status } = await ctx.send('POST', `/api/credits/${created.id}/payments/2026-04/toggle`);
    assert.equal(status, 428);
  });
});

describe('PUT /api/credits/:id/payments/:ym (update amount)', () => {
  it('updates amount on existing payment, bumps parent version', async () => {
    const { body: created } = await ctx.send('POST', '/api/credits', { ...validCredit, name: 'Loan G' });
    const togRes = await ctx.send(
      'POST', `/api/credits/${created.id}/payments/2026-04/toggle`, { amount: 10000 },
      { 'If-Match': `"${created.version}"` },
    );

    const { status, body } = await ctx.send(
      'PUT', `/api/credits/${created.id}/payments/2026-04`, { amount: 12000 },
      { 'If-Match': `"${togRes.body.version}"` },
    );
    assert.equal(status, 200);
    const pay = body.payments.find((p) => p.ym === '2026-04');
    assert.equal(pay.amount, 12000);
    assert.equal(body.version, togRes.body.version + 1);
  });

  it('returns 404 if payment row absent', async () => {
    const { body: created } = await ctx.send('POST', '/api/credits', { ...validCredit, name: 'Loan H' });
    const { status } = await ctx.send(
      'PUT', `/api/credits/${created.id}/payments/2026-09`, { amount: 1 },
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(status, 404);
  });

  it('returns 428 when If-Match missing', async () => {
    const { body: created } = await ctx.send('POST', '/api/credits', { ...validCredit, name: 'LoanAmtNoMatch' });
    const { status } = await ctx.send('PUT', `/api/credits/${created.id}/payments/2026-04`, { amount: 1 });
    assert.equal(status, 428);
  });
});
