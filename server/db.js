// SQLite connection + bootstrap.
//
// On module import we:
//   1. Resolve the data directory (BILLTRACKER_DATA_DIR override → ../data).
//   2. Ensure data/ + data/backups/ exist.
//   3. Open the DB with WAL + foreign-keys.
//   4. Run any pending migrations from server/migrations/ (idempotent).
//   5. Seed default settings.
//   6. Snapshot the now-open DB into data/backups/ via better-sqlite3's
//      online backup API (consistent across WAL), using a tmp+rename for
//      crash-safety and a random suffix to avoid same-ms collisions.
//      Then trim to the newest 7.
//
// `pingDb()` runs a trivial round-trip and reports duration; used by readiness.
// `closeDb()` checkpoints the WAL and closes the handle.
import Database from 'better-sqlite3';
import {
  mkdirSync, existsSync, openSync, fsyncSync, closeSync,
  readdirSync, statSync, unlinkSync, renameSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { runMigrations } from './migrate.js';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tests set BILLTRACKER_DATA_DIR to an isolated temp dir. Production reads
// from the project's data/ directory.
const DATA_DIR    = process.env.BILLTRACKER_DATA_DIR || join(__dirname, '..', 'data');
const DB_PATH     = join(DATA_DIR, 'billtracker.db');
const BACKUP_DIR  = join(DATA_DIR, 'backups');

// Skip the backup-on-start in tests: BILLTRACKER_DATA_DIR is set by the
// harness for an isolated tmp dir, and backups would just litter it.
const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.BILLTRACKER_DATA_DIR);

function ensureDirs() {
  if (!existsSync(DATA_DIR))   mkdirSync(DATA_DIR,   { recursive: true });
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * Snapshot the live DB into BACKUP_DIR using better-sqlite3's online backup
 * API. Unlike a raw file copy, this honors SQLite's locking protocol and
 * captures any uncheckpointed pages from the WAL, so the resulting file is
 * always a consistent, openable database — even if the server later crashes
 * with `kill -9` before its next clean shutdown.
 *
 * The backup is written to `<target>.tmp`, fsynced, then atomically renamed.
 * A random hex suffix on the timestamp prevents collisions when two starts
 * land in the same millisecond.
 *
 * Failures are logged but never block startup.
 */
async function snapshotBackup(handle, keep = 7) {
  const stamp  = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(3).toString('hex'); // 6 hex chars
  const target = join(BACKUP_DIR, `billtracker-${stamp}-${suffix}.db`);
  const tmp    = `${target}.tmp`;
  try {
    await handle.backup(tmp);
    // Best-effort fsync of the new file before rename. Using openSync solely
    // to obtain an fd we can fsync — avoids the `fs.fsync(path,...)` cb-only
    // shape and works on any platform that exposes fsync.
    let fd = -1;
    try {
      fd = openSync(tmp, 'r');
      fsyncSync(fd);
    } finally {
      if (fd >= 0) { try { closeSync(fd); } catch { /* ignore */ } }
    }
    renameSync(tmp, target);
  } catch (err) {
    // Surface the failure (disk full, EACCES, etc.) but keep starting.
    logger.warn('backup.failed', {
      target,
      error: err && err.message ? String(err.message) : String(err),
    });
    // Best-effort cleanup of any stray .tmp.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    return;
  }
  // Trim oldest beyond `keep` (newest first by mtime).
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => ({ f, t: statSync(join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(keep)) {
      try { unlinkSync(join(BACKUP_DIR, old.f)); } catch { /* ignore */ }
    }
  } catch (err) {
    logger.warn('backup.rotate_failed', {
      error: err && err.message ? String(err.message) : String(err),
    });
  }
}

ensureDirs();

export const db = new Database(DB_PATH);

// Reliability + safety pragmas. WAL allows concurrent readers, NORMAL synchronous
// is the standard tradeoff for desktop apps (durable across crashes, not power loss).
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// Apply migrations. Silent in tests; otherwise log to stdout.
runMigrations(db, { logger: isTest ? () => {} : (m) => console.log(m) });

// Seed default settings if missing
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('currency', '\u20b1');

// Snapshot the now-open, fully-migrated DB. Skipped in tests.
if (!isTest) {
  await snapshotBackup(db);
}

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
