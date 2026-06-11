// IndexedDB-backed implementation of the storage interface used by the app.
//
// The shape of the values returned here matches the canonical shape returned by
// the Node API (see server/routes/bills.js rowToBill, server/routes/credits.js
// rowToCredit, etc.). State.js and modules consume the same camelCase fields
// regardless of which store is active.
//
// Persistence: each object store ("bills", "credits", "settings",
// "billPayments", "creditPayments") lives in IndexedDB database "billtracker".
// All writes happen inside a single readwrite transaction so partial failures
// roll back automatically.
//
// Concurrency: keep a `version` integer on bills and credits so the same
// optimistic-concurrency contract used by the server is preserved. On a single
// device this never trips, but two open tabs on the same browser share the DB
// and *will* race. We surface the same 412/428 errors a server would so call
// sites don't fork.

const DB_NAME = 'billtracker';
const DB_VERSION = 1;
const STORES = ['bills', 'credits', 'billPayments', 'creditPayments', 'settings'];

const RECURRENCE = ['Monthly', 'Quarterly', 'Annually'];
const INTEREST_TYPES = ['simple', 'addon'];
const CYCLE_KEY_RE = /^[0-9A-Za-z-]{1,16}$/;
const YM_RE = /^\d{4}-\d{2}$/;

// ---------------------------------------------------------------------------
// Errors that match the shape thrown by api.js so call sites stay identical.

export class LocalStoreError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function notFound(what) {
  return new LocalStoreError(404, `${what} not found`);
}
function badRequest(msg, details) {
  return new LocalStoreError(400, msg, details);
}
function conflict(currentVersion, submittedVersion) {
  return new LocalStoreError(412,
    'This record was changed in another tab — refresh and try again.',
    { currentVersion, submittedVersion });
}
function preconditionRequired() {
  return new LocalStoreError(428, 'Missing version — refresh and try again.');
}

// ---------------------------------------------------------------------------
// IndexedDB helpers

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new LocalStoreError(500, 'IndexedDB is not available in this browser'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('bills'))    db.createObjectStore('bills',    { keyPath: 'id' });
      if (!db.objectStoreNames.contains('credits'))  db.createObjectStore('credits',  { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('billPayments')) {
        const s = db.createObjectStore('billPayments', { keyPath: ['billId', 'cycleKey'] });
        s.createIndex('byBillId', 'billId', { unique: false });
      }
      if (!db.objectStoreNames.contains('creditPayments')) {
        const s = db.createObjectStore('creditPayments', { keyPath: ['creditId', 'ym'] });
        s.createIndex('byCreditId', 'creditId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new LocalStoreError(500, 'Failed to open IndexedDB: ' + req.error?.message));
    req.onblocked = () => reject(new LocalStoreError(500, 'IndexedDB blocked by another tab — close other tabs and retry'));
  });
  return dbPromise;
}

// Run a transaction. `fn(stores)` may be sync or async. The transaction stays
// alive until the returned promise settles. If `fn` throws, the transaction
// aborts. Returns whatever `fn` returns.
async function tx(mode, names, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = {};
    for (const n of names) stores[n] = t.objectStore(n);
    let result;
    let settled = false;
    t.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
    t.onerror = () => { if (!settled) { settled = true; reject(t.error || new Error('Transaction error')); } };
    t.onabort = () => { if (!settled) { settled = true; reject(t.error || new Error('Transaction aborted')); } };
    Promise.resolve()
      .then(() => fn(stores))
      .then(r => { result = r; })
      .catch(err => {
        try { t.abort(); } catch { /* already aborted */ }
        if (!settled) { settled = true; reject(err); }
      });
  });
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAll(store) {
  return reqAsPromise(store.getAll());
}

// ---------------------------------------------------------------------------
// UUID v4 (browser only — uses crypto.randomUUID where available, otherwise a
// crypto.getRandomValues fallback).

