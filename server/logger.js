// Tiny zero-dependency structured logger.
//
// Output format:
//   - In production (or whenever stdout is not a TTY): newline-delimited JSON,
//     one record per line. Easy to ingest by any log shipper.
//   - In development (TTY stdout): a short human-readable line, with the
//     structured fields appended as a compact JSON tail. Errors still emit
//     their stack trace.
//
// Levels: debug(10) < info(20) < warn(30) < error(40) < silent(99).
// Configure with BILLTRACKER_LOG_LEVEL (case-insensitive). Default is `info`,
// or `silent` when running under tests (NODE_ENV=test or
// BILLTRACKER_DATA_DIR set, matching the convention in db.js).
//
// Public API:
//   const log = createLogger();              // root
//   log.info('hello', { foo: 1 });           // -> {"level":"info","msg":"hello","foo":1,...}
//   const child = log.child({ reqId: 'x' }); // attaches reqId to every record
//   child.warn('careful');
//
// The default singleton is exported as `logger`.

const LEVELS = Object.freeze({
  debug: 10,
  info:  20,
  warn:  30,
  error: 40,
  silent: 99,
});

const LEVEL_NAMES = Object.freeze({
  10: 'debug',
  20: 'info',
  30: 'warn',
  40: 'error',
});

function resolveDefaultLevel() {
  const fromEnv = String(process.env.BILLTRACKER_LOG_LEVEL || '').toLowerCase();
  if (fromEnv && fromEnv in LEVELS) return LEVELS[fromEnv];
  if (process.env.NODE_ENV === 'test' || process.env.BILLTRACKER_DATA_DIR) {
    return LEVELS.silent;
  }
  return LEVELS.info;
}

function isTTY() {
  return Boolean(process.stdout && process.stdout.isTTY);
}

// Sanitize a string field so it can never break the JSON line or terminal.
// We don't try to escape — JSON.stringify handles that — but we replace
// non-printable control chars (except tab) with spaces to avoid log injection.
function sanitizeString(s) {
  if (typeof s !== 'string') return s;
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000A-\u001F\u007F]/g, ' ');
}

function safeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Error) {
      return {
        name: value.name,
        message: sanitizeString(value.message),
        stack: value.stack ? sanitizeString(value.stack) : undefined,
        ...(value.code ? { code: value.code } : {}),
      };
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    if (typeof value === 'string') return sanitizeString(value);
    return value;
  });
}

function levelFor(name) {
  const n = String(name || '').toLowerCase();
  return LEVELS[n] ?? LEVELS.info;
}

/**
 * Build a logger.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.level]       numeric level threshold
 * @param {boolean} [opts.pretty]      force pretty / json output (default: auto)
 * @param {object}  [opts.bindings]    fields automatically attached to every record
 * @param {Function}[opts.write]       custom writer(line: string, levelNum: number)
 */
export function createLogger(opts = {}) {
  const level = typeof opts.level === 'number' ? opts.level : resolveDefaultLevel();
  const pretty = typeof opts.pretty === 'boolean' ? opts.pretty : isTTY();
  const bindings = { ...(opts.bindings || {}) };
  const write = opts.write || defaultWrite;

  function log(levelNum, msg, fields) {
    if (levelNum < level) return;
    const rec = {
      level: LEVEL_NAMES[levelNum] || 'info',
      time: new Date().toISOString(),
      msg: typeof msg === 'string' ? sanitizeString(msg) : msg,
      ...bindings,
      ...(fields || {}),
    };
    let line;
    if (pretty) {
      const tag = `[${rec.time}] ${rec.level.toUpperCase()}`;
      const ctx = formatContextTail(rec, ['level', 'time', 'msg']);
      line = ctx ? `${tag} ${rec.msg}  ${ctx}` : `${tag} ${rec.msg}`;
    } else {
      line = safeStringify(rec);
    }
    write(line, levelNum);
  }

  return {
    level,
    debug: (msg, fields) => log(LEVELS.debug, msg, fields),
    info:  (msg, fields) => log(LEVELS.info,  msg, fields),
    warn:  (msg, fields) => log(LEVELS.warn,  msg, fields),
    error: (msg, fields) => log(LEVELS.error, msg, fields),
    /**
     * Create a child logger that automatically attaches the given fields to
     * every record it emits. Children share the parent's level and writer.
     */
    child(extra) {
      return createLogger({
        level,
        pretty,
        bindings: { ...bindings, ...(extra || {}) },
        write,
      });
    },
  };
}

function formatContextTail(rec, omit) {
  const out = {};
  let any = false;
  for (const k of Object.keys(rec)) {
    if (omit.includes(k)) continue;
    out[k] = rec[k];
    any = true;
  }
  return any ? safeStringify(out) : '';
}

function defaultWrite(line, levelNum) {
  // Errors and warnings to stderr, everything else to stdout.
  if (levelNum >= LEVELS.warn) {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

// Default singleton used by middleware and the bootstrap. Tests should import
// `createLogger` directly to get an isolated instance.
export const logger = createLogger();
export const _LEVELS = LEVELS;
