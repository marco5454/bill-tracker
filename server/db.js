import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR    = join(__dirname, '..', 'data');
const DB_PATH     = join(DATA_DIR, 'billtracker.db');
const BACKUP_DIR  = join(DATA_DIR, 'backups');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

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

// Reliability + safety
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// Apply schema (idempotent)
const schema = readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// Seed default settings if missing
const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
seed.run('currency', '\u20b1');

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
