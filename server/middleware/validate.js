import { HttpError } from './error.js';

// Tiny dependency-free validator. Each validator is (value) => value | throws HttpError.
// Returns a sanitized object containing only declared fields.

export const v = {
  string({ min = 0, max = 500, trim = true, allowEmpty = false } = {}) {
    return (val, field) => {
      if (val == null) val = '';
      if (typeof val !== 'string') throw new HttpError(400, `${field} must be a string`);
      if (trim) val = val.trim();
      if (!allowEmpty && val.length < min) throw new HttpError(400, `${field} must be at least ${min} characters`);
      if (val.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
      return val;
    };
  },
  number({ min = -Infinity, max = Infinity, integer = false } = {}) {
    return (val, field) => {
      const n = typeof val === 'string' ? Number(val) : val;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`);
      if (integer && !Number.isInteger(n)) throw new HttpError(400, `${field} must be an integer`);
      if (n < min || n > max) throw new HttpError(400, `${field} must be between ${min} and ${max}`);
      return n;
    };
  },
  enum(values) {
    return (val, field) => {
      if (!values.includes(val)) throw new HttpError(400, `${field} must be one of ${values.join(', ')}`);
      return val;
    };
  },
  isoDate() {
    return (val, field) => {
      if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        throw new HttpError(400, `${field} must be YYYY-MM-DD`);
      }
      const d = new Date(val + 'T00:00:00');
      if (Number.isNaN(d.getTime())) throw new HttpError(400, `${field} is not a valid date`);
      return val;
    };
  },
  optional(fn) {
    return (val, field) => (val == null || val === '' ? null : fn(val, field));
  }
};

export function validate(schema, body) {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'Request body required');
  const out = {};
  for (const [field, fn] of Object.entries(schema)) {
    out[field] = fn(body[field], field);
  }
  return out;
}
