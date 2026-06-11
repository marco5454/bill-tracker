// CSRF mitigation for an unauthenticated, loopback-by-default API.
//
// The threat: a malicious page the user visits in any browser on the same
// machine could otherwise issue state-changing requests against
// http://127.0.0.1:3000/api/* using "simple requests" (form-urlencoded POSTs
// without a CORS preflight) and successfully mutate the local database.
//
// The defense, applied to all non-safe methods on /api/*:
//   1. If the request carries an Origin or Referer header, its host MUST be
//      in the allow-list. Browsers attach Origin to all CORS-relevant
//      requests including same-origin POSTs in modern engines.
//   2. If the request has no Origin AND no Referer (typical of curl/httpie),
//      we require a custom `X-Requested-With: billtracker` header. Browsers
//      cannot set arbitrary custom headers on a "simple request" without
//      triggering a CORS preflight that the API does not satisfy, so the
//      header's presence is itself proof the request didn't originate from
//      a cross-origin page.
//
// This is a separate module so it can be unit-tested without booting the
// full Express app.

export function createCsrfGuard({ allowedHosts }) {
  const allowSet = new Set(
    Array.from(allowedHosts || [], (h) => String(h).toLowerCase()),
  );

  function isOriginAllowed(rawOrigin) {
    if (!rawOrigin) return false;
    try {
      const u = new URL(rawOrigin);
      const host = u.host.toLowerCase();
      const hostname = u.hostname.toLowerCase();
      return allowSet.has(host) || allowSet.has(hostname);
    } catch {
      return false;
    }
  }

  return function csrfGuard(req, res, next) {
    const m = req.method;
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
    const origin = req.get('Origin') || req.get('Referer');
    if (origin) {
      if (!isOriginAllowed(origin)) {
        if (req.log) req.log.warn('csrf.origin.rejected', { origin, path: req.path });
        return res.status(403).json({ error: 'Cross-origin write rejected' });
      }
      return next();
    }
    if (req.get('X-Requested-With') === 'billtracker') return next();
    if (req.log) req.log.warn('csrf.header.missing', { path: req.path });
    return res.status(403).json({ error: 'Missing Origin/Referer or X-Requested-With header' });
  };
}
