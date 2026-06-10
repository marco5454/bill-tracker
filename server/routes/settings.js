import { Router } from 'express';
import { db, txn } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { v, validate } from '../middleware/validate.js';

export const settingsRouter = Router();

function readAll() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  if (!out.currency) out.currency = '\u20b1';
  return out;
}

settingsRouter.get('/', (_req, res) => {
  res.json(readAll());
});

settingsRouter.put('/', (req, res) => {
  const data = validate({
    currency: v.string({ min: 1, max: 8 })
  }, req.body);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('currency', data.currency);
  res.json(readAll());
});

// Export full snapshot.
settingsRouter.get('/export', (_req, res) => {
  const snapshot = {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: readAll(),
    bills:    db.prepare('SELECT * FROM bills').all(),
    billPayments:   db.prepare('SELECT * FROM bill_payments').all(),
    credits:  db.prepare('SELECT * FROM credits').all(),
    creditPayments: db.prepare('SELECT * FROM credit_payments').all()
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="billtracker-export.json"');
  res.send(JSON.stringify(snapshot, null, 2));
});

// Replace all data with the imported snapshot. Validates per-item shape.
settingsRouter.post('/import', (req, res) => {
  const snap = req.body;
  if (!snap || typeof snap !== 'object') throw new HttpError(400, 'Invalid import payload');
  const bills = Array.isArray(snap.bills) ? snap.bills : [];
  const billPayments = Array.isArray(snap.billPayments) ? snap.billPayments : [];
  const credits = Array.isArray(snap.credits) ? snap.credits : [];
  const creditPayments = Array.isArray(snap.creditPayments) ? snap.creditPayments : [];
  const settings = (snap.settings && typeof snap.settings === 'object') ? snap.settings : {};

  // Lightweight per-row validation
  for (const b of bills) {
    if (!b.id || !b.name || !['Monthly','Quarterly','Annually'].includes(b.recurrence)) {
      throw new HttpError(400, 'Invalid bill row in import');
    }
  }
  for (const c of credits) {
    if (!c.id || !c.name || !['simple','addon'].includes(c.interest_type)) {
      throw new HttpError(400, 'Invalid credit row in import');
    }
  }

  txn(() => {
    db.prepare('DELETE FROM bill_payments').run();
    db.prepare('DELETE FROM bills').run();
    db.prepare('DELETE FROM credit_payments').run();
    db.prepare('DELETE FROM credits').run();

    const insBill = db.prepare(`INSERT INTO bills
      (id, name, amount, due_day, recurrence, category, due_month, anchor_month, notes, created_at, updated_at)
      VALUES (@id, @name, @amount, @due_day, @recurrence, @category, @due_month, @anchor_month, @notes,
              COALESCE(@created_at, datetime('now')), COALESCE(@updated_at, datetime('now')))`);
    for (const b of bills) insBill.run({
      id: b.id, name: b.name, amount: Number(b.amount), due_day: Number(b.due_day),
      recurrence: b.recurrence, category: b.category || 'Other',
      due_month: b.due_month ?? null, anchor_month: b.anchor_month ?? null,
      notes: b.notes || '', created_at: b.created_at, updated_at: b.updated_at
    });

    const insBP = db.prepare('INSERT OR IGNORE INTO bill_payments (bill_id, cycle_key, paid_at) VALUES (?, ?, COALESCE(?, datetime(\'now\')))');
    for (const p of billPayments) {
      if (!p.bill_id || !p.cycle_key) continue;
      insBP.run(p.bill_id, p.cycle_key, p.paid_at || null);
    }

    const insCredit = db.prepare(`INSERT INTO credits
      (id, name, lender, principal, rate_pct, interest_type, term_months, start_date, end_date, notes, created_at, updated_at)
      VALUES (@id, @name, @lender, @principal, @rate_pct, @interest_type, @term_months, @start_date, @end_date, @notes,
              COALESCE(@created_at, datetime('now')), COALESCE(@updated_at, datetime('now')))`);
    for (const c of credits) insCredit.run({
      id: c.id, name: c.name, lender: c.lender || '',
      principal: Number(c.principal), rate_pct: Number(c.rate_pct),
      interest_type: c.interest_type, term_months: Number(c.term_months),
      start_date: c.start_date, end_date: c.end_date,
      notes: c.notes || '', created_at: c.created_at, updated_at: c.updated_at
    });

    const insCP = db.prepare('INSERT OR IGNORE INTO credit_payments (credit_id, ym, amount, paid_at) VALUES (?, ?, ?, COALESCE(?, datetime(\'now\')))');
    for (const p of creditPayments) {
      if (!p.credit_id || !p.ym) continue;
      insCP.run(p.credit_id, p.ym, p.amount ?? null, p.paid_at || null);
    }

    if (settings.currency) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('currency', String(settings.currency).slice(0, 8));
    }
  });

  res.json({ ok: true });
});

settingsRouter.post('/reset', (_req, res) => {
  txn(() => {
    db.prepare('DELETE FROM bill_payments').run();
    db.prepare('DELETE FROM bills').run();
    db.prepare('DELETE FROM credit_payments').run();
    db.prepare('DELETE FROM credits').run();
  });
  res.json({ ok: true });
});
