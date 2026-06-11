// Network-backed store: thin re-export of the existing api.js methods so
// storage/index.js can treat both stores uniformly.

import { api, ApiError } from '../api-network.js';

export { ApiError };

export const remoteStore = {
  listBills:           ()                    => api.listBills(),
  createBill:          (data)                => api.createBill(data),
  updateBill:          (id, data, version)   => api.updateBill(id, data, version),
  deleteBill:          (id, version)         => api.deleteBill(id, version),
  toggleBillPayment:   (id, key, version)    => api.toggleBillPayment(id, key, version),

  listCredits:                ()                                 => api.listCredits(),
  createCredit:               (data)                             => api.createCredit(data),
  updateCredit:               (id, data, version)                => api.updateCredit(id, data, version),
  deleteCredit:               (id, version)                      => api.deleteCredit(id, version),
  toggleCreditPayment:        (id, ym, amount, version)          => api.toggleCreditPayment(id, ym, amount, version),
  updateCreditPaymentAmount:  (id, ym, amount, version)          => api.updateCreditPaymentAmount(id, ym, amount, version),

  getSettings:     ()       => api.getSettings(),
  updateSettings:  (data)   => api.updateSettings(data),
  exportData:      ()       => api.exportData(),
  importData:      (snap)   => api.importData(snap),
  resetData:       ()       => api.resetData()
};
