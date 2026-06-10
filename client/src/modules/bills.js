import { api, ApiError } from '../api.js';
import { getState, refreshBills } from '../state.js';
import {
  escapeHtml, formatCurrency, formatDate, monthShort, monthLong,
  csvCell, downloadFile, todayLocal
} from '../format.js';
import {
  cycleDueDate, cycleKey, cycleLabel, billStatus, isPaidThisCycle, nextCycleDueDate
} from '../cycle.js';
import { openModal, closeModal } from '../ui/modal.js';
import { confirm } from '../ui/confirm.js';
import { toastSuccess, toastError } from '../ui/toast.js';

const CATEGORIES = ['Utilities', 'Subscription', 'Rent', 'Insurance', 'Other'];

let searchQuery = '';

export function renderBills(view) {
  const { bills, settings } = getState();
  const currency = settings.currency || '\u20b1';
  const today = todayLocal();

  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? bills.filter(b =>
        b.name.toLowerCase().includes(q) ||
        (b.category || '').toLowerCase().includes(q) ||
        (b.notes || '').toLowerCase().includes(q))
    : bills;

  view.innerHTML = `
    <div class="section-header">
      <h2>Bills</h2>
      <div class="header-actions">
        <input type="search" class="search" id="bill-search" placeholder="Search bills..." value="${escapeHtml(searchQuery)}" aria-label="Search bills" />
        <button class="btn" id="bill-export" type="button">Export CSV</button>
        <button class="btn btn-primary" id="bill-add" type="button">+ Add Bill</button>
      </div>
    </div>

    ${bills.length === 0 ? `
      <div class="empty">
        <p>No bills yet.</p>
        <p class="tiny">Click <strong>+ Add Bill</strong> to track your first recurring expense.</p>
      </div>
    ` : filtered.length === 0 ? `
      <div class="empty"><p>No bills match "${escapeHtml(searchQuery)}".</p></div>
    ` : `
      <div class="grid-cards">
        ${filtered.map(b => renderBillCard(b, today, currency)).join('')}
      </div>
    `}
  `;

  view.querySelector('#bill-add').addEventListener('click', () => openBillForm());
  view.querySelector('#bill-export').addEventListener('click', () => exportBillsCsv());
  const searchEl = view.querySelector('#bill-search');
  searchEl.addEventListener('input', e => {
    searchQuery = e.target.value;
    renderBills(view);
    view.querySelector('#bill-search').focus();
  });

  view.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', onCardAction);
  });
}

function renderBillCard(bill, today, currency) {
  const status = billStatus(bill, today);
  const due = cycleDueDate(bill, today);
  const cycle = cycleLabel(bill, today);
  const paid = isPaidThisCycle(bill, today);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);

  const badge = status === 'paid'     ? '<span class="badge badge-paid">Paid</span>'
              : status === 'overdue'  ? '<span class="badge badge-overdue">Overdue</span>'
              : status === 'due-soon' ? '<span class="badge badge-due-soon">Due Soon</span>'
              : '<span class="badge badge-info">Upcoming</span>';

  let dueLabel;
  if (paid)             dueLabel = `Paid for ${cycle}`;
  else if (days === 0)  dueLabel = 'Due today';
  else if (days < 0)    dueLabel = `${Math.abs(days)}d overdue`;
  else if (days === 1)  dueLabel = 'Due tomorrow';
  else                  dueLabel = `Due in ${days}d \u00b7 ${formatDate(due)}`;

  const recurrenceLabel = bill.recurrence === 'Annually'
    ? `Annually (${monthLong((bill.dueMonth || 1) - 1)})`
    : bill.recurrence === 'Quarterly'
    ? `Quarterly (anchor ${monthShort((bill.anchorMonth || 1) - 1)})`
    : 'Monthly';

  return `
    <div class="card status-${status}">
      <div class="card-head">
        <div>
          <h3 class="card-title">${escapeHtml(bill.name)}</h3>
          <div class="card-sub">${escapeHtml(bill.category || 'Other')} \u00b7 ${escapeHtml(recurrenceLabel)}</div>
        </div>
        <div class="card-actions">
          <button class="btn btn-ghost btn-icon" data-action="edit" data-id="${escapeHtml(bill.id)}" aria-label="Edit ${escapeHtml(bill.name)}" title="Edit">\u270f\ufe0f</button>
          <button class="btn btn-ghost btn-icon" data-action="delete" data-id="${escapeHtml(bill.id)}" aria-label="Delete ${escapeHtml(bill.name)}" title="Delete">\u{1F5D1}</button>
        </div>
      </div>

      <div class="amount">${escapeHtml(formatCurrency(bill.amount, currency))}</div>

      <div class="meta-row">
        <div><strong>${escapeHtml(cycle)}</strong></div>
        <div>${escapeHtml(dueLabel)}</div>
        ${badge}
      </div>

      <div style="display:flex; gap:8px;">
        <button class="btn ${paid ? 'btn-success' : ''} btn-sm" data-action="toggle-paid" data-id="${escapeHtml(bill.id)}" type="button" aria-pressed="${paid}">
          ${paid ? '\u2713 Paid' : 'Mark as paid'}
        </button>
      </div>

      ${bill.notes ? `<div class="notes">${escapeHtml(bill.notes)}</div>` : ''}
    </div>
  `;
}

