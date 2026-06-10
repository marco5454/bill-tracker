import { loadAll, subscribe } from './state.js';
import { renderDashboard } from './modules/dashboard.js';
import { renderBills }     from './modules/bills.js';
import { renderCredits }   from './modules/credits.js';
import { renderSettings }  from './modules/settings.js';
import { toastError } from './ui/toast.js';

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
  } catch (err) {
    console.error(err);
    view.innerHTML = `
      <div class="empty">
        <p><strong>Could not reach the API.</strong></p>
        <p class="tiny">Make sure the backend is running on <code>http://localhost:3000</code> (try <code>npm run dev</code>).</p>
      </div>
    `;
    toastError('API unavailable');
  }
})();
