import { api, ApiError } from '../api.js';
import { getState, refreshCredits } from '../state.js';
import {
  escapeHtml, formatCurrency, formatDate, ymKey, ymLabel,
  csvCell, downloadFile, todayLocal
} from '../format.js';
import { computeTotals, computeProgress, monthList, deriveEndDate } from '../credit-math.js';
import { openModal, closeModal } from '../ui/modal.js';
import { confirm } from '../ui/confirm.js';
import { toastSuccess, toastError } from '../ui/toast.js';

let searchQuery = '';
const expandedLogs = new Set(); // credit ids whose payment log is open

export function renderCredits(view) {
  const { credits, settings } = getState();
  const currency = settings.currency || '\u20b1';
  const today = todayLocal();

  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? credits.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.lender || '').toLowerCase().includes(q) ||
        (c.notes || '').toLowerCase().includes(q))
    : credits;

  view.innerHTML = `
    <div class="section-header">
      <h2>Credits</h2>
      <div class="header-actions">
        <input type="search" class="search" id="credit-search" placeholder="Search credits..." value="${escapeHtml(searchQuery)}" aria-label="Search credits" />
        <button class="btn" id="credit-export" type="button">Export CSV</button>
        <button class="btn btn-primary" id="credit-add" type="button">+ Add Credit</button>
      </div>
    </div>

    ${credits.length === 0 ? `
      <div class="empty">
        <p>No credit lines yet.</p>
        <p class="tiny">Click <strong>+ Add Credit</strong> to track a loan.</p>
      </div>
    ` : filtered.length === 0 ? `
      <div class="empty"><p>No credits match "${escapeHtml(searchQuery)}".</p></div>
    ` : `
      <div class="grid-cards">
        ${filtered.map(c => renderCreditCard(c, today, currency)).join('')}
      </div>
    `}
  `;

  view.querySelector('#credit-add').addEventListener('click', () => openCreditForm());
  view.querySelector('#credit-export').addEventListener('click', () => exportCreditsCsv());
  const searchEl = view.querySelector('#credit-search');
  searchEl.addEventListener('input', e => {
    searchQuery = e.target.value;
    renderCredits(view);
    view.querySelector('#credit-search').focus();
  });

  view.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', onCardAction);
  });

  // Set dynamic progress widths via CSS custom property. Done in JS rather
  // than via an inline `style="width:N%"` attribute so the page CSP can
  // disallow `'unsafe-inline'` in style-src. Setting an element's style
  // property from a script is allowed under `style-src 'self'`.
  view.querySelectorAll('.progress-fill[data-progress]').forEach((el) => {
    const pct = Number(el.dataset.progress);
    const clamped = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    el.style.setProperty('--progress-width', `${clamped}%`);
  });
}

