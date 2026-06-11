import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { requireIfMatch, assertVersionMatch } from '../server/middleware/concurrency.js';
import { HttpError } from '../server/middleware/error.js';

function fakeReq(headerValue) {
  return {
    get(name) {
      return name.toLowerCase() === 'if-match' ? headerValue : undefined;
    },
  };
}

function expectThrow(fn, status, msgRe) {
  try {
    fn();
    assert.fail('expected to throw');
  } catch (err) {
    assert.ok(err instanceof HttpError, `not HttpError: ${err && err.constructor && err.constructor.name}`);
    assert.equal(err.status, status, `status ${err.status} != ${status}: ${err.message}`);
    if (msgRe) assert.match(err.publicMessage || err.message, msgRe);
    return err;
  }
}

describe('requireIfMatch()', () => {
  test('parses a quoted integer', () => {
    assert.equal(requireIfMatch(fakeReq('"3"')), 3);
  });

  test('parses an unquoted integer (curl-friendly)', () => {
    assert.equal(requireIfMatch(fakeReq('7')), 7);
  });

  test('strips weak prefix W/', () => {
    assert.equal(requireIfMatch(fakeReq('W/"42"')), 42);
  });

  test('trims surrounding whitespace', () => {
    assert.equal(requireIfMatch(fakeReq('  "5"  ')), 5);
  });

  test('throws 428 when header is missing', () => {
    expectThrow(() => requireIfMatch(fakeReq(undefined)), 428, /If-Match/i);
  });

  test('throws 428 when header is empty string', () => {
    expectThrow(() => requireIfMatch(fakeReq('')), 428, /If-Match/i);
  });

  test('rejects wildcard with 400', () => {
    expectThrow(() => requireIfMatch(fakeReq('*')), 400, /wildcard|\*/i);
  });

  test('rejects garbage with 400', () => {
    expectThrow(() => requireIfMatch(fakeReq('not-an-etag')), 400);
  });

  test('rejects zero/negative versions with 400', () => {
    expectThrow(() => requireIfMatch(fakeReq('"0"')), 400);
    expectThrow(() => requireIfMatch(fakeReq('"-3"')), 400);
  });

  test('rejects non-integer numerics', () => {
    expectThrow(() => requireIfMatch(fakeReq('"3.5"')), 400);
  });
});

describe('assertVersionMatch()', () => {
  test('does nothing when versions match', () => {
    assert.doesNotThrow(() => assertVersionMatch(5, 5));
  });

  test('throws 412 with currentVersion details when mismatched', () => {
    const err = expectThrow(() => assertVersionMatch(7, 4), 412, /version/i);
    assert.equal(err.details.currentVersion, 7);
    assert.equal(err.details.submittedVersion, 4);
  });
});
