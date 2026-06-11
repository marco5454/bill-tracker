import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

// Migration filename convention: NNN_label.sql, e.g. 001_init.sql, 002_add_index.sql.
// id is the leading numeric segment (parsed as integer). Files are applied in id order.
const FILE_RE = /^(\d{3,})_[a-z0-9_-]+\.sql$/i;

function listMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => FILE_RE.test(f))
    .map((f) => ({
      id: parseInt(f.match(FILE_RE)[1], 10),
      filename: f,
      path: join(MIGRATIONS_DIR, f),
    }))
    .sort((a, b) => a.id - b.id);
}

function ensureSchemaTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id          INTEGER PRIMARY KEY,
      filename    TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function getAppliedIds(db) {
  const rows = db.prepare('SELECT id FROM schema_version ORDER BY id').all();
  return new Set(rows.map((r) => r.id));
}

/**
 * Apply any pending migrations in order. Each migration runs inside a single
 * transaction; if it throws, the DB is rolled back to the previous state and
 * the error propagates so startup fails fast.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{logger?: (msg: string) => void}} [opts]
 * @returns {{applied: number[]}}
 */
export function runMigrations(db, opts = {}) {
  const log = opts.logger || ((m) => console.log(m));
  ensureSchemaTable(db);
  const all = listMigrations();
  if (all.length === 0) {
    log('[migrate] no migration files found');
    return { applied: [] };
  }
  const applied = getAppliedIds(db);
  const pending = all.filter((m) => !applied.has(m.id));
  if (pending.length === 0) {
    log(`[migrate] up to date (${all.length} migration${all.length === 1 ? '' : 's'} applied)`);
    return { applied: [] };
  }
  // Validate id contiguity and uniqueness
  const ids = all.map((m) => m.id);
  const uniq = new Set(ids);
  if (uniq.size !== ids.length) {
    throw new Error('[migrate] duplicate migration ids detected');
  }
  const appliedNow = [];
  const insert = db.prepare('INSERT OR IGNORE INTO schema_version (id, filename) VALUES (?, ?)');
  for (const m of pending) {
    const sql = readFileSync(m.path, 'utf8');
    log(`[migrate] applying ${m.filename}`);
    // Use a deferred transaction wrapped manually with BEGIN IMMEDIATE so
    // we acquire the write lock up-front. Without this, two server
    // processes starting on the same DB could both observe the migration
    // as pending, both run db.exec(sql), and the second's INSERT would
    // succeed too (now uses INSERT OR IGNORE) — but more importantly the
    // schema-changing exec would run twice. BEGIN IMMEDIATE serializes
    // writers so the second process blocks until the first commits, then
    // re-checks the applied set.
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      // Re-check applied state under the write lock — another process may
      // have applied this migration while we were waiting on the lock.
      const already = db.prepare('SELECT 1 FROM schema_version WHERE id = ?').get(m.id);
      if (!already) {
        db.exec(sql);
        insert.run(m.id, m.filename);
        appliedNow.push(m.id);
      } else {
        log(`[migrate] ${m.filename} already applied by concurrent process, skipping`);
      }
      db.exec('COMMIT');
      committed = true;
    } catch (err) {
      if (!committed) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      }
      err.message = `[migrate] failed on ${m.filename}: ${err.message}`;
      throw err;
    }
  }
  log(`[migrate] applied ${appliedNow.length} migration${appliedNow.length === 1 ? '' : 's'}`);
  return { applied: appliedNow };
}
