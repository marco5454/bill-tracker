// Tiny fetch wrapper with consistent error handling.

async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
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
    const msg = (payload && payload.error) || `Request failed (${res.status})`;
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
  updateBill:   (id, data)=> request('PUT',    `/api/bills/${encodeURIComponent(id)}`, data),
  deleteBill:   (id)      => request('DELETE', `/api/bills/${encodeURIComponent(id)}`),
  toggleBillPayment: (id, cycleKey) =>
    request('POST', `/api/bills/${encodeURIComponent(id)}/payments/${encodeURIComponent(cycleKey)}/toggle`),

  // credits
  listCredits:    ()         => request('GET',    '/api/credits'),
  createCredit:   (data)     => request('POST',   '/api/credits', data),
  updateCredit:   (id, data) => request('PUT',    `/api/credits/${encodeURIComponent(id)}`, data),
  deleteCredit:   (id)       => request('DELETE', `/api/credits/${encodeURIComponent(id)}`),
  toggleCreditPayment: (id, ym, amount) =>
    request('POST', `/api/credits/${encodeURIComponent(id)}/payments/${encodeURIComponent(ym)}/toggle`,
      amount != null ? { amount } : {}),
  updateCreditPaymentAmount: (id, ym, amount) =>
    request('PUT', `/api/credits/${encodeURIComponent(id)}/payments/${encodeURIComponent(ym)}`, { amount }),

  // settings
  getSettings:    ()      => request('GET',  '/api/settings'),
  updateSettings: (data)  => request('PUT',  '/api/settings', data),
  exportData:     ()      => request('GET',  '/api/settings/export'),
  importData:     (snap)  => request('POST', '/api/settings/import', snap),
  resetData:      ()      => request('POST', '/api/settings/reset')
};
