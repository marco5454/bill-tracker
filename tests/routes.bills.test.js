import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootTestApp } from './helpers/route-harness.js';

let ctx;
before(async () => { ctx = await bootTestApp(); });
after(async () => { await ctx?.close(); });

const validMonthly = {
  name: 'Electricity',
  amount: 1500,
  dueDay: 15,
  recurrence: 'Monthly',
  category: 'Utilities',
  notes: '',
};

describe('GET /api/bills (empty)', () => {
  it('returns []', async () => {
    const { status, body } = await ctx.get('/api/bills');
    assert.equal(status, 200);
    assert.deepEqual(body, []);
  });
});

describe('POST /api/bills', () => {
  it('creates a Monthly bill, returns 201 and full record', async () => {
    const { status, body } = await ctx.send('POST', '/api/bills', validMonthly);
    assert.equal(status, 201);
    assert.equal(body.name, 'Electricity');
    assert.equal(body.recurrence, 'Monthly');
    assert.equal(body.dueMonth, null);
    assert.equal(body.anchorMonth, null);
    assert.deepEqual(body.payments, []);
    assert.ok(body.id);
  });

  it('rejects missing dueMonth for Annually with 400', async () => {
    const { status, body } = await ctx.send('POST', '/api/bills', {
      ...validMonthly,
      recurrence: 'Annually',
      // no dueMonth
    });
    assert.equal(status, 400);
    assert.match(body.error, /dueMonth/);
  });

  it('rejects missing anchorMonth for Quarterly with 400', async () => {
    const { status, body } = await ctx.send('POST', '/api/bills', {
      ...validMonthly,
      recurrence: 'Quarterly',
    });
    assert.equal(status, 400);
    assert.match(body.error, /anchorMonth/);
  });

  it('rejects bad recurrence enum', async () => {
    const { status } = await ctx.send('POST', '/api/bills', {
      ...validMonthly, recurrence: 'Bogus',
    });
    assert.equal(status, 400);
  });

  it('rejects negative amount', async () => {
    const { status } = await ctx.send('POST', '/api/bills', {
      ...validMonthly, amount: -10,
    });
    assert.equal(status, 400);
  });

  it('strips Quarterly fields when recurrence=Annually', async () => {
    const { status, body } = await ctx.send('POST', '/api/bills', {
      ...validMonthly,
      name: 'Insurance',
      recurrence: 'Annually',
      dueMonth: 3,
      anchorMonth: 2, // should be nulled out
    });
    assert.equal(status, 201);
    assert.equal(body.dueMonth, 3);
    assert.equal(body.anchorMonth, null);
  });
});

