import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db, txn } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { v, validate } from '../middleware/validate.js';
import { requireIfMatch, assertVersionMatch, setVersionHeader } from '../middleware/concurrency.js';

export const creditsRouter = Router();

const creditSchema = {
  name:         v.string({ min: 1, max: 120 }),
  lender:       v.string({ max: 120, allowEmpty: true }),
  principal:    v.number({ min: 0, max: 1e12 }),
  ratePct:      v.number({ min: 0, max: 1e6 }),
  interestType: v.enum(['simple', 'addon']),
  termMonths:   v.number({ min: 1, max: 600, integer: true }),
  startDate:    v.isoDate(),
  endDate:      v.isoDate(),
  notes:        v.string({ max: 1000, allowEmpty: true })
};

function rowToCredit(row, payments) {
  return {
    id: row.id,
    name: row.name,
    lender: row.lender,
    principal: row.principal,
    ratePct: row.rate_pct,
    interestType: row.interest_type,
    termMonths: row.term_months,
    startDate: row.start_date,
    endDate: row.end_date,
    notes: row.notes,
    payments: payments || [],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function loadAllCredits() {
  const credits = db.prepare('SELECT * FROM credits ORDER BY name COLLATE NOCASE').all();
  const payRows = db.prepare('SELECT credit_id, ym, amount FROM credit_payments').all();
  const map = new Map();
  for (const p of payRows) {
    if (!map.has(p.credit_id)) map.set(p.credit_id, []);
    map.get(p.credit_id).push({ ym: p.ym, amount: p.amount });
  }
  return credits.map(c => rowToCredit(c, map.get(c.id) || []));
}

function loadCredit(id) {
  const row = db.prepare('SELECT * FROM credits WHERE id = ?').get(id);
  if (!row) return null;
  const payments = db.prepare('SELECT ym, amount FROM credit_payments WHERE credit_id = ?').all(id);
  return rowToCredit(row, payments);
}

creditsRouter.get('/', (_req, res) => {
  res.json(loadAllCredits());
});

creditsRouter.get('/:id', (req, res) => {
  const credit = loadCredit(req.params.id);
  if (!credit) throw new HttpError(404, 'Credit not found');
  setVersionHeader(res, credit.version);
  res.json(credit);
});

creditsRouter.post('/', (req, res) => {
  const data = validate(creditSchema, req.body);
  if (data.endDate < data.startDate) throw new HttpError(400, 'endDate must be on or after startDate');
  const id = randomUUID();
  db.prepare(`
    INSERT INTO credits (id, name, lender, principal, rate_pct, interest_type, term_months, start_date, end_date, notes)
    VALUES (@id, @name, @lender, @principal, @ratePct, @interestType, @termMonths, @startDate, @endDate, @notes)
  `).run({ id, ...data });
  const credit = loadCredit(id);
  setVersionHeader(res, credit.version);
  res.status(201).json(credit);
});

creditsRouter.put('/:id', (req, res) => {
  const clientVersion = requireIfMatch(req);
  const data = validate(creditSchema, req.body);
  if (data.endDate < data.startDate) throw new HttpError(400, 'endDate must be on or after startDate');

  const credit = txn(() => {
    const row = db.prepare('SELECT version FROM credits WHERE id = ?').get(req.params.id);
    if (!row) throw new HttpError(404, 'Credit not found');
    assertVersionMatch(row.version, clientVersion);
    db.prepare(`
      UPDATE credits
         SET name = @name, lender = @lender, principal = @principal, rate_pct = @ratePct,
             interest_type = @interestType, term_months = @termMonths,
             start_date = @startDate, end_date = @endDate, notes = @notes,
             version = version + 1, updated_at = datetime('now')
       WHERE id = @id
    `).run({ id: req.params.id, ...data });
    return loadCredit(req.params.id);
  });
  setVersionHeader(res, credit.version);
  res.json(credit);
});

creditsRouter.delete('/:id', (req, res) => {
  const clientVersion = requireIfMatch(req);
  txn(() => {
    const row = db.prepare('SELECT version FROM credits WHERE id = ?').get(req.params.id);
    if (!row) throw new HttpError(404, 'Credit not found');
    assertVersionMatch(row.version, clientVersion);
    db.prepare('DELETE FROM credits WHERE id = ?').run(req.params.id);
  });
  res.status(204).end();
});

// Toggle a credit installment for a specific YYYY-MM. Optional `amount` body sets
// a per-payment amount (e.g. for overpayment). Sending null/empty clears it.
creditsRouter.post('/:id/payments/:ym/toggle', (req, res) => {
  const clientVersion = requireIfMatch(req);
  const { id, ym } = req.params;
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new HttpError(400, 'ym must be YYYY-MM');

  let amount = null;
  if (req.body && req.body.amount != null && req.body.amount !== '') {
    amount = v.number({ min: 0, max: 1e12 })(req.body.amount, 'amount');
  }

  const credit = txn(() => {
    const row = db.prepare('SELECT version FROM credits WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Credit not found');
    assertVersionMatch(row.version, clientVersion);

    const existing = db.prepare('SELECT 1 FROM credit_payments WHERE credit_id = ? AND ym = ?').get(id, ym);
    if (existing) {
      db.prepare('DELETE FROM credit_payments WHERE credit_id = ? AND ym = ?').run(id, ym);
    } else {
      db.prepare('INSERT INTO credit_payments (credit_id, ym, amount) VALUES (?, ?, ?)').run(id, ym, amount);
    }
    db.prepare("UPDATE credits SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(id);
    return loadCredit(id);
  });
  setVersionHeader(res, credit.version);
  res.json(credit);
});

// Update only the amount for an existing paid installment.
creditsRouter.put('/:id/payments/:ym', (req, res) => {
  const clientVersion = requireIfMatch(req);
  const { id, ym } = req.params;
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new HttpError(400, 'ym must be YYYY-MM');
  let amount = null;
  if (req.body && req.body.amount != null && req.body.amount !== '') {
    amount = v.number({ min: 0, max: 1e12 })(req.body.amount, 'amount');
  }

  const credit = txn(() => {
    const row = db.prepare('SELECT version FROM credits WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Credit not found');
    assertVersionMatch(row.version, clientVersion);

    const info = db.prepare('UPDATE credit_payments SET amount = ? WHERE credit_id = ? AND ym = ?').run(amount, id, ym);
    if (info.changes === 0) throw new HttpError(404, 'Payment not found');
    db.prepare("UPDATE credits SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(id);
    return loadCredit(id);
  });
  setVersionHeader(res, credit.version);
  res.json(credit);
});
