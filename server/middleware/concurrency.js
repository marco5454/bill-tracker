// Optimistic-concurrency helpers.
//
// Every write endpoint in bills/credits requires the client to supply the
// last-known row version via the `If-Match` request header. This prevents
// silent overwrites when the same record is open in multiple tabs.
//
// Wire format: `If-Match: "<integer>"` (RFC 7232 entity tag). We accept the
// integer on its own as well — easier for ad-hoc curl. Servers respond with
// the new version in the `ETag` response header on success.
import { HttpError } from './error.js';

/**
 * Parse the If-Match header into a positive integer.
 * Throws HttpError(428) when missing, HttpError(400) when malformed.
 *
 * Wildcard (`*`) is rejected: this app's update path always wants a specific
 * version match.
 */
export function requireIfMatch(req) {
  const raw = req.get?.('If-Match');
  if (!raw) {
    throw new HttpError(428, 'If-Match header is required for this operation', {
      hint: 'Re-fetch the resource and send its current version back in If-Match',
    });
  }
  const trimmed = raw.trim();
  if (trimmed === '*') {
    throw new HttpError(400, 'If-Match: * is not supported on this resource');
  }
  // Strip optional surrounding quotes, allow optional weak prefix W/.
  const m = trimmed.match(/^(?:W\/)?"?(-?\d+)"?$/);
  if (!m) {
    throw new HttpError(400, 'If-Match must be a quoted integer (e.g. "3")');
  }
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > Number.MAX_SAFE_INTEGER) {
    throw new HttpError(400, 'If-Match version must be a positive integer');
  }
  return n;
}

/**
 * Compare a client-provided version to the row's current version.
 * Throws HttpError(412 Precondition Failed) on mismatch, with the current
 * version surfaced so the client can refetch.
 */
export function assertVersionMatch(currentVersion, clientVersion) {
  if (currentVersion !== clientVersion) {
    throw new HttpError(412, 'Version mismatch: resource has been modified', {
      currentVersion,
      submittedVersion: clientVersion,
    });
  }
}

/**
 * Set the `ETag` response header to the given version.
 */
export function setVersionHeader(res, version) {
  res.set('ETag', `"${version}"`);
}
