import { Router } from 'express';
import { db, txn } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { v, validate } from '../middleware/validate.js';

export const settingsRouter = Router();

// Schemas for /import — match the snake_case shape produced by /export so the
// round-trip works. Every numeric field is range-checked so the DB CHECK
// constraints don't have to pick up the slack with opaque 500s.
const importBillSchema = {
  id:           v.string({ min: 1, max: 64 }),
  name:         v.string({ min: 1, max: 120 }),
  amount:       v.number({ min: 0, max: 1e12 }),
  due_day:      v.number({ min: 1, max: 31, integer: true }),
  recurrence:   v.enum(['Monthly', 'Quarterly', 'Annually']),
  category:     v.string({ min: 1, max: 60 }),
  due_month:    v.optional(v.number({ min: 1, max: 12, integer: true })),
  anchor_month: v.optional(v.number({ min: 1, max: 3,  integer: true })),
  notes:        v.string({ max: 1000, allowEmpty: true }),
};

const importCreditSchema = {
  id:            v.string({ min: 1, max: 64 }),
  name:          v.string({ min: 1, max: 120 }),
  lender:        v.string({ max: 120, allowEmpty: true }),
  principal:     v.number({ min: 0, max: 1e12 }),
  rate_pct:      v.number({ min: 0, max: 1e6 }),
  interest_type: v.enum(['simple', 'addon']),
  term_months:   v.number({ min: 1, max: 600, integer: true }),
  start_date:    v.isoDate(),
  end_date:      v.isoDate(),
  notes:         v.string({ max: 1000, allowEmpty: true }),
};

const CYCLE_KEY_RE = /^[0-9A-Za-z-]{1,16}$/;
const YM_RE = /^\d{4}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Liberal SQLite datetime: 'YYYY-MM-DD HH:MM:SS' or ISO 8601 'YYYY-MM-DDTHH:MM:SS[Z]'
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

// Hard caps to bound memory/time of an import. The 5MB body limit is the
// outermost guard; these are belt-and-suspenders so a single malicious export
// can't pin the event loop in the per-row loop.
const MAX_BILLS = 10_000;
const MAX_CREDITS = 10_000;
const MAX_PAYMENTS = 200_000;

function readAll() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  if (!out.currency) out.currency = '\u20b1';
  return out;
}

function isOptionalDateTime(s) {
  return s == null || (typeof s === 'string' && ISO_DATETIME_RE.test(s));
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

// Export full snapshot. We send compact (un-indented) JSON because exports of
// the maximum allowed size (10k bills + 200k payments) would otherwise
// double their memory footprint for the pretty-print pass before the response
// is flushed. Clients that want a human-readable file can pretty-print it
// locally; the in-app Settings export already does this.
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
  res.send(JSON.stringify(snapshot));
});