function renderCreditCard(credit, today, currency) {
  const totals = computeTotals(credit);
  const prog = computeProgress(credit, today);
  const isExpanded = expandedLogs.has(credit.id);
  const remaining = Math.max(0, totals.total - prog.totalPaid);
  const isComplete = prog.paidCount >= prog.totalMonths;

  return `
    <div class="card">
      <div class="card-head">
        <div>
          <h3 class="card-title">${escapeHtml(credit.name)}</h3>
          <div class="card-sub">
            ${escapeHtml(credit.lender || 'Unknown lender')} \u00b7
            ${credit.interestType === 'addon' ? 'Monthly add-on' : 'Simple interest'} \u00b7
            ${escapeHtml(String(credit.ratePct))}%
          </div>
        </div>
        <div class="card-actions">
          <button class="btn btn-ghost btn-icon" data-action="edit" data-id="${escapeHtml(credit.id)}" aria-label="Edit ${escapeHtml(credit.name)}" title="Edit">\u270f\ufe0f</button>
          <button class="btn btn-ghost btn-icon" data-action="delete" data-id="${escapeHtml(credit.id)}" aria-label="Delete ${escapeHtml(credit.name)}" title="Delete">\u{1F5D1}</button>
        </div>
      </div>

      <div class="meta-row">
        <div><strong>Principal</strong> ${escapeHtml(formatCurrency(credit.principal, currency))}</div>
        <div><strong>Total</strong> ${escapeHtml(formatCurrency(totals.total, currency))}</div>
        <div><strong>Monthly</strong> ${escapeHtml(formatCurrency(totals.monthly, currency))}</div>
      </div>
      <div class="meta-row">
        <div><strong>Interest</strong> ${escapeHtml(formatCurrency(totals.interest, currency))}</div>
        <div><strong>Term</strong> ${credit.termMonths} mo</div>
        <div><strong>Period</strong> ${escapeHtml(formatDate(credit.startDate))} \u2013 ${escapeHtml(formatDate(credit.endDate))}</div>
      </div>

      <div>
        <div class="meta-row meta-row-split">
          <div><strong>${prog.paidCount}/${prog.totalMonths} paid</strong> (${prog.progress.toFixed(0)}%)</div>
          <div class="muted tiny">${prog.monthsRemaining} mo left \u00b7 ${prog.timeProgress.toFixed(0)}% time</div>
        </div>
        <div class="progress progress-spaced">
          <div class="progress-fill ${isComplete ? 'complete' : ''}" data-progress="${prog.progress}"></div>
        </div>
        <div class="meta-row meta-row-spaced">
          <div><strong>Paid</strong> ${escapeHtml(formatCurrency(prog.totalPaid, currency))}</div>
          <div><strong>Remaining</strong> ${escapeHtml(formatCurrency(remaining, currency))}</div>
        </div>
      </div>

      <div>
        <button class="btn btn-sm" data-action="toggle-log" data-id="${escapeHtml(credit.id)}" type="button" aria-expanded="${isExpanded}">
          ${isExpanded ? 'Hide' : 'Show'} payment log
        </button>
      </div>

      ${isExpanded ? renderPaymentLog(credit, prog, totals.monthly, currency) : ''}

      ${credit.notes ? `<div class="notes">${escapeHtml(credit.notes)}</div>` : ''}
    </div>
  `;
}

function renderPaymentLog(credit, prog, monthlyAmount, currency) {
  const months = monthList(credit);
  const cells = months.map(ym => {
    const p = prog.paymentMap.get(ym);
    const paid = !!p;
    const customAmount = paid && p.amount != null && p.amount !== monthlyAmount;
    const amt = paid ? (p.amount != null ? p.amount : monthlyAmount) : monthlyAmount;
    return `
      <button type="button" class="log-cell ${paid ? 'paid' : ''}${customAmount ? ' custom-amount' : ''}"
              data-action="open-payment" data-id="${escapeHtml(credit.id)}" data-ym="${escapeHtml(ym)}"
              aria-pressed="${paid}"
              title="${paid ? 'Click to edit or unmark' : 'Click to mark paid'} \u00b7 ${ymLabel(ym)}">
        <span class="ym">${escapeHtml(ymLabel(ym))}</span>
        <span class="amt">${escapeHtml(formatCurrency(amt, currency))}</span>
        ${customAmount ? '<span class="custom-marker" aria-label="Custom amount" title="Custom amount">*</span>' : ''}
      </button>
    `;
  }).join('');
  return `
    <div class="payment-log">
      <div class="muted tiny">Click a month to record or edit a payment. Months marked with <strong>*</strong> were paid with a custom amount.</div>
      <div class="log-grid">${cells}</div>
    </div>
  `;
}

