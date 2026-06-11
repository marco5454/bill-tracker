import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTotals,
  monthList,
  deriveEndDate,
  computeProgress,
} from '../client/src/credit-math.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

describe('computeTotals', () => {
  it('simple interest: P*(1 + r/100 * months/12)', () => {
    const credit = { principal: 100_000, ratePct: 12, termMonths: 12, interestType: 'simple' };
    const { total, monthly, interest } = computeTotals(credit);
    // 100000 * (1 + 0.12 * 1) = 112000; monthly = 112000/12
    assert.ok(close(total, 112_000));
    assert.ok(close(monthly, 112_000 / 12));
    assert.ok(close(interest, 12_000));
  });

  it('simple interest with fractional years', () => {
    const credit = { principal: 60_000, ratePct: 6, termMonths: 6, interestType: 'simple' };
    const { total, monthly } = computeTotals(credit);
    // years = 0.5; total = 60000 * (1 + 0.03) = 61800
    assert.ok(close(total, 61_800));
    assert.ok(close(monthly, 61_800 / 6));
  });

  it('addon: P + P*r/100*months', () => {
    const credit = { principal: 100_000, ratePct: 1, termMonths: 12, interestType: 'addon' };
    const { total, monthly, interest } = computeTotals(credit);
    // 100000 + 100000*0.01*12 = 100000 + 12000 = 112000
    assert.ok(close(total, 112_000));
    assert.ok(close(monthly, 112_000 / 12));
    assert.ok(close(interest, 12_000));
  });

  it('zero rate -> total equals principal', () => {
    const { total, monthly, interest } = computeTotals({
      principal: 50_000, ratePct: 0, termMonths: 10, interestType: 'simple',
    });
    assert.equal(total, 50_000);
    assert.equal(monthly, 5_000);
    assert.equal(interest, 0);
  });
});

describe('monthList', () => {
  it('returns termMonths YM keys starting at startDate month', () => {
    const credit = { startDate: '2026-01-15', termMonths: 4 };
    assert.deepEqual(monthList(credit), ['2026-01', '2026-02', '2026-03', '2026-04']);
  });

  it('rolls into the next year correctly', () => {
    const credit = { startDate: '2026-11-01', termMonths: 4 };
    assert.deepEqual(monthList(credit), ['2026-11', '2026-12', '2027-01', '2027-02']);
  });
});

describe('deriveEndDate', () => {
  it('Jan 31 + 1 month -> Feb 28 (non-leap year)', () => {
    assert.equal(deriveEndDate('2026-01-31', 2), '2026-02-28');
  });

  it('Jan 31 + 1 month -> Feb 29 (leap year 2024)', () => {
    assert.equal(deriveEndDate('2024-01-31', 2), '2024-02-29');
  });

  it('Mar 31 + 1 month -> Apr 30 (clamped)', () => {
    assert.equal(deriveEndDate('2026-03-31', 2), '2026-04-30');
  });

  it('crosses year boundary correctly', () => {
    // Aug 15 + 6 months = Jan 15 of next year (term=6 means end is on the 6th month)
    assert.equal(deriveEndDate('2026-08-15', 6), '2027-01-15');
  });

  it('returns empty string for invalid date', () => {
    assert.equal(deriveEndDate('not-a-date', 6), '');
  });
});

describe('computeProgress', () => {
  const credit = {
    principal: 120_000,
    ratePct: 0,
    termMonths: 12,
    interestType: 'simple',
    startDate: '2026-01-01',
    payments: [],
  };

  it('all unpaid: progress 0, monthsRemaining = totalMonths if today is before/at start', () => {
    // refDate = first month (2026-01), so all 12 months are >= currentYM
    const p = computeProgress({ ...credit }, new Date(2026, 0, 1));
    assert.equal(p.totalMonths, 12);
    assert.equal(p.paidCount, 0);
    assert.equal(p.monthsRemaining, 12);
    assert.equal(p.monthsElapsed, 0);
    assert.equal(p.progress, 0);
    assert.equal(p.totalPaid, 0);
  });

  it('half paid: paymentBased progress = 50%', () => {
    const payments = [
      { ym: '2026-01', amount: null },
      { ym: '2026-02', amount: null },
      { ym: '2026-03', amount: null },
      { ym: '2026-04', amount: null },
      { ym: '2026-05', amount: null },
      { ym: '2026-06', amount: null },
    ];
    const p = computeProgress({ ...credit, payments }, new Date(2026, 6, 1));
    assert.equal(p.paidCount, 6);
    assert.ok(close(p.progress, 50));
    // 12 monthly payments scheduled, monthly = 10000; 6 paid * 10000 = 60000
    assert.ok(close(p.totalPaid, 60_000));
  });

  it('mixes null amounts (use scheduled) and explicit overpayments', () => {
    const payments = [
      { ym: '2026-01', amount: null },     // scheduled 10000
      { ym: '2026-02', amount: 15_000 },   // overpaid
    ];
    const p = computeProgress({ ...credit, payments }, new Date(2026, 2, 1));
    assert.equal(p.paidCount, 2);
    assert.ok(close(p.totalPaid, 10_000 + 15_000));
  });

  it('monthsRemaining only counts months >= currentYM (inclusive)', () => {
    const p = computeProgress({ ...credit }, new Date(2026, 5, 15)); // June
    // months: Jan..Dec; currentYM = '2026-06'; months >= '2026-06' = Jun..Dec = 7
    assert.equal(p.monthsRemaining, 7);
    assert.equal(p.monthsElapsed, 5);
  });

  it('after term ends, monthsRemaining = 0', () => {
    const p = computeProgress({ ...credit }, new Date(2027, 0, 1)); // Jan 2027
    assert.equal(p.monthsRemaining, 0);
    assert.equal(p.monthsElapsed, 12);
  });

  it('handles zero-term gracefully (defensive)', () => {
    const c = { ...credit, termMonths: 0 };
    const p = computeProgress(c, new Date(2026, 0, 1));
    assert.equal(p.totalMonths, 0);
    assert.equal(p.progress, 0);
    assert.equal(p.timeProgress, 0);
  });
});