async function onCardAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const bill = getState().bills.find(b => b.id === id);
  if (!bill) return;

  try {
    if (action === 'edit') {
      openBillForm(bill);
    } else if (action === 'delete') {
      const ok = await confirm({
        title: 'Delete bill?',
        message: `Delete "${bill.name}" and all its payment history? This cannot be undone.`,
        confirmText: 'Delete',
        danger: true
      });
      if (!ok) return;
      await api.deleteBill(id);
      await refreshBills();
      toastSuccess('Bill deleted');
    } else if (action === 'toggle-paid') {
      const key = cycleKey(bill, todayLocal());
      await api.toggleBillPayment(id, key);
      await refreshBills();
    }
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : 'Action failed');
  }
}

function openBillForm(existing) {
  const isEdit = Boolean(existing);
  const today = todayLocal();
  const initial = existing || {
    name: '', amount: '', dueDay: today.getDate(),
    recurrence: 'Monthly', category: 'Utilities',
    dueMonth: today.getMonth() + 1, anchorMonth: 1, notes: ''
  };

  const form = document.createElement('form');
  form.id = 'bill-form';
  form.noValidate = true;
  form.innerHTML = `
    <div class="form-grid">
      <div class="field full">
        <label for="f-name">Name</label>
        <input id="f-name" name="name" type="text" required maxlength="120" value="${escapeHtml(initial.name)}" />
      </div>
      <div class="field">
        <label for="f-amount">Amount</label>
        <input id="f-amount" name="amount" type="number" step="0.01" min="0" required value="${escapeHtml(initial.amount)}" />
      </div>
      <div class="field">
        <label for="f-dueDay">Due day of month</label>
        <input id="f-dueDay" name="dueDay" type="number" min="1" max="31" required value="${escapeHtml(initial.dueDay)}" />
      </div>
      <div class="field">
        <label for="f-recurrence">Recurrence</label>
        <select id="f-recurrence" name="recurrence">
          ${['Monthly','Quarterly','Annually'].map(r =>
            `<option value="${r}" ${initial.recurrence === r ? 'selected' : ''}>${r}</option>`
          ).join('')}
        </select>
      </div>
      <div class="field">
        <label for="f-category">Category</label>
        <select id="f-category" name="category">
          ${CATEGORIES.map(c =>
            `<option value="${c}" ${initial.category === c ? 'selected' : ''}>${c}</option>`
          ).join('')}
        </select>
      </div>
      <div class="field" id="f-dueMonth-wrap" hidden>
        <label for="f-dueMonth">Due month</label>
        <select id="f-dueMonth" name="dueMonth">
          ${Array.from({ length: 12 }, (_, i) =>
            `<option value="${i + 1}" ${(initial.dueMonth || 1) === i + 1 ? 'selected' : ''}>${monthLong(i)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="field" id="f-anchorMonth-wrap" hidden>
        <label for="f-anchorMonth">Anchor month (within quarter)</label>
        <select id="f-anchorMonth" name="anchorMonth">
          <option value="1" ${(initial.anchorMonth || 1) === 1 ? 'selected' : ''}>Month 1 (Jan/Apr/Jul/Oct)</option>
          <option value="2" ${(initial.anchorMonth || 1) === 2 ? 'selected' : ''}>Month 2 (Feb/May/Aug/Nov)</option>
          <option value="3" ${(initial.anchorMonth || 1) === 3 ? 'selected' : ''}>Month 3 (Mar/Jun/Sep/Dec)</option>
        </select>
        <div class="field-hint">Defines which month of each quarter this bill is due.</div>
      </div>
      <div class="field full">
        <label for="f-notes">Notes</label>
        <textarea id="f-notes" name="notes" maxlength="1000">${escapeHtml(initial.notes)}</textarea>
      </div>
    </div>
  `;

  function syncRecurrence() {
    const r = form.querySelector('#f-recurrence').value;
    form.querySelector('#f-dueMonth-wrap').hidden    = r !== 'Annually';
    form.querySelector('#f-anchorMonth-wrap').hidden = r !== 'Quarterly';
  }
  form.querySelector('#f-recurrence').addEventListener('change', syncRecurrence);

  const footer = document.createDocumentFragment();
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => closeModal());
  const save = document.createElement('button');
  save.type = 'submit'; save.className = 'btn btn-primary'; save.textContent = isEdit ? 'Save' : 'Create';
  save.setAttribute('form', 'bill-form');
  footer.appendChild(cancel); footer.appendChild(save);

  openModal({
    title: isEdit ? 'Edit Bill' : 'Add Bill',
    body: form,
    footer
  });

  // Sync visibility once visible
  syncRecurrence();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const data = collectBillForm(form);
    try {
      if (isEdit) {
        await api.updateBill(existing.id, data);
        toastSuccess('Bill updated');
      } else {
        await api.createBill(data);
        toastSuccess('Bill added');
      }
      await refreshBills();
      closeModal();
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Save failed');
    }
  });
}

function collectBillForm(form) {
  const fd = new FormData(form);
  const recurrence = String(fd.get('recurrence'));
  return {
    name:        String(fd.get('name') || '').trim(),
    amount:      Number(fd.get('amount')),
    dueDay:      Number(fd.get('dueDay')),
    recurrence,
    category:    String(fd.get('category') || 'Other'),
    dueMonth:    recurrence === 'Annually'  ? Number(fd.get('dueMonth'))    : null,
    anchorMonth: recurrence === 'Quarterly' ? Number(fd.get('anchorMonth')) : null,
    notes:       String(fd.get('notes') || '').trim()
  };
}

function exportBillsCsv() {
  const { bills, settings } = getState();
  const today = todayLocal();
  const currency = settings.currency || '';
  const header = ['Name','Amount','Currency','Due Day','Recurrence','Due Month','Anchor Month','Category','Cycle','Cycle Due Date','Status','Next Due Date','Notes'];
  const rows = [header.map(csvCell).join(',')];
  for (const b of bills) {
    const status = billStatus(b, today);
    rows.push([
      b.name,
      b.amount,
      currency,
      b.dueDay,
      b.recurrence,
      b.dueMonth ?? '',
      b.anchorMonth ?? '',
      b.category,
      cycleLabel(b, today),
      cycleDueDate(b, today).toISOString().slice(0, 10),
      status,
      nextCycleDueDate(b, today).toISOString().slice(0, 10),
      b.notes
    ].map(csvCell).join(','));
  }
  downloadFile('bills.csv', rows.join('\n'), 'text/csv;charset=utf-8');
  toastSuccess('Bills exported');
}
