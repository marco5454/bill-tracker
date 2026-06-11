// SQLite connection + bootstrap.
//
// On module import we:
//   1. Resolve the data directory (BILLTRACKER_DATA_DIR override → ../data).
//   2. Ensure data/ + data/backups/ exist.
//   3. Snapshot the existing DB into data/backups/ (rotating to keep the newest 7).
//   4. Open the DB with WAL + foreign-keys.
//   5. Run any pending migrations from server/migrations/ (idempotent).
//   6. Seed default settings.
//
// `pingDb()` runs a trivial round-trip and reports duration; used by readiness.
// `closeDb()` checkpoints the WAL and closes the handle.
import Database from 'better-sqlite3';
import {
  readFileSync, mkdirSync, existsSync, copyFileSync,
  readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMigrations } from './migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tests set BILLTRACKER_DATA_DIR to an isolated temp dir. Production reads
// from the project's data/ directory.
const DATA_DIR    = process.env.BILLTRACKER_DATA_DIR || join(__dirname, '..', 'data');
const DB_PATH     = join(DATA_DIR, 'billtracker.db');
const BACKUP_DIR  = join(DATA_DIR, 'backups');

function ensureDirs() {
  if (!existsSync(DATA_DIR))   mkdirSync(DATA_DIR,   { recursive: true });
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
}

function rotateBackups(keep = 7) {
  if (!existsSync(DB_PATH)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(BACKUP_DIR, `billtracker-${stamp}.db`);
  try {
    copyFileSync(DB_PATH, target);
  } catch {
    // best-effort; never block startup
    return;
  }
  // Trim oldest beyond `keep`
  const files = readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => ({ f, t: statSync(join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of files.slice(keep)) {
    try { unlinkSync(join(BACKUP_DIR, old.f)); } catch {}
  }
}

ensureDirs();
rotateBackups();

export const db = new Database(DB_PATH);

// Reliability + safety pragmas. WAL allows concurrent readers, NORMAL synchronous
// is the standard tradeoff for desktop apps (durable across crashes, not power loss).
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// Apply migrations. Silent in tests (BILLTRACKER_DATA_DIR set or NODE_ENV=test);
// otherwise log to stdout.
const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.BILLTRACKER_DATA_DIR);
runMigrations(db, { logger: isTest ? () => {} : (m) => console.log(m) });

// Seed default settings if missing
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('currency', '\u20b1');

export function txn(fn) {
  const wrapped = db.transaction(fn);
  return wrapped();
}

let closed = false;

/**
 * Close the database cleanly. Safe to call multiple times.
 * Performs a WAL checkpoint so the main .db file contains all committed data.
 */
export function closeDb() {
  if (closed) return;
  closed = true;
  try {
    // Fold WAL into the main DB so the file is a complete, consistent snapshot.
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // best-effort; proceed to close
  }
  try {
    db.close();
  } catch {
    // best-effort
  }
}

export function isDbClosed() {
  return closed;
}

/**
 * Trivial DB round-trip used by readiness checks. Returns:
 *   { ok: true, durationMs }      on success
 *   { ok: false, error: string }  on failure
 */
export function pingDb() {
  if (closed) return { ok: false, error: 'database is closed' };
  const t0 = process.hrtime.bigint();
  try {
    const r = db.prepare('SELECT 1 AS ok').get();
    if (!r || r.ok !== 1) return { ok: false, error: 'unexpected ping result' };
    const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ok: true, durationMs: Math.round(durationMs * 100) / 100 };
  } catch (err) {
    return { ok: false, error: err && err.message ? String(err.message) : 'ping failed' };
  }
}
