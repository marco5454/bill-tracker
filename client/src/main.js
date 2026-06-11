// Self-hosted Inter (latin subset). Vite bundles these into dist/assets so the
// app makes no third-party requests at runtime.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';

import { loadAll, subscribe } from './state.js';
import { renderDashboard } from './modules/dashboard.js';
import { renderBills }     from './modules/bills.js';
import { renderCredits }   from './modules/credits.js';
import { renderSettings }  from './modules/settings.js';
import { toastError, toastInfo } from './ui/toast.js';
import { getBackendName } from './api.js';

const TABS = {
  dashboard: renderDashboard,
  bills:     renderBills,
  credits:   renderCredits,
  settings:  renderSettings
};

const view = document.getElementById('view');
let activeTab = 'dashboard';

function renderActive() {
  const fn = TABS[activeTab] || renderDashboard;
  try {
    fn(view);
  } catch (err) {
    console.error(err);
    view.innerHTML = '<div class="empty"><p>Something went wrong while rendering this view.</p></div>';
  }
}

function setActiveTab(name) {
  if (!TABS[name]) return;
  activeTab = name;
  for (const btn of document.querySelectorAll('.tab')) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
  }
  renderActive();
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
});

subscribe(() => renderActive());

(async () => {
  view.innerHTML = '<div class="empty"><p>Loading...</p></div>';
  try {
    await loadAll();
    // Show a one-time hint if we ended up using the local IndexedDB store
    // (i.e. the API probe failed). Helps users understand why their data
    // doesn't sync between devices.
    const backend = await getBackendName();
    if (backend === 'local') {
      showLocalModeBadge();
    }
  } catch (err) {
    console.error(err);
    view.innerHTML = `
      <div class="empty">
        <p><strong>Could not load data.</strong></p>
        <p class="tiny">Try reloading the page. If you opened this app from a server that's offline, your existing local data should still load.</p>
      </div>
    `;
    toastError(err && err.message ? err.message : 'Failed to load');
  }
})();

// One-time visual cue for local-only mode. We surface it in the topbar as a
// small badge instead of nagging the user with a toast on every reload.
function showLocalModeBadge() {
  const brand = document.querySelector('.brand');
  if (!brand || brand.querySelector('.local-badge')) return;
  const badge = document.createElement('span');
  badge.className = 'local-badge';
  badge.title = 'Data is stored on this device. Use Settings → Export JSON to back up or move to another device.';
  badge.textContent = 'Local';
  brand.appendChild(badge);
}

// Service worker registration. SW is shipped only in production builds (the
// dev server doesn't generate a stable file). Failures are non-fatal — the
// app degrades gracefully to a regular SPA.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(err => {
      console.warn('Service worker registration failed:', err);
    });
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      // A new SW took over (e.g. after a deploy). Soft-reload so the user
      // sees the freshly cached assets without a forced refresh.
      window.location.reload();
    });
  });
}
