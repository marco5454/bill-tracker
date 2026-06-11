import { getState } from '../state.js';
import { escapeHtml, formatCurrency, formatDate, todayLocal } from '../format.js';
import { billStatus, cycleDueDate, isPaidThisCycle, monthlyEquivalent } from '../cycle.js';
import { computeTotals, computeProgress } from '../credit-math.js';

export function renderDashboard(view) {
  const { bills, credits, settings } = getState();
  const today = todayLocal();
  const currency = settings.currency || '\u20b1';

  // ---- Bills aggregates ----
  let totalMonthly = 0;
  let unpaidThisCycle = 0;
  let overdueCount = 0;
  let dueSoonCount = 0;
  const upcoming = [];
  for (const b of bills) {
    totalMonthly += monthlyEquivalent(b);
    const status = billStatus(b, today);
    if (!isPaidThisCycle(b, today)) unpaidThisCycle += b.amount;
    if (status === 'overdue')  overdueCount++;
    if (status === 'due-soon') dueSoonCount++;
    if (status !== 'paid') {
      const due = cycleDueDate(b, today);
      const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
      if (days >= -7 && days <= 14) upcoming.push({ bill: b, due, days, status });
    }
  }
  upcoming.sort((a, b) => a.due - b.due);

  // ---- Credits aggregates ----
  let activeLoans = 0;
  let totalOutstanding = 0;
  let creditMonthly = 0;
  for (const c of credits) {
    const { monthly, total } = computeTotals(c);
    const prog = computeProgress(c, today);
    if (prog.monthsRemaining > 0) {
      activeLoans++;
      creditMonthly += monthly;
    }
    totalOutstanding += Math.max(0, total - prog.totalPaid);
  }

  view.innerHTML = `
    <div class="section-header">
      <h2>Dashboard</h2>
      <div class="muted tiny">${escapeHtml(formatDate(today))}</div>
    </div>

    <div class="stat-grid">
      <div class="stat">
        <div class="stat-label">Monthly Outflow</div>
        <div class="stat-value">${escapeHtml(formatCurrency(totalMonthly + creditMonthly, currency))}</div>
        <div class="stat-sub">Bills + Loan installments</div>
      </div>
      <div class="stat">
        <div class="stat-label">Unpaid Bills (this cycle)</div>
        <div class="stat-value">${escapeHtml(formatCurrency(unpaidThisCycle, currency))}</div>
        <div class="stat-sub">${overdueCount} overdue \u00b7 ${dueSoonCount} due soon</div>
      </div>
      <div class="stat">
        <div class="stat-label">Active Loans</div>
        <div class="stat-value">${activeLoans}</div>
        <div class="stat-sub">${credits.length} total tracked</div>
      </div>
      <div class="stat">
        <div class="stat-label">Credit Outstanding</div>
        <div class="stat-value">${escapeHtml(formatCurrency(totalOutstanding, currency))}</div>
        <div class="stat-sub">Across all loans</div>
      </div>
    </div>

    <div class="section-header section-header-tight">
      <h2>Upcoming &amp; Overdue Bills</h2>
    </div>
    ${upcoming.length === 0 ? `
      <div class="empty">
        <p>No bills due in the next 14 days.</p>
      </div>
    ` : `
      <div class="upcoming-list">
        ${upcoming.map(u => renderUpcomingRow(u, currency)).join('')}
      </div>
    `}
  `;
}

function renderUpcomingRow({ bill, due, days, status }, currency) {
  const badgeClass = status === 'overdue' ? 'badge-overdue'
                   : status === 'due-soon' ? 'badge-due-soon'
                   : 'badge-info';
  const badgeText = status === 'overdue' ? 'Overdue'
                  : status === 'due-soon' ? 'Due soon'
                  : 'Upcoming';
  let when;
  if (days === 0)      when = 'Due today';
  else if (days < 0)   when = `${Math.abs(days)}d overdue`;
  else if (days === 1) when = 'Due tomorrow';
  else                 when = `Due in ${days}d`;

  return `
    <div class="upcoming-row">
      <div>
        <div class="name">${escapeHtml(bill.name)}</div>
        <div class="when">${escapeHtml(formatDate(due))} \u00b7 ${escapeHtml(when)}</div>
      </div>
      <div class="row-center-gap">
        <span class="amount amount-md">${escapeHtml(formatCurrency(bill.amount, currency))}</span>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
    </div>
  `;
}