describe('PUT /api/bills/:id', () => {
  it('updates an existing bill', async () => {
    const { body: created } = await ctx.send('POST', '/api/bills', { ...validMonthly, name: 'Water' });
    const { status, body, headers } = await ctx.send(
      'PUT', `/api/bills/${created.id}`,
      { ...validMonthly, name: 'Water (updated)', amount: 1800 },
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(status, 200);
    assert.equal(body.name, 'Water (updated)');
    assert.equal(body.amount, 1800);
    assert.equal(body.version, created.version + 1);
    assert.equal(headers.get('etag'), `"${body.version}"`);
  });

  it('returns 404 for unknown id', async () => {
    const { status } = await ctx.send(
      'PUT', '/api/bills/does-not-exist', validMonthly,
      { 'If-Match': '"1"' },
    );
    assert.equal(status, 404);
  });

  it('returns 428 when If-Match header is missing', async () => {
    const { body: created } = await ctx.send('POST', '/api/bills', { ...validMonthly, name: 'Sewer' });
    const { status, body } = await ctx.send('PUT', `/api/bills/${created.id}`, validMonthly);
    assert.equal(status, 428);
    assert.match(body.error, /If-Match/i);
  });

  it('returns 412 with currentVersion when If-Match is stale', async () => {
    const { body: created } = await ctx.send('POST', '/api/bills', { ...validMonthly, name: 'Trash' });
    // First update succeeds, version becomes 2
    const ok = await ctx.send(
      'PUT', `/api/bills/${created.id}`,
      { ...validMonthly, name: 'Trash 2' },
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(ok.status, 200);
    // Second update with the stale version=1 must fail
    const { status, body } = await ctx.send(
      'PUT', `/api/bills/${created.id}`,
      { ...validMonthly, name: 'Trash 3' },
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(status, 412);
    assert.equal(body.details.currentVersion, ok.body.version);
    assert.equal(body.details.submittedVersion, created.version);
  });

  it('rejects malformed If-Match values with 400', async () => {
    const { body: created } = await ctx.send('POST', '/api/bills', { ...validMonthly, name: 'Heat' });
    const { status } = await ctx.send(
      'PUT', `/api/bills/${created.id}`, validMonthly,
      { 'If-Match': 'not-an-etag' },
    );
    assert.equal(status, 400);
  });
});

describe('DELETE /api/bills/:id', () => {
  it('removes the bill (204) and subsequent fetch is 404', async () => {
    const { body: created } = await ctx.send('POST', '/api/bills', { ...validMonthly, name: 'Gas' });
    const { status } = await ctx.send(
      'DELETE', `/api/bills/${created.id}`, null,
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(status, 204);
    const { status: getStatus } = await ctx.get(`/api/bills/${created.id}`);
    assert.equal(getStatus, 404);
  });

  it('returns 428 when If-Match header is missing', async () => {
    const { body: created } = await ctx.send('POST', '/api/bills', { ...validMonthly, name: 'GasMissing' });
    const { status } = await ctx.send('DELETE', `/api/bills/${created.id}`);
    assert.equal(status, 428);
  });

  it('returns 412 when If-Match is stale', async () => {
    const { body: created } = await ctx.send('POST', '/api/bills', { ...validMonthly, name: 'GasStale' });
    // bump version via a payment toggle so If-Match=1 becomes stale
    await ctx.send(
      'POST', `/api/bills/${created.id}/payments/2026-06/toggle`, null,
      { 'If-Match': `"${created.version}"` },
    );
    const { status } = await ctx.send(
      'DELETE', `/api/bills/${created.id}`, null,
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(status, 412);
  });
});

describe('POST /api/bills/:id/payments/:cycleKey/toggle', () => {
  it('marks paid then unmarks (idempotent toggle), bumping version each time', async () => {
    const { body: created } = await ctx.send('POST', '/api/bills', { ...validMonthly, name: 'Internet' });
    const id = created.id;

    // Mark paid for 2026-06
    let { status, body } = await ctx.send(
      'POST', `/api/bills/${id}/payments/2026-06/toggle`, null,
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(status, 200);
    assert.deepEqual(body.payments, ['2026-06']);
    assert.equal(body.version, created.version + 1);

    // Toggle again -> unpaid (using new version)
    ({ status, body } = await ctx.send(
      'POST', `/api/bills/${id}/payments/2026-06/toggle`, null,
      { 'If-Match': `"${body.version}"` },
    ));
    assert.equal(status, 200);
    assert.deepEqual(body.payments, []);
    assert.equal(body.version, created.version + 2);
  });

  it('rejects malformed cycle key', async () => {
    const { body: created } = await ctx.send('POST', '/api/bills', { ...validMonthly, name: 'Cable' });
    const { status, body } = await ctx.send(
      'POST', `/api/bills/${created.id}/payments/!!bad!!/toggle`, null,
      { 'If-Match': `"${created.version}"` },
    );
    assert.equal(status, 400);
    assert.match(body.error, /cycle key/i);
  });

  it('returns 404 when bill does not exist', async () => {
    const { status } = await ctx.send(
      'POST', '/api/bills/missing/payments/2026-06/toggle', null,
      { 'If-Match': '"1"' },
    );
    assert.equal(status, 404);
  });

  it('returns 428 when If-Match header is missing', async () => {
    const { body: created } = await ctx.send('POST', '/api/bills', { ...validMonthly, name: 'Phone' });
    const { status } = await ctx.send('POST', `/api/bills/${created.id}/payments/2026-06/toggle`);
    assert.equal(status, 428);
  });
});
