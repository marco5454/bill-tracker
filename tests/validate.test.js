import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { v, validate } from '../server/middleware/validate.js';
import { HttpError } from '../server/middleware/error.js';

const expectThrow = (fn, statusOrMatch) => {
  try {
    fn();
    assert.fail('expected function to throw');
  } catch (err) {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${err.constructor.name}`);
    if (typeof statusOrMatch === 'number') {
      assert.equal(err.status, statusOrMatch);
    } else if (statusOrMatch instanceof RegExp) {
      assert.match(err.message, statusOrMatch);
    }
  }
};

describe('v.string', () => {
  it('trims and accepts valid input', () => {
    const fn = v.string({ min: 1, max: 10 });
    assert.equal(fn('  hi  ', 'name'), 'hi');
  });

  it('rejects non-strings', () => {
    expectThrow(() => v.string()(123, 'name'), /must be a string/);
  });

  it('enforces min length', () => {
    expectThrow(() => v.string({ min: 3 })('ab', 'name'), /at least 3/);
  });

  it('enforces max length', () => {
    expectThrow(() => v.string({ max: 3 })('abcd', 'name'), /at most 3/);
  });

  it('treats null/undefined as empty', () => {
    const fn = v.string({ allowEmpty: true });
    assert.equal(fn(null, 'x'), '');
    assert.equal(fn(undefined, 'x'), '');
  });

  it('allowEmpty: true permits empty string even with min default 0', () => {
    assert.equal(v.string({ allowEmpty: true })('', 'x'), '');
  });
});

describe('v.number', () => {
  it('accepts numbers and numeric strings', () => {
    assert.equal(v.number()(5, 'x'), 5);
    assert.equal(v.number()('7.5', 'x'), 7.5);
  });

  it('rejects non-finite values', () => {
    expectThrow(() => v.number()('abc', 'x'), /must be a number/);
    expectThrow(() => v.number()(NaN, 'x'), /must be a number/);
    expectThrow(() => v.number()(Infinity, 'x'), /must be a number/);
  });

  it('enforces integer when asked', () => {
    expectThrow(() => v.number({ integer: true })(1.5, 'x'), /integer/);
    assert.equal(v.number({ integer: true })(3, 'x'), 3);
  });

  it('enforces min/max range', () => {
    expectThrow(() => v.number({ min: 0, max: 10 })(-1, 'x'), /between 0 and 10/);
    expectThrow(() => v.number({ min: 0, max: 10 })(11, 'x'), /between 0 and 10/);
    assert.equal(v.number({ min: 0, max: 10 })(5, 'x'), 5);
  });
});

describe('v.enum', () => {
  it('accepts only listed values', () => {
    const fn = v.enum(['a', 'b']);
    assert.equal(fn('a', 'x'), 'a');
    expectThrow(() => fn('c', 'x'), /one of a, b/);
  });
});

describe('v.isoDate', () => {
  it('accepts YYYY-MM-DD', () => {
    assert.equal(v.isoDate()('2026-06-15', 'd'), '2026-06-15');
  });

  it('rejects malformed strings', () => {
    expectThrow(() => v.isoDate()('2026/06/15', 'd'), /YYYY-MM-DD/);
    expectThrow(() => v.isoDate()('not-a-date', 'd'), /YYYY-MM-DD/);
    expectThrow(() => v.isoDate()(20260615, 'd'), /YYYY-MM-DD/);
  });
});

describe('v.optional', () => {
  it('returns null for nullish/empty input', () => {
    const fn = v.optional(v.number());
    assert.equal(fn(null, 'x'), null);
    assert.equal(fn(undefined, 'x'), null);
    assert.equal(fn('', 'x'), null);
  });

  it('delegates to inner when present', () => {
    const fn = v.optional(v.number({ min: 0 }));
    assert.equal(fn(5, 'x'), 5);
    expectThrow(() => fn(-1, 'x'), /between/);
  });
});

describe('validate(schema, body)', () => {
  it('returns sanitized object containing only declared fields', () => {
    const schema = {
      name: v.string({ min: 1, max: 50 }),
      amount: v.number({ min: 0 }),
    };
    const out = validate(schema, { name: '  hi  ', amount: '12.5', extra: 'dropped' });
    assert.deepEqual(out, { name: 'hi', amount: 12.5 });
  });

  it('throws 400 for non-object body', () => {
    expectThrow(() => validate({ x: v.string() }, null), 400);
    expectThrow(() => validate({ x: v.string() }, 'oops'), 400);
  });

  it('propagates first failing field error', () => {
    const schema = {
      name: v.string({ min: 1 }),
      amount: v.number({ min: 0 }),
    };
    expectThrow(() => validate(schema, { name: '', amount: 5 }), /at least 1/);
  });
});
