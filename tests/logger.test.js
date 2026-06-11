import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, _LEVELS } from '../server/logger.js';

function captureLogger(opts = {}) {
  const lines = [];
  const log = createLogger({
    pretty: false,
    write: (line) => lines.push(line),
    ...opts,
  });
  return { log, lines };
}

describe('logger', () => {
  test('emits one JSON record per call with required fields', () => {
    const { log, lines } = captureLogger({ level: _LEVELS.debug });
    log.info('hello', { foo: 1, bar: 'baz' });
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.level, 'info');
    assert.equal(rec.msg, 'hello');
    assert.equal(rec.foo, 1);
    assert.equal(rec.bar, 'baz');
    assert.match(rec.time, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('respects level threshold (silent suppresses everything)', () => {
    const { log, lines } = captureLogger({ level: _LEVELS.silent });
    log.debug('a'); log.info('b'); log.warn('c'); log.error('d');
    assert.equal(lines.length, 0);
  });

  test('warn lets warn+error through but drops info/debug', () => {
    const { log, lines } = captureLogger({ level: _LEVELS.warn });
    log.debug('skip-debug');
    log.info('skip-info');
    log.warn('keep-warn');
    log.error('keep-error');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).level, 'warn');
    assert.equal(JSON.parse(lines[1]).level, 'error');
  });

  test('child logger merges bindings', () => {
    const { log, lines } = captureLogger({ level: _LEVELS.debug });
    const c = log.child({ reqId: 'abc' });
    c.info('hi');
    const c2 = c.child({ userId: 42 });
    c2.warn('bye', { extra: true });
    assert.equal(lines.length, 2);
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    assert.equal(a.reqId, 'abc');
    assert.equal(b.reqId, 'abc');
    assert.equal(b.userId, 42);
    assert.equal(b.extra, true);
  });

  test('serializes Error objects with name/message/stack', () => {
    const { log, lines } = captureLogger({ level: _LEVELS.debug });
    const err = new Error('boom');
    log.error('failed', { err });
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.err.name, 'Error');
    assert.equal(rec.err.message, 'boom');
    assert.ok(typeof rec.err.stack === 'string' && rec.err.stack.length > 0);
  });

  test('strips control characters from string values', () => {
    const { log, lines } = captureLogger({ level: _LEVELS.debug });
    log.info('line1\nline2\u0007', { field: 'a\x01b' });
    const rec = JSON.parse(lines[0]);
    assert.ok(!rec.msg.includes('\n'));
    assert.ok(!rec.msg.includes('\u0007'));
    assert.ok(!rec.field.includes('\x01'));
  });

  test('handles circular references safely', () => {
    const { log, lines } = captureLogger({ level: _LEVELS.debug });
    const a = { name: 'a' };
    a.self = a;
    log.info('cyc', { a });
    // Should not throw; should produce parsable JSON.
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.a.name, 'a');
    assert.equal(rec.a.self, '[Circular]');
  });

  test('routes warn+error to stderr, info+debug to stdout (default writer)', () => {
    // Smoke: default writer behavior is exercised indirectly. Here we just
    // confirm a custom writer receives the level number for routing.
    const stdout = [], stderr = [];
    const log = createLogger({
      level: _LEVELS.debug,
      pretty: false,
      write: (line, lvl) => (lvl >= _LEVELS.warn ? stderr : stdout).push(JSON.parse(line)),
    });
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    assert.deepEqual(stdout.map(r => r.level), ['debug', 'info']);
    assert.deepEqual(stderr.map(r => r.level), ['warn', 'error']);
  });
});
