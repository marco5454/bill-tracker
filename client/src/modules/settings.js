import { api, ApiError } from '../api.js';
import { getState, refreshSettings, loadAll } from '../state.js';
import { escapeHtml, downloadFile } from '../format.js';
import { confirm } from '../ui/confirm.js';
import { toastSuccess, toastError, toastInfo } from '../ui/toast.js';

export function renderSettings(view) {
  const { settings } = getState();
  view.innerHTML = `
    <div class="section-header">
      <h2>Settings</h2>
    </div>

    <div class="card card-narrow">
      <h3 class="card-title">Currency</h3>
      <div class="card-sub">Symbol prefixed to amounts (e.g. \u20b1, $, \u20ac, \u00a3, \u00a5).</div>
      <div class="field">
        <label for="set-currency">Currency symbol</label>
        <input id="set-currency" type="text" maxlength="8" value="${escapeHtml(settings.currency || '\u20b1')}" />
      </div>
      <div>
        <button class="btn btn-primary" id="set-save" type="button">Save</button>
      </div>
    </div>

    <div class="card card-narrow-spaced">
      <h3 class="card-title">Backup &amp; Restore</h3>
      <div class="card-sub">Export all bills, credits, payments &amp; settings as a JSON file. Importing replaces all current data.</div>
      <div class="row-flex">
        <button class="btn" id="set-export" type="button">Export JSON</button>
        <label class="btn btn-file">
          Import JSON
          <input id="set-import" type="file" accept="application/json,.json" hidden />
        </label>
      </div>
    </div>

    <div class="danger-zone card-narrow">
      <h3>Danger zone</h3>
      <p class="muted tiny danger-help">Permanently deletes every bill, credit, and payment record. The action cannot be undone.</p>
      <button class="btn btn-danger" id="set-reset" type="button">Reset all data</button>
    </div>
  `;

  view.querySelector('#set-save').addEventListener('click', async () => {
    const value = view.querySelector('#set-currency').value.trim() || '\u20b1';
    try {
      await api.updateSettings({ currency: value });
      await refreshSettings();
      toastSuccess('Settings saved');
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Failed to save settings');
    }
  });

  view.querySelector('#set-export').addEventListener('click', async () => {
    try {
      const snap = await api.exportData();
      downloadFile(`billtracker-export-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(snap, null, 2), 'application/json');
      toastSuccess('Backup downloaded');
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Export failed');
    }
  });

  view.querySelector('#set-import').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      toastError('File is not valid JSON');
      return;
    }
    const ok = await confirm({
      title: 'Replace all data?',
      message: 'Importing will delete all current bills and credits and replace them with the contents of this file.',
      confirmText: 'Replace',
      danger: true
    });
    if (!ok) return;
    try {
      await api.importData(parsed);
      await loadAll();
      toastSuccess('Import complete');
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Import failed');
    }
  });

  view.querySelector('#set-reset').addEventListener('click', async () => {
    const ok = await confirm({
      title: 'Reset everything?',
      message: 'This deletes all bills, credits, and payment history. Currency setting is preserved.',
      confirmText: 'Reset all',
      danger: true
    });
    if (!ok) return;
    try {
      await api.resetData();
      await loadAll();
      toastInfo('All data cleared');
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Reset failed');
    }
  });
}