// Replace all data with the imported snapshot. Validates per-item shape *before*
// touching the database — the destructive DELETE phase only runs after we
// know the new payload is well-formed.
settingsRouter.post('/import', (req, res) => {
  const snap = req.body;
  if (!snap || typeof snap !== 'object') throw new HttpError(400, 'Invalid import payload');
  const bills = Array.isArray(snap.bills) ? snap.bills : [];
  const billPayments = Array.isArray(snap.billPayments) ? snap.billPayments : [];
  const credits = Array.isArray(snap.credits) ? snap.credits : [];
  const creditPayments = Array.isArray(snap.creditPayments) ? snap.creditPayments : [];
  const settings = (snap.settings && typeof snap.settings === 'object') ? snap.settings : {};

  if (bills.length > MAX_BILLS) {
    throw new HttpError(400, `Too many bills in import (max ${MAX_BILLS})`);
  }
  if (credits.length > MAX_CREDITS) {
    throw new HttpError(400, `Too many credits in import (max ${MAX_CREDITS})`);
  }
  if (billPayments.length + creditPayments.length > MAX_PAYMENTS) {
    throw new HttpError(400, `Too many payment rows in import (max ${MAX_PAYMENTS})`);
  }

  // Validate every row up front. We surface a 400 with a specific row index
  // and the underlying schema error so the user can fix the file rather than
  // staring at "Internal server error".
  const cleanBills = bills.map((b, i) => {
    try {
      const cleaned = validate(importBillSchema, b);
      enforceBillRecurrence(cleaned);
      return cleaned;
    } catch (err) {
      throw new HttpError(400, `Invalid bill row at index ${i}: ${err.publicMessage || err.message}`);
    }
  });
  const cleanCredits = credits.map((c, i) => {
    try {
      const cleaned = validate(importCreditSchema, c);
      if (cleaned.end_date < cleaned.start_date) {
        throw new HttpError(400, 'end_date must be on or after start_date');
      }
      return cleaned;
    } catch (err) {
      throw new HttpError(400, `Invalid credit row at index ${i}: ${err.publicMessage || err.message}`);
    }
  });

  // Index the parents we just validated so payment FK references can be
  // pre-checked. Cuts failure modes off at validation time.
  const billIds = new Set(cleanBills.map((b) => b.id));
  const creditIds = new Set(cleanCredits.map((c) => c.id));

  const cleanBillPayments = billPayments.map((p, i) => {
    if (!p || typeof p !== 'object') throw new HttpError(400, `Invalid billPayment row at index ${i}`);
    if (typeof p.bill_id !== 'string' || !billIds.has(p.bill_id)) {
      throw new HttpError(400, `billPayment row ${i}: bill_id "${p.bill_id}" not found in import`);
    }
    if (typeof p.cycle_key !== 'string' || !CYCLE_KEY_RE.test(p.cycle_key)) {
      throw new HttpError(400, `billPayment row ${i}: cycle_key invalid`);
    }
    if (!isOptionalDateTime(p.paid_at)) {
      throw new HttpError(400, `billPayment row ${i}: paid_at not a valid datetime`);
    }
    return { bill_id: p.bill_id, cycle_key: p.cycle_key, paid_at: p.paid_at || null };
  });

  const cleanCreditPayments = creditPayments.map((p, i) => {
    if (!p || typeof p !== 'object') throw new HttpError(400, `Invalid creditPayment row at index ${i}`);
    if (typeof p.credit_id !== 'string' || !creditIds.has(p.credit_id)) {
      throw new HttpError(400, `creditPayment row ${i}: credit_id "${p.credit_id}" not found in import`);
    }
    if (typeof p.ym !== 'string' || !YM_RE.test(p.ym)) {
      throw new HttpError(400, `creditPayment row ${i}: ym must be YYYY-MM`);
    }
    let amount = null;
    if (p.amount != null && p.amount !== '') {
      const n = Number(p.amount);
      if (!Number.isFinite(n) || n < 0 || n > 1e12) {
        throw new HttpError(400, `creditPayment row ${i}: amount out of range`);
      }
      amount = n;
    }
    if (!isOptionalDateTime(p.paid_at)) {
      throw new HttpError(400, `creditPayment row ${i}: paid_at not a valid datetime`);
    }
    return { credit_id: p.credit_id, ym: p.ym, amount, paid_at: p.paid_at || null };
  });

  // ID format guard — IDs become PRIMARY KEYs and are echoed back in URLs.
  // Reject anything that doesn't fit our charset to avoid surprises.
  for (const row of cleanBills) {
    if (!ID_RE.test(row.id)) throw new HttpError(400, `bill id "${row.id}" has invalid characters`);
  }
  for (const row of cleanCredits) {
    if (!ID_RE.test(row.id)) throw new HttpError(400, `credit id "${row.id}" has invalid characters`);
  }

  // Optional currency
  let nextCurrency = null;
  if (settings.currency != null) {
    if (typeof settings.currency !== 'string' || settings.currency.length < 1 || settings.currency.length > 8) {
      throw new HttpError(400, 'settings.currency must be a 1..8 char string');
    }
    nextCurrency = settings.currency;
  }

  txn(() => {
    db.prepare('DELETE FROM bill_payments').run();
    db.prepare('DELETE FROM bills').run();
    db.prepare('DELETE FROM credit_payments').run();
    db.prepare('DELETE FROM credits').run();

    const insBill = db.prepare(`INSERT INTO bills
      (id, name, amount, due_day, recurrence, category, due_month, anchor_month, notes, created_at, updated_at)
      VALUES (@id, @name, @amount, @due_day, @recurrence, @category, @due_month, @anchor_month, @notes,
              datetime('now'), datetime('now'))`);
    for (const b of cleanBills) insBill.run(b);

    const insBP = db.prepare("INSERT OR IGNORE INTO bill_payments (bill_id, cycle_key, paid_at) VALUES (?, ?, COALESCE(?, datetime('now')))");
    for (const p of cleanBillPayments) insBP.run(p.bill_id, p.cycle_key, p.paid_at);

    const insCredit = db.prepare(`INSERT INTO credits
      (id, name, lender, principal, rate_pct, interest_type, term_months, start_date, end_date, notes, created_at, updated_at)
      VALUES (@id, @name, @lender, @principal, @rate_pct, @interest_type, @term_months, @start_date, @end_date, @notes,
              datetime('now'), datetime('now'))`);
    for (const c of cleanCredits) insCredit.run(c);

    const insCP = db.prepare("INSERT OR IGNORE INTO credit_payments (credit_id, ym, amount, paid_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')))");
    for (const p of cleanCreditPayments) insCP.run(p.credit_id, p.ym, p.amount, p.paid_at);

    if (nextCurrency != null) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('currency', nextCurrency);
    }
  });

  res.json({ ok: true });
});

settingsRouter.post('/reset', (req, res) => {
  // Destructive: wipes every bill, credit and payment row. Require an explicit
  // confirmation token in the body so a stray empty POST (or a CSRF
  // "simple request" that cannot set arbitrary JSON bodies) cannot trigger
  // a full data loss.
  const confirm = req.body && typeof req.body === 'object' ? req.body.confirm : undefined;
  if (confirm !== 'reset') {
    throw new HttpError(400, 'Reset requires { "confirm": "reset" } in the request body');
  }
  txn(() => {
    db.prepare('DELETE FROM bill_payments').run();
    db.prepare('DELETE FROM bills').run();
    db.prepare('DELETE FROM credit_payments').run();
    db.prepare('DELETE FROM credits').run();
  });
  res.json({ ok: true });
});

// Mirror of bills.js enforceRecurrenceRules but for snake_case import shape.
function enforceBillRecurrence(b) {
  if (b.recurrence === 'Annually' && b.due_month == null) {
    throw new HttpError(400, 'due_month is required for Annually recurrence');
  }
  if (b.recurrence === 'Quarterly' && b.anchor_month == null) {
    throw new HttpError(400, 'anchor_month is required for Quarterly recurrence');
  }
  if (b.recurrence === 'Monthly') {
    b.due_month = null;
    b.anchor_month = null;
  }
  if (b.recurrence === 'Annually')  b.anchor_month = null;
  if (b.recurrence === 'Quarterly') b.due_month = null;
}
