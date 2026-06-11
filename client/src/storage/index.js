// Storage backend selector.
//
// At boot, probe the API. If reachable → use the network-backed store (the
// existing api.js). If not → fall back to the IndexedDB local store. The
// selected backend is exposed as `storage` and consumed by api.js (which is
// kept as a re-export shim so existing modules don't need to change).
//
// Detection details:
//   - We hit GET /api/health with a 1.5 s timeout and a same-origin URL. If
//     the page is opened from a static deployment with no API path, the fetch
//     will fail (CORS/404/network) and we fall through to local.
//   - The probe runs lazily on the *first* call and the result is cached for
//     the rest of the session.

import { remoteStore } from './remote-store.js';
import { localStore }  from './local-store.js';

const PROBE_PATH = '/api/health';
const PROBE_TIMEOUT_MS = 1500;

let cached = null; // { backend: 'remote' | 'local', store: ... }
let pending = null;

async function probeRemote() {
  if (typeof fetch !== 'function') return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(PROBE_PATH, { method: 'GET', signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function pickBackend() {
  if (cached) return cached;
  if (pending) return pending;
  pending = (async () => {
    const remote = await probeRemote();
    cached = remote
      ? { backend: 'remote', store: remoteStore }
      : { backend: 'local',  store: localStore  };
    return cached;
  })();
  return pending;
}

// Same shape as api.js. Each method delegates to whichever backend is active.
function bind(method) {
  return async (...args) => {
    const { store } = await pickBackend();
    return store[method](...args);
  };
}

export const storage = {
  listBills:           bind('listBills'),
  createBill:          bind('createBill'),
  updateBill:          bind('updateBill'),
  deleteBill:          bind('deleteBill'),
  toggleBillPayment:   bind('toggleBillPayment'),

  listCredits:                bind('listCredits'),
  createCredit:               bind('createCredit'),
  updateCredit:               bind('updateCredit'),
  deleteCredit:               bind('deleteCredit'),
  toggleCreditPayment:        bind('toggleCreditPayment'),
  updateCreditPaymentAmount:  bind('updateCreditPaymentAmount'),

  getSettings:    bind('getSettings'),
  updateSettings: bind('updateSettings'),
  exportData:     bind('exportData'),
  importData:     bind('importData'),
  resetData:      bind('resetData')
};

// For UI hints. Resolves to 'remote' or 'local' once the probe runs. Use it
// to show a "running offline" banner.
export async function getBackendName() {
  const { backend } = await pickBackend();
  return backend;
}