function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nowSql() {
  // Same shape SQLite emits via `datetime('now')` (UTC, no timezone).
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

// ---------------------------------------------------------------------------
// Validators that mirror server-side rules. Throw 400s with the same wording
// patterns the server uses so the UI behaves identically.

function vString(name, val, { min = 0, max = Infinity, allowEmpty = false } = {}) {
  if (typeof val !== 'string') throw badRequest(`${name} must be a string`);
  if (!allowEmpty && val.length === 0) throw badRequest(`${name} is required`);
  if (val.length < min) throw badRequest(`${name} must be at least ${min} characters`);
  if (val.length > max) throw badRequest(`${name} must be at most ${max} characters`);
  return val;
}

function vNumber(name, val, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n)) throw badRequest(`${name} must be a number`);
  if (integer && !Number.isInteger(n)) throw badRequest(`${name} must be an integer`);
  if (n < min || n > max) throw badRequest(`${name} out of range`);
  return n;
}

function vEnum(name, val, allowed) {
  if (!allowed.includes(val)) throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  return val;
}

function vIsoDate(name, val) {
  if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    throw badRequest(`${name} must be YYYY-MM-DD`);
  }
  if (Number.isNaN(new Date(val).getTime())) throw badRequest(`${name} is not a valid date`);
  return val;
}

function validateBill(input) {
  const out = {};
  out.name        = vString('name', input.name, { min: 1, max: 120 });
  out.amount      = vNumber('amount', input.amount, { min: 0, max: 1e12 });
  out.dueDay      = vNumber('dueDay', input.dueDay, { min: 1, max: 31, integer: true });
  out.recurrence  = vEnum('recurrence', input.recurrence, RECURRENCE);
  out.category    = vString('category', input.category, { min: 1, max: 60 });
  out.dueMonth    = input.dueMonth == null ? null
    : vNumber('dueMonth', input.dueMonth, { min: 1, max: 12, integer: true });
  out.anchorMonth = input.anchorMonth == null ? null
    : vNumber('anchorMonth', input.anchorMonth, { min: 1, max: 3, integer: true });
  out.notes       = vString('notes', input.notes ?? '', { max: 1000, allowEmpty: true });

  if (out.recurrence === 'Annually' && out.dueMonth == null) {
    throw badRequest('dueMonth is required for Annually recurrence');
  }
  if (out.recurrence === 'Quarterly' && out.anchorMonth == null) {
    throw badRequest('anchorMonth is required for Quarterly recurrence');
  }
  if (out.recurrence === 'Monthly')   { out.dueMonth = null; out.anchorMonth = null; }
  if (out.recurrence === 'Annually')  { out.anchorMonth = null; }
  if (out.recurrence === 'Quarterly') { out.dueMonth = null; }
  return out;
}

function validateCredit(input) {
  const out = {};
  out.name         = vString('name', input.name, { min: 1, max: 120 });
  out.lender       = vString('lender', input.lender ?? '', { max: 120, allowEmpty: true });
  out.principal    = vNumber('principal', input.principal, { min: 0, max: 1e12 });
  out.ratePct      = vNumber('ratePct', input.ratePct, { min: 0, max: 1e6 });
  out.interestType = vEnum('interestType', input.interestType, INTEREST_TYPES);
  out.termMonths   = vNumber('termMonths', input.termMonths, { min: 1, max: 600, integer: true });
  out.startDate    = vIsoDate('startDate', input.startDate);
  out.endDate      = vIsoDate('endDate', input.endDate);
  out.notes        = vString('notes', input.notes ?? '', { max: 1000, allowEmpty: true });
  if (out.endDate < out.startDate) throw badRequest('endDate must be on or after startDate');
  return out;
}

// ---------------------------------------------------------------------------
// Hydration helpers — turn a raw row plus its payments into the canonical
// camelCase object the modules expect.