async function onCardAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const credit = getState().credits.find(c => c.id === id);
  if (!credit && action !== 'toggle-log') return;

  try {
    if (action === 'edit') {
      openCreditForm(credit);
    } else if (action === 'delete') {
      const ok = await confirm({
        title: 'Delete credit?',
        message: `Delete "${credit.name}" and all its payment history? This cannot be undone.`,
        confirmText: 'Delete',
        danger: true
      });
      if (!ok) return;
      await api.deleteCredit(id, credit.version);
      expandedLogs.delete(id);
      await refreshCredits();
      toastSuccess('Credit deleted');
    } else if (action === 'toggle-log') {
      if (expandedLogs.has(id)) expandedLogs.delete(id);
      else expandedLogs.add(id);
      const view = document.getElementById('view');
      renderCredits(view);
    } else if (action === 'open-payment') {
      const ym = btn.dataset.ym;
      openPaymentModal(credit, ym);
    }
  } catch (err) {
    if (err instanceof ApiError && (err.status === 412 || err.status === 428)) {
      try { await refreshCredits(); } catch {}
    }
    toastError(err instanceof ApiError ? err.message : 'Action failed');
  }
}

function openCreditForm(existing) {
  const isEdit = Boolean(existing);
  const today = todayLocal();
  const initial = existing || {
    name: '', lender: '', principal: '', ratePct: '',
    interestType: 'simple', termMonths: 12,
    startDate: ymKey(today) + '-01', endDate: '',
    notes: ''
  };

  const form = document.createElement('form');
  form.id = 'credit-form';
  form.noValidate = true;
  form.innerHTML = `
    <div class="form-grid">
      <div class="field">
        <label for="cf-name">Name</label>
        <input id="cf-name" name="name" type="text" required maxlength="120" value="${escapeHtml(initial.name)}" />
      </div>
      <div class="field">
        <label for="cf-lender">Lender</label>
        <input id="cf-lender" name="lender" type="text" maxlength="120" value="${escapeHtml(initial.lender || '')}" />
      </div>
      <div class="field">
        <label for="cf-principal">Principal</label>
        <input id="cf-principal" name="principal" type="number" step="0.01" min="0" required value="${escapeHtml(initial.principal)}" />
      </div>
      <div class="field">
        <label for="cf-ratePct">Interest rate %</label>
        <input id="cf-ratePct" name="ratePct" type="number" step="0.001" min="0" required value="${escapeHtml(initial.ratePct)}" />
      </div>
      <div class="field">
        <label for="cf-interestType">Interest type</label>
        <select id="cf-interestType" name="interestType">
          <option value="simple" ${initial.interestType === 'simple' ? 'selected' : ''}>Simple (annual %)</option>
          <option value="addon"  ${initial.interestType === 'addon'  ? 'selected' : ''}>Monthly add-on (% per month)</option>
        </select>
        <div class="field-hint" id="cf-rate-hint"></div>
      </div>
      <div class="field">
        <label for="cf-termMonths">Term (months)</label>
        <input id="cf-termMonths" name="termMonths" type="number" min="1" max="600" required value="${escapeHtml(initial.termMonths)}" />
      </div>
      <div class="field">
        <label for="cf-startDate">Start date</label>
        <input id="cf-startDate" name="startDate" type="date" required value="${escapeHtml(initial.startDate)}" />
      </div>
      <div class="field">
        <label for="cf-endDate">End date <span class="muted tiny">(auto-derived)</span></label>
        <input id="cf-endDate" name="endDate" type="date" required value="${escapeHtml(initial.endDate)}" />
      </div>
      <div class="field full">
        <label for="cf-notes">Notes</label>
        <textarea id="cf-notes" name="notes" maxlength="1000">${escapeHtml(initial.notes)}</textarea>
      </div>
    </div>
  `;

  function syncEnd() {
    const start = form.querySelector('#cf-startDate').value;
    const term  = Number(form.querySelector('#cf-termMonths').value);
    if (!start || !Number.isFinite(term) || term < 1) return;
    const end = deriveEndDate(start, term);
    if (end) form.querySelector('#cf-endDate').value = end;
  }
  function syncRateHint() {
    const t = form.querySelector('#cf-interestType').value;
    form.querySelector('#cf-rate-hint').textContent = t === 'addon'
      ? 'Rate is interpreted as % per month, e.g. 1.5 = 1.5% / month.'
      : 'Rate is interpreted as % per year (simple interest, not compounded).';
  }
  form.querySelector('#cf-startDate').addEventListener('change', syncEnd);
  form.querySelector('#cf-termMonths').addEventListener('change', syncEnd);
  form.querySelector('#cf-interestType').addEventListener('change', syncRateHint);

  const footer = document.createDocumentFragment();
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => closeModal());
  const save = document.createElement('button');
  save.type = 'submit'; save.className = 'btn btn-primary'; save.textContent = isEdit ? 'Save' : 'Create';
  save.setAttribute('form', 'credit-form');
  footer.appendChild(cancel); footer.appendChild(save);

  openModal({
    title: isEdit ? 'Edit Credit' : 'Add Credit',
    body: form,
    footer
  });

  syncRateHint();
  if (!isEdit && !initial.endDate) syncEnd();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const data = collectCreditForm(form);
    try {
      if (isEdit) {
        await api.updateCredit(existing.id, data, existing.version);
        toastSuccess('Credit updated');
      } else {
        await api.createCredit(data);
        toastSuccess('Credit added');
      }
      await refreshCredits();
      closeModal();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 412 || err.status === 428)) {
        try { await refreshCredits(); } catch {}
      }
      toastError(err instanceof ApiError ? err.message : 'Save failed');
    }
  });
}

