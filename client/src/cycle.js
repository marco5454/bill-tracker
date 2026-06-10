// Bill cycle math. Cycle keys uniquely identify "this current cycle"
// for a bill (Monthly: YYYY-MM, Quarterly: YYYY-Qn, Annually: YYYY).

import { daysInMonth, ymKey, todayLocal } from './format.js';

export function quarterIndex(monthIdx, anchorMonth) {
  const a = (anchorMonth || 1) - 1;             // 0..2
  const diff = (monthIdx - a + 12) % 12;
  return Math.floor(diff / 3);                  // 0..3
}

export function cycleDueDate(bill, refDate = todayLocal()) {
  const ref = new Date(refDate);
  const y = ref.getFullYear();
  const m = ref.getMonth();

  if (bill.recurrence === 'Annually') {
    const dueMonthIdx = (Number(bill.dueMonth) || 1) - 1;
    const day = Math.min(bill.dueDay, daysInMonth(y, dueMonthIdx));
    return new Date(y, dueMonthIdx, day);
  }
  if (bill.recurrence === 'Quarterly') {
    const anchor = (Number(bill.anchorMonth) || 1) - 1;
    const qIdx = quarterIndex(m, bill.anchorMonth);
    const cycleMonth = anchor + qIdx * 3;
    const day = Math.min(bill.dueDay, daysInMonth(y, cycleMonth));
    return new Date(y, cycleMonth, day);
  }
  // Monthly
  const day = Math.min(bill.dueDay, daysInMonth(y, m));
  return new Date(y, m, day);
}

export function cycleKey(bill, refDate = todayLocal()) {
  const ref = new Date(refDate);
  if (bill.recurrence === 'Annually') return String(ref.getFullYear());
  if (bill.recurrence === 'Quarterly') {
    const qIdx = quarterIndex(ref.getMonth(), bill.anchorMonth);
    return `${ref.getFullYear()}-Q${qIdx + 1}`;
  }
  return ymKey(ref);
}

export function nextCycleDueDate(bill, refDate = todayLocal()) {
  const cur = cycleDueDate(bill, refDate);
  if (bill.recurrence === 'Annually') {
    return cycleDueDate(bill, new Date(cur.getFullYear() + 1, cur.getMonth(), 1));
  }
  if (bill.recurrence === 'Quarterly') {
    return cycleDueDate(bill, new Date(cur.getFullYear(), cur.getMonth() + 3, 1));
  }
  return cycleDueDate(bill, new Date(cur.getFullYear(), cur.getMonth() + 1, 1));
}

// Human-friendly label for the current cycle (e.g. "Jun 2026", "Q2 2026", "2026").
export function cycleLabel(bill, refDate = todayLocal()) {
  const ref = new Date(refDate);
  if (bill.recurrence === 'Annually') return String(ref.getFullYear());
  if (bill.recurrence === 'Quarterly') {
    const qIdx = quarterIndex(ref.getMonth(), bill.anchorMonth);
    return `Q${qIdx + 1} ${ref.getFullYear()}`;
  }
  // Monthly
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[ref.getMonth()]} ${ref.getFullYear()}`;
}

export function isPaidThisCycle(bill, refDate = todayLocal()) {
  const k = cycleKey(bill, refDate);
  return Array.isArray(bill.payments) && bill.payments.includes(k);
}

// 'paid' | 'overdue' | 'due-soon' | 'upcoming'
export function billStatus(bill, refDate = todayLocal()) {
  if (isPaidThisCycle(bill, refDate)) return 'paid';
  const due = cycleDueDate(bill, refDate);
  const today = new Date(refDate); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) return 'overdue';
  if (diffDays <= 3) return 'due-soon';
  return 'upcoming';
}

export function monthlyEquivalent(bill) {
  switch (bill.recurrence) {
    case 'Quarterly': return bill.amount / 3;
    case 'Annually':  return bill.amount / 12;
    default:          return bill.amount;
  }
}
