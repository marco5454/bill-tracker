// Tiny fetch wrapper with consistent error handling.
//
// Mutating endpoints accept an optional `version` arg; when provided we send
// it as the `If-Match` header for optimistic-concurrency control. The server
// rejects (412) when the row has changed underneath the client and (428) when
// the header is missing on an endpoint that requires it.

async function request(method, url, body, opts = {}) {
  const reqOpts = { method, headers: {} };
  if (body !== undefined) {
    reqOpts.headers['Content-Type'] = 'application/json';
    reqOpts.body = JSON.stringify(body);
  }
  if (opts.ifMatch != null) {
    reqOpts.headers['If-Match'] = `"${opts.ifMatch}"`;
  }
  let res;
  try {
    res = await fetch(url, reqOpts);
  } catch (err) {
    throw new ApiError(0, 'Network error: ' + (err.message || 'failed to fetch'));
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!res.ok) {
    let msg = (payload && payload.error) || `Request failed (${res.status})`;
    // Friendlier surface for the two concurrency states.
    if (res.status === 412) {
      msg = 'This record was changed in another tab — refresh and try again.';
    } else if (res.status === 428) {
      msg = 'Missing version — refresh and try again.';
    }
    throw new ApiError(res.status, msg, payload && payload.details);
  }
  return payload;
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const api = {
  // bills
  listBills:    ()        => request('GET',    '/api/bills'),
  createBill:   (data)    => request('POST',   '/api/bills', data),
  updateBill:   (id, data, version) =>
    request('PUT', `/api/bills/${encodeURIComponent(id)}`, data, { ifMatch: version }),
  deleteBill:   (id, version) =>
    request('DELETE', `/api/bills/${encodeURIComponent(id)}`, undefined, { ifMatch: version }),
  toggleBillPayment: (id, cycleKey, version) =>
    request('POST', `/api/bills/${encodeURIComponent(id)}/payments/${encodeURIComponent(cycleKey)}/toggle`,
      undefined, { ifMatch: version }),

  // credits
  listCredits:    ()         => request('GET',    '/api/credits'),
  createCredit:   (data)     => request('POST',   '/api/credits', data),
  updateCredit:   (id, data, version) =>
    request('PUT', `/api/credits/${encodeURIComponent(id)}`, data, { ifMatch: version }),
  deleteCredit:   (id, version) =>
    request('DELETE', `/api/credits/${encodeURIComponent(id)}`, undefined, { ifMatch: version }),
  toggleCreditPayment: (id, ym, amount, version) =>
    request('POST', `/api/credits/${encodeURIComponent(id)}/payments/${encodeURIComponent(ym)}/toggle`,
      amount != null ? { amount } : {}, { ifMatch: version }),
  updateCreditPaymentAmount: (id, ym, amount, version) =>
    request('PUT', `/api/credits/${encodeURIComponent(id)}/payments/${encodeURIComponent(ym)}`,
      { amount }, { ifMatch: version }),

  // settings
  getSettings:    ()      => request('GET',  '/api/settings'),
  updateSettings: (data)  => request('PUT',  '/api/settings', data),
  exportData:     ()      => request('GET',  '/api/settings/export'),
  importData:     (snap)  => request('POST', '/api/settings/import', snap),
  resetData:      ()      => request('POST', '/api/settings/reset')
};