function collectCreditForm(form) {
  const fd = new FormData(form);
  return {
    name:         String(fd.get('name') || '').trim(),
    lender:       String(fd.get('lender') || '').trim(),
    principal:    Number(fd.get('principal')),
    ratePct:      Number(fd.get('ratePct')),
    interestType: String(fd.get('interestType')),
    termMonths:   Number(fd.get('termMonths')),
    startDate:    String(fd.get('startDate')),
    endDate:      String(fd.get('endDate')),
    notes:        String(fd.get('notes') || '').trim()
  };
}

// Modal for recording / editing / clearing a single month's payment.
//
// Unpaid month: amount input pre-filled with the scheduled monthly amount.
//   Submit -> toggleCreditPayment(amount). Sending the scheduled amount as a
//   custom-amount keeps semantics simple, but if the user does not edit it we
//   pass null so the server stores "use scheduled" (so future schedule changes
//   don't strand the payment at a stale fixed amount).
//
// Paid month: amount input pre-filled with the recorded amount (or scheduled
//   if it was recorded as null). Submit -> updateCreditPaymentAmount. There is
//   also a "Mark unpaid" action that calls toggleCreditPayment to remove it.
function openPaymentModal(credit, ym) {
  const totals = computeTotals(credit);
  const prog = computeProgress(credit, todayLocal());
  const { settings } = getState();
  const currency = settings.currency || '\u20b1';
  const scheduled = totals.monthly;
  const existing = prog.paymentMap.get(ym);
  const isPaid = !!existing;
  const recordedAmount = isPaid ? (existing.amount != null ? existing.amount : scheduled) : null;
  const initialAmount = isPaid ? recordedAmount : scheduled;

  const form = document.createElement('form');
  form.id = 'payment-form';
  form.noValidate = true;
  form.innerHTML = `
    <div class="form-grid">
      <div class="field full">
        <div class="muted tiny">${escapeHtml(credit.name)} \u00b7 ${escapeHtml(ymLabel(ym))}</div>
      </div>
      <div class="field">
        <label for="pf-amount">Amount paid</label>
        <input id="pf-amount" name="amount" type="number" step="0.01" min="0" required
               value="${escapeHtml(initialAmount.toFixed(2))}" />
        <div class="field-hint">Scheduled: ${escapeHtml(formatCurrency(scheduled, currency))}</div>
      </div>
      <div class="field">
        <label>&nbsp;</label>
        <button type="button" class="btn btn-sm" id="pf-use-scheduled">Use scheduled</button>
      </div>
    </div>
  `;

  form.querySelector('#pf-use-scheduled').addEventListener('click', () => {
    form.querySelector('#pf-amount').value = scheduled.toFixed(2);
    form.querySelector('#pf-amount').focus();
  });

  const footer = document.createDocumentFragment();
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => closeModal());
  footer.appendChild(cancel);

  if (isPaid) {
    const unmark = document.createElement('button');
    unmark.type = 'button';
    unmark.className = 'btn btn-danger';
    unmark.textContent = 'Mark unpaid';
    unmark.addEventListener('click', async () => {
      try {
        // toggleCreditPayment removes the row when one already exists.
        await api.toggleCreditPayment(credit.id, ym, null, credit.version);
        await refreshCredits();
        closeModal();
        toastSuccess('Payment removed');
      } catch (err) {
        if (err instanceof ApiError && (err.status === 412 || err.status === 428)) {
          try { await refreshCredits(); } catch {}
        }
        toastError(err instanceof ApiError ? err.message : 'Action failed');
      }
    });
    footer.appendChild(unmark);
  }

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-primary';
  save.textContent = isPaid ? 'Save amount' : 'Mark paid';
  save.setAttribute('form', 'payment-form');
  footer.appendChild(save);

  openModal({
    title: isPaid ? 'Edit payment' : 'Record payment',
    body: form,
    footer
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const raw = String(form.querySelector('#pf-amount').value).trim();
    const amount = Number(raw);
    if (raw === '' || !Number.isFinite(amount) || amount < 0) {
      toastError('Enter a valid amount');
      return;
    }
    // If the user kept the scheduled amount on a brand-new payment, send null
    // so future term/rate changes flow through. Otherwise persist the exact
    // value the user entered. We compare with a small epsilon to tolerate
    // floating-point noise from toFixed/parse round-trips.
    const isExactlyScheduled = Math.abs(amount - scheduled) < 0.005;
    try {
      if (isPaid) {
        await api.updateCreditPaymentAmount(
          credit.id, ym,
          isExactlyScheduled ? null : amount,
          credit.version
        );
        toastSuccess('Payment updated');
      } else {
        await api.toggleCreditPayment(
          credit.id, ym,
          isExactlyScheduled ? null : amount,
          credit.version
        );
        toastSuccess('Payment recorded');
      }
      await refreshCredits();
      closeModal();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 412 || err.status === 428)) {
        try { await refreshCredits(); } catch {}
      }
      toastError(err instanceof ApiError ? err.message : 'Save failed');
    }
  });
}

function exportCreditsCsv() {
  const { credits, settings } = getState();
  const today = todayLocal();
  const currency = settings.currency || '';
  const header = ['Name','Lender','Principal','Currency','Rate %','Interest Type','Term (months)','Start','End','Total','Monthly','Interest','Paid Count','Total Paid','Remaining','Progress %','Notes'];
  const rows = [header.map(csvCell).join(',')];
  for (const c of credits) {
    const totals = computeTotals(c);
    const prog = computeProgress(c, today);
    rows.push([
      c.name, c.lender, c.principal, currency, c.ratePct, c.interestType,
      c.termMonths, c.startDate, c.endDate,
      totals.total.toFixed(2), totals.monthly.toFixed(2), totals.interest.toFixed(2),
      `${prog.paidCount}/${prog.totalMonths}`,
      prog.totalPaid.toFixed(2),
      Math.max(0, totals.total - prog.totalPaid).toFixed(2),
      prog.progress.toFixed(1),
      c.notes
    ].map(csvCell).join(','));
  }
  downloadFile('credits.csv', rows.join('\n'), 'text/csv;charset=utf-8');
  toastSuccess('Credits exported');
}
