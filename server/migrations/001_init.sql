-- 001_init: Initial schema for Bill & Credit Tracker
-- All amounts stored as REAL; client formats with currency symbol.
-- Foreign keys are enforced via PRAGMA in db.js.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bills (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  amount       REAL NOT NULL CHECK (amount >= 0),
  due_day      INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  recurrence   TEXT NOT NULL CHECK (recurrence IN ('Monthly','Quarterly','Annually')),
  category     TEXT NOT NULL,
  due_month    INTEGER CHECK (due_month IS NULL OR due_month BETWEEN 1 AND 12),
  anchor_month INTEGER CHECK (anchor_month IS NULL OR anchor_month BETWEEN 1 AND 3),
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (bill, cycle key). Presence => paid. cycle_key examples:
--   Monthly:   '2026-06'
--   Quarterly: '2026-Q2'
--   Annually:  '2026'
CREATE TABLE IF NOT EXISTS bill_payments (
  bill_id    TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  cycle_key  TEXT NOT NULL,
  paid_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bill_id, cycle_key)
);

CREATE INDEX IF NOT EXISTS idx_bill_payments_bill ON bill_payments(bill_id);

CREATE TABLE IF NOT EXISTS credits (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  lender        TEXT NOT NULL DEFAULT '',
  principal     REAL NOT NULL CHECK (principal >= 0),
  rate_pct      REAL NOT NULL CHECK (rate_pct >= 0),
  interest_type TEXT NOT NULL CHECK (interest_type IN ('simple','addon')),
  term_months   INTEGER NOT NULL CHECK (term_months > 0),
  start_date    TEXT NOT NULL,                       -- 'YYYY-MM-DD'
  end_date      TEXT NOT NULL,                       -- 'YYYY-MM-DD'
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (credit, ym). amount NULL => use scheduled monthly amount.
CREATE TABLE IF NOT EXISTS credit_payments (
  credit_id  TEXT NOT NULL REFERENCES credits(id) ON DELETE CASCADE,
  ym         TEXT NOT NULL,                          -- 'YYYY-MM'
  amount     REAL CHECK (amount IS NULL OR amount >= 0),
  paid_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (credit_id, ym)
);

CREATE INDEX IF NOT EXISTS idx_credit_payments_credit ON credit_payments(credit_id);
