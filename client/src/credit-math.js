// Credit/loan math.
// Simple Interest:    Total = P * (1 + r/100 * years)        where years = months/12
// Monthly Add-On:     Total = P + (P * r/100 * months)       (r is monthly %)
// Monthly installment = Total / months

import { daysInMonth, ymKey, todayLocal } from './format.js';

export function computeTotals(credit) {
  const P = Number(credit.principal) || 0;
  const r = Number(credit.ratePct)   || 0;
  const m = Number(credit.termMonths)|| 1;

  let total;
  if (credit.interestType === 'addon') {
    total = P + (P * r / 100 * m);
  } else {
    const years = m / 12;
    total = P * (1 + r / 100 * years);
  }
  const monthly = total / m;
  return {
    total,
    monthly,
    interest: total - P
  };
}

// Return list of all YM keys covered by this loan, inclusive of start/end month.
export function monthList(credit) {
  const start = new Date(credit.startDate + 'T00:00:00');
  const out = [];
  for (let i = 0; i < credit.termMonths; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    out.push(ymKey(d));
  }
  return out;
}

// Derive endDate (YYYY-MM-DD) from startDate + termMonths, with day-of-month clamped
// so Jan 31 + 1mo => Feb 28/29 instead of Mar 3.
export function deriveEndDate(startDateIso, termMonths) {
  const start = new Date(startDateIso + 'T00:00:00');
  if (Number.isNaN(start.getTime())) return '';
  const targetMonth = start.getMonth() + (termMonths - 1);
  const targetYear  = start.getFullYear() + Math.floor(targetMonth / 12);
  const monthIdx    = ((targetMonth % 12) + 12) % 12;
  const day = Math.min(start.getDate(), daysInMonth(targetYear, monthIdx));
  const yyyy = String(targetYear).padStart(4, '0');
  const mm   = String(monthIdx + 1).padStart(2, '0');
  const dd   = String(day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function computeProgress(credit, refDate = todayLocal()) {
  const months = monthList(credit);
  const totalMonths = months.length;
  const paymentMap = new Map();
  for (const p of credit.payments || []) {
    paymentMap.set(p.ym, p);
  }
  const paidCount = months.filter(ym => paymentMap.has(ym)).length;
  const currentYM = ymKey(refDate);
  const monthsRemaining = months.filter(ym => ym >= currentYM).length;
  const monthsElapsed = totalMonths - monthsRemaining;
  const progress = totalMonths > 0 ? (paidCount / totalMonths) * 100 : 0;
  const timeProgress = totalMonths > 0 ? Math.max(0, Math.min(100, (monthsElapsed / totalMonths) * 100)) : 0;

  // Total paid: sum of (per-payment amount if set, else scheduled monthly)
  const { monthly } = computeTotals(credit);
  let totalPaid = 0;
  for (const p of credit.payments || []) {
    totalPaid += (p.amount != null ? Number(p.amount) : monthly);
  }

  return {
    totalMonths,
    paidCount,
    monthsRemaining,
    monthsElapsed,
    progress,
    timeProgress,
    totalPaid,
    paymentMap
  };
}
