import { getState } from '../state.js';
import { escapeHtml, formatCurrency, formatDate, todayLocal, ymKey, ymLabel } from '../format.js';
import { billStatus, cycleDueDate, isPaidThisCycle, monthlyEquivalent } from '../cycle.js';
import { computeTotals, computeProgress, monthList } from '../credit-math.js';

export function renderDashboard(view) {
  const { bills, credits, settings } = getState();
  const today = todayLocal();
  const currency = settings.currency || '\u20b1';
  const currentYM = ymKey(today);

  // ---- Bills aggregates ----
  let totalMonthly = 0;
  let unpaidThisCycle = 0;
  let overdueCount = 0;
  let dueSoonCount = 0;
  let paidThisCycleCount = 0;
  const upcomingBills = [];
  for (const b of bills) {
    totalMonthly += monthlyEquivalent(b);
    const status = billStatus(b, today);
    const paid = isPaidThisCycle(b, today);
    if (paid) paidThisCycleCount++;
    if (!paid) unpaidThisCycle += b.amount;
    if (status === 'overdue')  overdueCount++;
    if (status === 'due-soon') dueSoonCount++;
    if (status !== 'paid') {
      const due = cycleDueDate(b, today);
      const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
      if (days >= -7 && days <= 14) upcomingBills.push({ bill: b, due, days, status });
    }
  }
  upcomingBills.sort((a, b) => a.due - b.due);

  // ---- Credits aggregates ----
  let activeLoans = 0;
  let completedLoans = 0;
  let totalOutstanding = 0;
  let totalPaidAll = 0;
  let totalPrincipal = 0;
  let totalInterest = 0;
  let creditMonthly = 0;
  let paidThisMonthCount = 0;
  let unpaidThisMonthCount = 0;
  const upcomingInstallments = [];
  const loanRows = [];

  for (const c of credits) {
    const totals = computeTotals(c);
    const prog = computeProgress(c, today);
    const remaining = Math.max(0, totals.total - prog.totalPaid);
    const isActive = prog.monthsRemaining > 0 && prog.paidCount < prog.totalMonths;

    totalPrincipal += Number(c.principal) || 0;
    totalInterest += totals.interest;
    totalOutstanding += remaining;
    totalPaidAll += prog.totalPaid;

    if (isActive) {
      activeLoans++;
      creditMonthly += totals.monthly;
    } else {
      completedLoans++;
    }

    // Paid-this-month status for active loans whose schedule covers current month
    const months = monthList(c);
    const coversThisMonth = months.includes(currentYM);
    if (isActive && coversThisMonth) {
      if (prog.paymentMap.has(currentYM)) paidThisMonthCount++;
      else unpaidThisMonthCount++;
    }

    // Next unpaid scheduled month (>= current month)
    if (isActive) {
      const nextYM = months.find(ym => ym >= currentYM && !prog.paymentMap.has(ym));
      if (nextYM) {
        const [y, m] = nextYM.split('-').map(Number);
        const dueDate = new Date(y, m - 1, 1);
        const daysToMonthStart = Math.round((dueDate.getTime() - today.getTime()) / 86_400_000);
        // include this month (overdue-ish) plus next 30 days
        if (nextYM === currentYM || daysToMonthStart <= 31) {
          upcomingInstallments.push({
            credit: c,
            ym: nextYM,
            amount: totals.monthly,
            isCurrentMonth: nextYM === currentYM,
            daysToMonthStart
          });
        }
      }

      loanRows.push({
        credit: c,
        totals,
        prog,
        remaining
      });
    }
  }
  upcomingInstallments.sort((a, b) => a.ym.localeCompare(b.ym));
  // Sort by closeness to completion: highest progress % first.
  // Tiebreaker: fewer months remaining first, then smaller remaining balance.
  loanRows.sort((a, b) => {
    if (b.prog.progress !== a.prog.progress) return b.prog.progress - a.prog.progress;
    if (a.prog.monthsRemaining !== b.prog.monthsRemaining) return a.prog.monthsRemaining - b.prog.monthsRemaining;
    return a.remaining - b.remaining;
  });

  view.innerHTML = `
    <div class="section-header">
      <h2>Dashboard</h2>
      <div class="muted tiny">${escapeHtml(formatDate(today))}</div>
    </div>

    <div class="dash-summary">
      <div class="stat">
        <div class="stat-label">Total Monthly Outflow</div>
        <div class="stat-value">${escapeHtml(formatCurrency(totalMonthly + creditMonthly, currency))}</div>
        <div class="stat-sub">Bills ${escapeHtml(formatCurrency(totalMonthly, currency))} \u00b7 Loans ${escapeHtml(formatCurrency(creditMonthly, currency))}</div>
      </div>
    </div>

    <div class="section-header section-header-tight">
      <h2>Bills</h2>
    </div>
    <div class="stat-grid">
      <div class="stat">
        <div class="stat-label">Monthly Bills</div>
        <div class="stat-value">${escapeHtml(formatCurrency(totalMonthly, currency))}</div>
        <div class="stat-sub">${bills.length} tracked</div>
      </div>
      <div class="stat">
        <div class="stat-label">Unpaid This Cycle</div>
        <div class="stat-value">${escapeHtml(formatCurrency(unpaidThisCycle, currency))}</div>
        <div class="stat-sub">${overdueCount} overdue \u00b7 ${dueSoonCount} due soon</div>
      </div>
      <div class="stat">
        <div class="stat-label">Paid This Cycle</div>
        <div class="stat-value">${paidThisCycleCount}<span class="stat-value-sub"> / ${bills.length}</span></div>
        <div class="stat-sub">Bills settled</div>
      </div>
      <div class="stat">
        <div class="stat-label">Upcoming (14 days)</div>
        <div class="stat-value">${upcomingBills.length}</div>
        <div class="stat-sub">Including overdue</div>
      </div>
    </div>

    <div class="section-header section-header-tight">
      <h3>Upcoming &amp; Overdue Bills</h3>
    </div>
    ${upcomingBills.length === 0 ? `
      <div class="empty">
        <p>No bills due in the next 14 days.</p>
      </div>
    ` : `
      <div class="upcoming-list">
        ${upcomingBills.map(u => renderUpcomingBillRow(u, currency)).join('')}
      </div>
    `}

    <div class="section-header section-header-tight section-header-spaced">
      <h2>Credits</h2>
    </div>
    <div class="stat-grid">
      <div class="stat">
        <div class="stat-label">Active Loans</div>
        <div class="stat-value">${activeLoans}<span class="stat-value-sub"> / ${credits.length}</span></div>
        <div class="stat-sub">${completedLoans} completed</div>
      </div>
      <div class="stat">
        <div class="stat-label">Total Outstanding</div>
        <div class="stat-value">${escapeHtml(formatCurrency(totalOutstanding, currency))}</div>
        <div class="stat-sub">Across all loans</div>
      </div>
      <div class="stat">
        <div class="stat-label">Monthly Installments</div>
        <div class="stat-value">${escapeHtml(formatCurrency(creditMonthly, currency))}</div>
        <div class="stat-sub">Active loans only</div>
      </div>
      <div class="stat">
        <div class="stat-label">Total Interest</div>
        <div class="stat-value">${escapeHtml(formatCurrency(totalInterest, currency))}</div>
        <div class="stat-sub">On ${escapeHtml(formatCurrency(totalPrincipal, currency))} principal</div>
      </div>
    </div>

    ${credits.length > 0 ? `
      <div class="dash-row-grid">
        <div class="dash-mini-stat">
          <div class="dash-mini-label">Paid this month</div>
          <div class="dash-mini-value">
            <span class="badge badge-paid">${paidThisMonthCount}</span>
            <span class="muted tiny">of ${paidThisMonthCount + unpaidThisMonthCount} due</span>
          </div>
        </div>
        <div class="dash-mini-stat">
          <div class="dash-mini-label">Unpaid this month</div>
          <div class="dash-mini-value">
            <span class="badge ${unpaidThisMonthCount > 0 ? 'badge-due-soon' : 'badge-info'}">${unpaidThisMonthCount}</span>
            <span class="muted tiny">${escapeHtml(ymLabel(currentYM))}</span>
          </div>
        </div>
        <div class="dash-mini-stat">
          <div class="dash-mini-label">Total paid to date</div>
          <div class="dash-mini-value">
            <span class="amount amount-md">${escapeHtml(formatCurrency(totalPaidAll, currency))}</span>
          </div>
        </div>
      </div>
    ` : ''}

    <div class="section-header section-header-tight">
      <h3>Upcoming Installments (next 30 days)</h3>
    </div>
    ${upcomingInstallments.length === 0 ? `
      <div class="empty">
        <p>No loan installments due soon.</p>
      </div>
    ` : `
      <div class="upcoming-list">
        ${upcomingInstallments.map(u => renderUpcomingInstallmentRow(u, currency, currentYM)).join('')}
      </div>
    `}

    <div class="section-header section-header-tight">
      <h3>Active Loans Progress</h3>
    </div>
    ${loanRows.length === 0 ? `
      <div class="empty">
        <p>No active loans.</p>
      </div>
    ` : `
      <div class="loan-progress-list">
        ${loanRows.map(r => renderLoanProgressRow(r, currency)).join('')}
      </div>
    `}
  `;

  // CSP-safe progress fill widths (no inline style attribute).
  view.querySelectorAll('.progress-fill[data-progress]').forEach((el) => {
    const pct = Number(el.dataset.progress);
    const clamped = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    el.style.setProperty('--progress-width', `${clamped}%`);
  });
}

