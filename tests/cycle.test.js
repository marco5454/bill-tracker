import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  quarterIndex,
  cycleDueDate,
  cycleKey,
  nextCycleDueDate,
  cycleLabel,
  isPaidThisCycle,
  billStatus,
  monthlyEquivalent,
} from '../client/src/cycle.js';

// Helper: make a Date at local-midnight for a given y/m/d.
const ymd = (y, m, d) => new Date(y, m - 1, d);

describe('quarterIndex', () => {
  it('returns 0..3 for the 4 quarters when anchor=Jan', () => {
    // Anchor month 1 (Jan): Jan/Feb/Mar = Q1 (idx 0), Apr/May/Jun = Q2 (idx 1), etc.
    assert.equal(quarterIndex(0, 1), 0); // Jan
    assert.equal(quarterIndex(2, 1), 0); // Mar
    assert.equal(quarterIndex(3, 1), 1); // Apr
    assert.equal(quarterIndex(5, 1), 1); // Jun
    assert.equal(quarterIndex(6, 1), 2); // Jul
    assert.equal(quarterIndex(8, 1), 2); // Sep
    assert.equal(quarterIndex(9, 1), 3); // Oct
    assert.equal(quarterIndex(11, 1), 3); // Dec
  });

  it('shifts correctly for non-Jan anchors', () => {
    // Anchor month 2 (Feb): Feb/Mar/Apr = Q1, May/Jun/Jul = Q2, Aug/Sep/Oct = Q3, Nov/Dec/Jan = Q4
    assert.equal(quarterIndex(1, 2), 0); // Feb
    assert.equal(quarterIndex(3, 2), 0); // Apr
    assert.equal(quarterIndex(4, 2), 1); // May
    assert.equal(quarterIndex(10, 2), 3); // Nov
    assert.equal(quarterIndex(0, 2), 3); // Jan wraps to Q4
  });

  it('treats null/undefined anchorMonth as 1', () => {
    assert.equal(quarterIndex(0, undefined), 0);
    assert.equal(quarterIndex(0, null), 0);
    assert.equal(quarterIndex(5, 0), 1); // 0 -> falsy -> defaults to 1
  });
});

describe('cycleDueDate', () => {
  it('Monthly: clamps day to last day of month (Feb 31 -> Feb 28/29)', () => {
    const bill = { recurrence: 'Monthly', dueDay: 31 };
    // 2026 is not a leap year — Feb 2026 has 28 days
    const d = cycleDueDate(bill, ymd(2026, 2, 15));
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 1); // Feb
    assert.equal(d.getDate(), 28);
  });

  it('Monthly: clamps day to leap-year February (29)', () => {
    const bill = { recurrence: 'Monthly', dueDay: 31 };
    const d = cycleDueDate(bill, ymd(2024, 2, 10));
    assert.equal(d.getDate(), 29);
  });

  it('Annually: uses dueMonth, not the ref month', () => {
    const bill = { recurrence: 'Annually', dueDay: 15, dueMonth: 6 };
    const d = cycleDueDate(bill, ymd(2026, 1, 1));
    assert.equal(d.getMonth(), 5); // June
    assert.equal(d.getDate(), 15);
    assert.equal(d.getFullYear(), 2026);
  });

  it('Annually: clamps dueDay to that month length', () => {
    const bill = { recurrence: 'Annually', dueDay: 31, dueMonth: 2 };
    const d = cycleDueDate(bill, ymd(2026, 7, 1));
    assert.equal(d.getMonth(), 1);
    assert.equal(d.getDate(), 28);
  });

  it('Quarterly: lands on the quarter-cycle month relative to anchor', () => {
    // anchorMonth=1 (Jan): refDate in Aug -> Q3 (Jul/Aug/Sep), cycle month = Jul (idx 6)
    const bill = { recurrence: 'Quarterly', dueDay: 10, anchorMonth: 1 };
    const d = cycleDueDate(bill, ymd(2026, 8, 20));
    assert.equal(d.getMonth(), 6); // July
    assert.equal(d.getDate(), 10);
  });
});

