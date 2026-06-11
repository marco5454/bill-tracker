// Compatibility shim. The original `api.js` was the network-only client; this
// shim delegates to whichever backend `storage/index.js` selected (either the
// real network API or the IndexedDB local store). State.js and modules import
// `api` and `ApiError` from here unchanged.
//
// The remote ApiError and the local-store LocalStoreError both expose
// `{ status, message, details }` so a single error class is exposed downstream.

import { storage, getBackendName } from './storage/index.js';
import { ApiError as NetworkApiError } from './api-network.js';
import { LocalStoreError } from './storage/local-store.js';

// Unified error class. We re-export both names so `instanceof ApiError`
// remains true for either backend's errors. Module code only ever uses
// `instanceof ApiError`, so we make ApiError the broader of the two.
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Make instanceof work for the legacy NetworkApiError thrown deep inside
// api-network.js by re-routing through this class. We can't change Error
// prototypes after the fact in a clean way, so storage methods catch and
// rethrow as ApiError.
function wrap(method) {
  return async (...args) => {
    try {
      return await storage[method](...args);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof NetworkApiError || err instanceof LocalStoreError) {
        throw new ApiError(err.status, err.message, err.details);
      }
      throw err;
    }
  };
}

export const api = {
  listBills:           wrap('listBills'),
  createBill:          wrap('createBill'),
  updateBill:          wrap('updateBill'),
  deleteBill:          wrap('deleteBill'),
  toggleBillPayment:   wrap('toggleBillPayment'),

  listCredits:                wrap('listCredits'),
  createCredit:               wrap('createCredit'),
  updateCredit:               wrap('updateCredit'),
  deleteCredit:               wrap('deleteCredit'),
  toggleCreditPayment:        wrap('toggleCreditPayment'),
  updateCreditPaymentAmount:  wrap('updateCreditPaymentAmount'),

  getSettings:     wrap('getSettings'),
  updateSettings:  wrap('updateSettings'),
  exportData:      wrap('exportData'),
  importData:      wrap('importData'),
  resetData:       wrap('resetData')
};

export { getBackendName };
