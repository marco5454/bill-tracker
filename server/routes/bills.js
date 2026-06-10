import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db, txn } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { v, validate } from '../middleware/validate.js';

export const billsRouter = Router();

const billSchema = {
  name:        v.string({ min: 1, max: 120 }),
  amount:      v.number({ min: 0, max: 1e12 }),
  dueDay:      v.number({ min: 1, max: 31, integer: true }),
  recurrence:  v.enum(['Monthly', 'Quarterly', 'Annually']),
  category:    v.string({ min: 1, max: 60 }),
  dueMonth:    v.optional(v.number({ min: 1, max: 12, integer: true })),
  anchorMonth: v.optional(v.number({ min: 1, max: 3,  integer: true })),
  notes:       v.string({ max: 1000, allowEmpty: true })
};

function rowToBill(row, payments) {
  return {
    id: row.id,
    name: row.name,
    amount: row.amount,
    dueDay: row.due_day,
    recurrence: row.recurrence,
    category: row.category,
    dueMonth: row.due_month,
    anchorMonth: row.anchor_month,
    notes: row.notes,
    payments: payments || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function loadAllBills() {
  const bills = db.prepare('SELECT * FROM bills ORDER BY name COLLATE NOCASE').all();
  const payRows = db.prepare('SELECT bill_id, cycle_key FROM bill_payments').all();
  const map = new Map();
  for (const p of payRows) {
    if (!map.has(p.bill_id)) map.set(p.bill_id, []);
    map.get(p.bill_id).push(p.cycle_key);
  }
  return bills.map(b => rowToBill(b, map.get(b.id) || []));
}

function loadBill(id) {
  const row = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!row) return null;
  const payments = db.prepare('SELECT cycle_key FROM bill_payments WHERE bill_id = ?').all(id).map(r => r.cycle_key);
  return rowToBill(row, payments);
}

billsRouter.get('/', (_req, res) => {
  res.json(loadAllBills());
});

billsRouter.get('/:id', (req, res) => {
  const bill = loadBill(req.params.id);
  if (!bill) throw new HttpError(404, 'Bill not found');
  res.json(bill);
});

billsRouter.post('/', (req, res) => {
  const data = validate(billSchema, req.body);
  enforceRecurrenceRules(data);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO bills (id, name, amount, due_day, recurrence, category, due_month, anchor_month, notes)
    VALUES (@id, @name, @amount, @dueDay, @recurrence, @category, @dueMonth, @anchorMonth, @notes)
  `).run({ id, ...data });
  res.status(201).json(loadBill(id));
});

billsRouter.put('/:id', (req, res) => {
  const data = validate(billSchema, req.body);
  enforceRecurrenceRules(data);
  const info = db.prepare(`
    UPDATE bills
       SET name = @name, amount = @amount, due_day = @dueDay, recurrence = @recurrence,
           category = @category, due_month = @dueMonth, anchor_month = @anchorMonth,
           notes = @notes, updated_at = datetime('now')
     WHERE id = @id
  `).run({ id: req.params.id, ...data });
  if (info.changes === 0) throw new HttpError(404, 'Bill not found');
  res.json(loadBill(req.params.id));
});

billsRouter.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM bills WHERE id = ?').run(req.params.id);
  if (info.changes === 0) throw new HttpError(404, 'Bill not found');
  res.status(204).end();
});

// Toggle payment for a specific cycle key (e.g. '2026-06', '2026-Q2', '2026').
billsRouter.post('/:id/payments/:cycleKey/toggle', (req, res) => {
  const { id, cycleKey } = req.params;
  if (!/^[0-9A-Za-z-]{1,16}$/.test(cycleKey)) throw new HttpError(400, 'Invalid cycle key');
  const bill = db.prepare('SELECT id FROM bills WHERE id = ?').get(id);
  if (!bill) throw new HttpError(404, 'Bill not found');

  txn(() => {
    const existing = db.prepare('SELECT 1 FROM bill_payments WHERE bill_id = ? AND cycle_key = ?').get(id, cycleKey);
    if (existing) {
      db.prepare('DELETE FROM bill_payments WHERE bill_id = ? AND cycle_key = ?').run(id, cycleKey);
    } else {
      db.prepare('INSERT INTO bill_payments (bill_id, cycle_key) VALUES (?, ?)').run(id, cycleKey);
    }
  });
  res.json(loadBill(id));
});

function enforceRecurrenceRules(data) {
  if (data.recurrence === 'Annually' && data.dueMonth == null) {
    throw new HttpError(400, 'dueMonth is required for Annually recurrence');
  }
  if (data.recurrence === 'Quarterly' && data.anchorMonth == null) {
    throw new HttpError(400, 'anchorMonth is required for Quarterly recurrence');
  }
  if (data.recurrence === 'Monthly') {
    data.dueMonth = null;
    data.anchorMonth = null;
  }
  if (data.recurrence === 'Annually')  data.anchorMonth = null;
  if (data.recurrence === 'Quarterly') data.dueMonth = null;
}