describe('cycleKey', () => {
  it('Monthly -> YYYY-MM', () => {
    assert.equal(cycleKey({ recurrence: 'Monthly' }, ymd(2026, 6, 5)), '2026-06');
    assert.equal(cycleKey({ recurrence: 'Monthly' }, ymd(2026, 12, 31)), '2026-12');
  });

  it('Quarterly -> YYYY-Qn relative to anchorMonth', () => {
    assert.equal(cycleKey({ recurrence: 'Quarterly', anchorMonth: 1 }, ymd(2026, 5, 1)), '2026-Q2');
    assert.equal(cycleKey({ recurrence: 'Quarterly', anchorMonth: 1 }, ymd(2026, 1, 1)), '2026-Q1');
    assert.equal(cycleKey({ recurrence: 'Quarterly', anchorMonth: 1 }, ymd(2026, 12, 1)), '2026-Q4');
    // anchor=2 (Feb): Jan -> Q4
    assert.equal(cycleKey({ recurrence: 'Quarterly', anchorMonth: 2 }, ymd(2026, 1, 15)), '2026-Q4');
  });

  it('Annually -> YYYY', () => {
    assert.equal(cycleKey({ recurrence: 'Annually' }, ymd(2026, 8, 1)), '2026');
  });
});

describe('nextCycleDueDate', () => {
  it('Monthly advances by 1 month', () => {
    const bill = { recurrence: 'Monthly', dueDay: 5 };
    const next = nextCycleDueDate(bill, ymd(2026, 6, 10));
    assert.equal(next.getFullYear(), 2026);
    assert.equal(next.getMonth(), 6); // July
    assert.equal(next.getDate(), 5);
  });

  it('Quarterly advances by 3 months and stays on the quarter', () => {
    const bill = { recurrence: 'Quarterly', dueDay: 1, anchorMonth: 1 };
    const next = nextCycleDueDate(bill, ymd(2026, 5, 1)); // Q2 -> Q3
    assert.equal(next.getMonth(), 6); // July
    assert.equal(next.getFullYear(), 2026);
  });

  it('Annually advances by 1 year, same dueMonth', () => {
    const bill = { recurrence: 'Annually', dueDay: 15, dueMonth: 4 };
    const next = nextCycleDueDate(bill, ymd(2026, 8, 1));
    assert.equal(next.getFullYear(), 2027);
    assert.equal(next.getMonth(), 3); // April
  });
});

describe('cycleLabel', () => {
  it('Monthly: "Mon YYYY"', () => {
    assert.equal(cycleLabel({ recurrence: 'Monthly' }, ymd(2026, 6, 1)), 'Jun 2026');
  });
  it('Quarterly: "Qn YYYY"', () => {
    assert.equal(cycleLabel({ recurrence: 'Quarterly', anchorMonth: 1 }, ymd(2026, 5, 1)), 'Q2 2026');
  });
  it('Annually: "YYYY"', () => {
    assert.equal(cycleLabel({ recurrence: 'Annually' }, ymd(2026, 5, 1)), '2026');
  });
});

describe('isPaidThisCycle', () => {
  it('returns true when payments include the current cycle key', () => {
    const bill = { recurrence: 'Monthly', payments: ['2026-06'] };
    assert.equal(isPaidThisCycle(bill, ymd(2026, 6, 15)), true);
    assert.equal(isPaidThisCycle(bill, ymd(2026, 7, 15)), false);
  });

  it('returns false when payments is missing/empty', () => {
    assert.equal(isPaidThisCycle({ recurrence: 'Monthly' }, ymd(2026, 6, 15)), false);
    assert.equal(isPaidThisCycle({ recurrence: 'Monthly', payments: [] }, ymd(2026, 6, 15)), false);
  });
});

describe('billStatus', () => {
  const bill = (extra) => ({ recurrence: 'Monthly', dueDay: 15, payments: [], ...extra });

  it('returns "paid" when current cycle is in payments', () => {
    assert.equal(billStatus(bill({ payments: ['2026-06'] }), ymd(2026, 6, 1)), 'paid');
  });

  it('returns "overdue" when due date has passed and unpaid', () => {
    assert.equal(billStatus(bill(), ymd(2026, 6, 20)), 'overdue');
  });

  it('returns "due-soon" within 3 days', () => {
    assert.equal(billStatus(bill(), ymd(2026, 6, 13)), 'due-soon'); // 2 days
    assert.equal(billStatus(bill(), ymd(2026, 6, 15)), 'due-soon'); // 0 days
  });

  it('returns "upcoming" when more than 3 days away', () => {
    assert.equal(billStatus(bill(), ymd(2026, 6, 5)), 'upcoming');
  });
});

describe('monthlyEquivalent', () => {
  it('Monthly: identity', () => {
    assert.equal(monthlyEquivalent({ recurrence: 'Monthly', amount: 1200 }), 1200);
  });
  it('Quarterly: amount/3', () => {
    assert.equal(monthlyEquivalent({ recurrence: 'Quarterly', amount: 300 }), 100);
  });
  it('Annually: amount/12', () => {
    assert.equal(monthlyEquivalent({ recurrence: 'Annually', amount: 1200 }), 100);
  });
});