async function hydrateBill(stores, billId) {
  const row = await reqAsPromise(stores.bills.get(billId));
  if (!row) return null;
  const payments = await reqAsPromise(stores.billPayments.index('byBillId').getAll(billId));
  return {
    id: row.id,
    name: row.name,
    amount: row.amount,
    dueDay: row.dueDay,
    recurrence: row.recurrence,
    category: row.category,
    dueMonth: row.dueMonth,
    anchorMonth: row.anchorMonth,
    notes: row.notes,
    payments: payments.map(p => p.cycleKey),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function hydrateCredit(stores, creditId) {
  const row = await reqAsPromise(stores.credits.get(creditId));
  if (!row) return null;
  const payments = await reqAsPromise(stores.creditPayments.index('byCreditId').getAll(creditId));
  return {
    id: row.id,
    name: row.name,
    lender: row.lender,
    principal: row.principal,
    ratePct: row.ratePct,
    interestType: row.interestType,
    termMonths: row.termMonths,
    startDate: row.startDate,
    endDate: row.endDate,
    notes: row.notes,
    payments: payments.map(p => ({ ym: p.ym, amount: p.amount, paidAt: p.paidAt })),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

// ---------------------------------------------------------------------------
// Public API — same surface as api.js so storage/index.js can swap them.

export const localStore = {
  // -- bills ----------------------------------------------------------------
  async listBills() {
    return tx('readonly', ['bills', 'billPayments'], async (s) => {
      const rows = await getAll(s.bills);
      const allPay = await getAll(s.billPayments);
      const byBill = new Map();
      for (const p of allPay) {
        if (!byBill.has(p.billId)) byBill.set(p.billId, []);
        byBill.get(p.billId).push(p.cycleKey);
      }
      rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      return rows.map(r => ({
        id: r.id,
        name: r.name,
        amount: r.amount,
        dueDay: r.dueDay,
        recurrence: r.recurrence,
        category: r.category,
        dueMonth: r.dueMonth,
        anchorMonth: r.anchorMonth,
        notes: r.notes,
        payments: byBill.get(r.id) || [],
        version: r.version,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
      }));
    });
  },

  async createBill(input) {
    const data = validateBill(input);
    const now = nowSql();
    const id = uuid();
    return tx('readwrite', ['bills', 'billPayments'], async (s) => {
      await reqAsPromise(s.bills.add({ id, ...data, version: 1, createdAt: now, updatedAt: now }));
      return hydrateBill(s, id);
    });
  },

  async updateBill(id, input, version) {
    if (version == null) throw preconditionRequired();
    const data = validateBill(input);
    return tx('readwrite', ['bills', 'billPayments'], async (s) => {
      const row = await reqAsPromise(s.bills.get(id));
      if (!row) throw notFound('Bill');
      if (row.version !== version) throw conflict(row.version, version);
      await reqAsPromise(s.bills.put({
        ...row, ...data, version: row.version + 1, updatedAt: nowSql()
      }));
      return hydrateBill(s, id);
    });
  },

  async deleteBill(id, version) {
    if (version == null) throw preconditionRequired();
    return tx('readwrite', ['bills', 'billPayments'], async (s) => {
      const row = await reqAsPromise(s.bills.get(id));
      if (!row) throw notFound('Bill');
      if (row.version !== version) throw conflict(row.version, version);
      // Cascade delete payment rows.
      const payIdx = s.billPayments.index('byBillId');
      const toDelete = await reqAsPromise(payIdx.getAllKeys(id));
      for (const k of toDelete) await reqAsPromise(s.billPayments.delete(k));
      await reqAsPromise(s.bills.delete(id));
      return null;
    });
  },

  async toggleBillPayment(id, cycleKey, version) {
    if (version == null) throw preconditionRequired();
    if (!CYCLE_KEY_RE.test(cycleKey)) throw badRequest('Invalid cycle key');
    return tx('readwrite', ['bills', 'billPayments'], async (s) => {
      const row = await reqAsPromise(s.bills.get(id));
      if (!row) throw notFound('Bill');
      if (row.version !== version) throw conflict(row.version, version);
      const key = [id, cycleKey];
      const existing = await reqAsPromise(s.billPayments.get(key));
      if (existing) {
        await reqAsPromise(s.billPayments.delete(key));
      } else {
        await reqAsPromise(s.billPayments.add({ billId: id, cycleKey, paidAt: nowSql() }));
      }
      await reqAsPromise(s.bills.put({ ...row, version: row.version + 1, updatedAt: nowSql() }));
      return hydrateBill(s, id);
    });
  },

  // -- credits --------------------------------------------------------------
  async listCredits() {
    return tx('readonly', ['credits', 'creditPayments'], async (s) => {
      const rows = await getAll(s.credits);
      const allPay = await getAll(s.creditPayments);
      const byCredit = new Map();
      for (const p of allPay) {
        if (!byCredit.has(p.creditId)) byCredit.set(p.creditId, []);
        byCredit.get(p.creditId).push({ ym: p.ym, amount: p.amount, paidAt: p.paidAt });
      }
      rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      return rows.map(r => ({
        id: r.id,
        name: r.name,
        lender: r.lender,
        principal: r.principal,
        ratePct: r.ratePct,
        interestType: r.interestType,
        termMonths: r.termMonths,
        startDate: r.startDate,
        endDate: r.endDate,
        notes: r.notes,
        payments: byCredit.get(r.id) || [],
        version: r.version,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
      }));
    });
  },

  async createCredit(input) {
    const data = validateCredit(input);
    const now = nowSql();
    const id = uuid();
    return tx('readwrite', ['credits', 'creditPayments'], async (s) => {
      await reqAsPromise(s.credits.add({ id, ...data, version: 1, createdAt: now, updatedAt: now }));
      return hydrateCredit(s, id);
    });
  },

  async updateCredit(id, input, version) {
    if (version == null) throw preconditionRequired();
    const data = validateCredit(input);
    return tx('readwrite', ['credits', 'creditPayments'], async (s) => {
      const row = await reqAsPromise(s.credits.get(id));
      if (!row) throw notFound('Credit');
      if (row.version !== version) throw conflict(row.version, version);
      await reqAsPromise(s.credits.put({
        ...row, ...data, version: row.version + 1, updatedAt: nowSql()
      }));
      return hydrateCredit(s, id);
    });
  },

  async deleteCredit(id, version) {
    if (version == null) throw preconditionRequired();
    return tx('readwrite', ['credits', 'creditPayments'], async (s) => {
      const row = await reqAsPromise(s.credits.get(id));
      if (!row) throw notFound('Credit');
      if (row.version !== version) throw conflict(row.version, version);
      const payIdx = s.creditPayments.index('byCreditId');
      const toDelete = await reqAsPromise(payIdx.getAllKeys(id));
      for (const k of toDelete) await reqAsPromise(s.creditPayments.delete(k));
      await reqAsPromise(s.credits.delete(id));
      return null;
    });
  },

  async toggleCreditPayment(id, ym, amount, version) {
    if (version == null) throw preconditionRequired();
    if (!YM_RE.test(ym)) throw badRequest('ym must be YYYY-MM');
    let amt = null;
    if (amount != null && amount !== '') {
      amt = vNumber('amount', amount, { min: 0, max: 1e12 });
    }
    return tx('readwrite', ['credits', 'creditPayments'], async (s) => {
      const row = await reqAsPromise(s.credits.get(id));
      if (!row) throw notFound('Credit');
      if (row.version !== version) throw conflict(row.version, version);
      const key = [id, ym];
      const existing = await reqAsPromise(s.creditPayments.get(key));
      if (existing) {
        await reqAsPromise(s.creditPayments.delete(key));
      } else {
        await reqAsPromise(s.creditPayments.add({ creditId: id, ym, amount: amt, paidAt: nowSql() }));
      }
      await reqAsPromise(s.credits.put({ ...row, version: row.version + 1, updatedAt: nowSql() }));
      return hydrateCredit(s, id);
    });
  },

  async updateCreditPaymentAmount(id, ym, amount, version) {
    if (version == null) throw preconditionRequired();
    if (!YM_RE.test(ym)) throw badRequest('ym must be YYYY-MM');
    let amt = null;
    if (amount != null && amount !== '') {
      amt = vNumber('amount', amount, { min: 0, max: 1e12 });
    }
    return tx('readwrite', ['credits', 'creditPayments'], async (s) => {
      const row = await reqAsPromise(s.credits.get(id));
      if (!row) throw notFound('Credit');
      if (row.version !== version) throw conflict(row.version, version);
      const key = [id, ym];
      const existing = await reqAsPromise(s.creditPayments.get(key));
      if (!existing) throw notFound('Payment');
      await reqAsPromise(s.creditPayments.put({ ...existing, amount: amt }));
      await reqAsPromise(s.credits.put({ ...row, version: row.version + 1, updatedAt: nowSql() }));
      return hydrateCredit(s, id);
    });
  },

  // -- settings -------------------------------------------------------------
  async getSettings() {
    return tx('readonly', ['settings'], async (s) => {
      const rows = await getAll(s.settings);
      const out = {};
      for (const r of rows) out[r.key] = r.value;
      if (!out.currency) out.currency = '\u20b1';
      return out;
    });
  },

  async updateSettings(input) {
    const currency = vString('currency', input.currency, { min: 1, max: 8 });
    return tx('readwrite', ['settings'], async (s) => {
      await reqAsPromise(s.settings.put({ key: 'currency', value: currency }));
      const rows = await getAll(s.settings);
      const out = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    });
  },

  // Export shape mirrors the server's /api/settings/export endpoint exactly so
  // a JSON file from one device imports cleanly on the other.
  async exportData() {
    return tx('readonly', STORES, async (s) => {
      const settingsRows = await getAll(s.settings);
      const settingsObj = {};
      for (const r of settingsRows) settingsObj[r.key] = r.value;
      if (!settingsObj.currency) settingsObj.currency = '\u20b1';

      const bills = (await getAll(s.bills)).map(b => ({
        id: b.id,
        name: b.name,
        amount: b.amount,
        due_day: b.dueDay,
        recurrence: b.recurrence,
        category: b.category,
        due_month: b.dueMonth,
        anchor_month: b.anchorMonth,
        notes: b.notes,
        created_at: b.createdAt,
        updated_at: b.updatedAt,
        version: b.version
      }));
      const billPayments = (await getAll(s.billPayments)).map(p => ({
        bill_id: p.billId, cycle_key: p.cycleKey, paid_at: p.paidAt
      }));
      const credits = (await getAll(s.credits)).map(c => ({
        id: c.id,
        name: c.name,
        lender: c.lender,
        principal: c.principal,
        rate_pct: c.ratePct,
        interest_type: c.interestType,
        term_months: c.termMonths,
        start_date: c.startDate,
        end_date: c.endDate,
        notes: c.notes,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        version: c.version
      }));
      const creditPayments = (await getAll(s.creditPayments)).map(p => ({
        credit_id: p.creditId, ym: p.ym, amount: p.amount, paid_at: p.paidAt
      }));

      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: settingsObj,
        bills,
        billPayments,
        credits,
        creditPayments
      };
    });
  },

  // Import: replace everything with the contents of the snapshot. Validates
  // *before* destroying so a malformed file doesn't wipe the device.
  async importData(snap) {
    if (!snap || typeof snap !== 'object') throw badRequest('Invalid import payload');
    const bills = Array.isArray(snap.bills) ? snap.bills : [];
    const credits = Array.isArray(snap.credits) ? snap.credits : [];
    const billPayments = Array.isArray(snap.billPayments) ? snap.billPayments : [];
    const creditPayments = Array.isArray(snap.creditPayments) ? snap.creditPayments : [];

    // First pass — pure validation. Build the cleaned arrays in memory.
    const cleanBills = bills.map((b, i) => {
      try {
        const v = validateBill({
          name: b.name,
          amount: Number(b.amount),
          dueDay: Number(b.due_day),
          recurrence: b.recurrence,
          category: b.category,
          dueMonth: b.due_month,
          anchorMonth: b.anchor_month,
          notes: b.notes ?? ''
        });
        const id = vString(`bill[${i}].id`, b.id, { min: 1, max: 64 });
        const now = nowSql();
        return {
          id, ...v,
          version: Number.isInteger(b.version) && b.version > 0 ? b.version : 1,
          createdAt: typeof b.created_at === 'string' ? b.created_at : now,
          updatedAt: typeof b.updated_at === 'string' ? b.updated_at : now
        };
      } catch (err) {
        throw badRequest(`Invalid bill row at index ${i}: ${err.message}`);
      }
    });
    const cleanCredits = credits.map((c, i) => {
      try {
        const v = validateCredit({
          name: c.name,
          lender: c.lender ?? '',
          principal: Number(c.principal),
          ratePct: Number(c.rate_pct),
          interestType: c.interest_type,
          termMonths: Number(c.term_months),
          startDate: c.start_date,
          endDate: c.end_date,
          notes: c.notes ?? ''
        });
        const id = vString(`credit[${i}].id`, c.id, { min: 1, max: 64 });
        const now = nowSql();
        return {
          id, ...v,
          version: Number.isInteger(c.version) && c.version > 0 ? c.version : 1,
          createdAt: typeof c.created_at === 'string' ? c.created_at : now,
          updatedAt: typeof c.updated_at === 'string' ? c.updated_at : now
        };
      } catch (err) {
        throw badRequest(`Invalid credit row at index ${i}: ${err.message}`);
      }
    });

    const billIds = new Set(cleanBills.map(b => b.id));
    const creditIds = new Set(cleanCredits.map(c => c.id));

    const cleanBillPayments = billPayments.map((p, i) => {
      if (!p || typeof p !== 'object') throw badRequest(`Invalid billPayment row at index ${i}`);
      if (typeof p.bill_id !== 'string' || !billIds.has(p.bill_id)) {
        throw badRequest(`billPayment row ${i}: bill_id "${p.bill_id}" not found in import`);
      }
      if (typeof p.cycle_key !== 'string' || !CYCLE_KEY_RE.test(p.cycle_key)) {
        throw badRequest(`billPayment row ${i}: invalid cycle_key`);
      }
      return { billId: p.bill_id, cycleKey: p.cycle_key, paidAt: p.paid_at || nowSql() };
    });

    const cleanCreditPayments = creditPayments.map((p, i) => {
      if (!p || typeof p !== 'object') throw badRequest(`Invalid creditPayment row at index ${i}`);
      if (typeof p.credit_id !== 'string' || !creditIds.has(p.credit_id)) {
        throw badRequest(`creditPayment row ${i}: credit_id "${p.credit_id}" not found in import`);
      }
      if (typeof p.ym !== 'string' || !YM_RE.test(p.ym)) {
        throw badRequest(`creditPayment row ${i}: ym must be YYYY-MM`);
      }
      let amount = null;
      if (p.amount != null && p.amount !== '') {
        amount = vNumber(`creditPayment[${i}].amount`, p.amount, { min: 0, max: 1e12 });
      }
      return { creditId: p.credit_id, ym: p.ym, amount, paidAt: p.paid_at || nowSql() };
    });

    let nextCurrency = null;
    if (snap.settings && typeof snap.settings === 'object' && snap.settings.currency != null) {
      nextCurrency = vString('settings.currency', snap.settings.currency, { min: 1, max: 8 });
    }

    // Second pass — wipe and reinsert in one transaction.
    return tx('readwrite', STORES, async (s) => {
      await reqAsPromise(s.bills.clear());
      await reqAsPromise(s.billPayments.clear());
      await reqAsPromise(s.credits.clear());
      await reqAsPromise(s.creditPayments.clear());

      for (const b of cleanBills)         await reqAsPromise(s.bills.put(b));
      for (const p of cleanBillPayments)  await reqAsPromise(s.billPayments.put(p));
      for (const c of cleanCredits)       await reqAsPromise(s.credits.put(c));
      for (const p of cleanCreditPayments)await reqAsPromise(s.creditPayments.put(p));

      if (nextCurrency != null) {
        await reqAsPromise(s.settings.put({ key: 'currency', value: nextCurrency }));
      }
      return { ok: true };
    });
  },

  async resetData() {
    return tx('readwrite', STORES, async (s) => {
      await reqAsPromise(s.bills.clear());
      await reqAsPromise(s.billPayments.clear());
      await reqAsPromise(s.credits.clear());
      await reqAsPromise(s.creditPayments.clear());
      // Currency setting preserved.
      return { ok: true };
    });
  }
};