function renderUpcomingBillRow({ bill, due, days, status }, currency) {
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

function renderUpcomingInstallmentRow({ credit, ym, amount, isCurrentMonth, daysToMonthStart }, currency, currentYM) {
  let badgeClass, badgeText, when;
  if (isCurrentMonth) {
    badgeClass = 'badge-due-soon';
    badgeText = 'This month';
    when = `${ymLabel(ym)} \u00b7 unpaid`;
  } else if (daysToMonthStart <= 14) {
    badgeClass = 'badge-due-soon';
    badgeText = 'Due soon';
    when = `${ymLabel(ym)} \u00b7 in ${daysToMonthStart}d`;
  } else {
    badgeClass = 'badge-info';
    badgeText = 'Upcoming';
    when = `${ymLabel(ym)} \u00b7 in ${daysToMonthStart}d`;
  }

  const lenderTxt = credit.lender ? ` \u00b7 ${credit.lender}` : '';

  return `
    <div class="upcoming-row">
      <div>
        <div class="name">${escapeHtml(credit.name)}${escapeHtml(lenderTxt)}</div>
        <div class="when">${escapeHtml(when)}</div>
      </div>
      <div class="row-center-gap">
        <span class="amount amount-md">${escapeHtml(formatCurrency(amount, currency))}</span>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
    </div>
  `;
}

function renderLoanProgressRow({ credit, totals, prog, remaining }, currency) {
  const progressPct = prog.progress;
  const lenderTxt = credit.lender ? ` \u00b7 ${escapeHtml(credit.lender)}` : '';
  return `
    <div class="loan-progress-row">
      <div class="loan-progress-head">
        <div>
          <div class="name">${escapeHtml(credit.name)}<span class="muted tiny">${lenderTxt}</span></div>
          <div class="when">${prog.paidCount} / ${prog.totalMonths} months \u00b7 ${escapeHtml(formatCurrency(totals.monthly, currency))}/mo</div>
        </div>
        <div class="row-center-gap">
          <div class="loan-progress-amounts">
            <div class="amount amount-md">${escapeHtml(formatCurrency(remaining, currency))}</div>
            <div class="muted tiny">remaining</div>
          </div>
        </div>
      </div>
      <div class="progress progress-spaced">
        <div class="progress-fill" data-progress="${progressPct.toFixed(1)}"></div>
      </div>
    </div>
  `;
}
