/**
 * server/getAuthAlertSummaries.periodMetrics.test.ts
 * Regression coverage for the C3B migration: getAuthAlertSummaries' per-patient
 * target-period summary (sessionsAuthorized/sessionsRemaining) must produce the
 * same observable output now that the period math is sourced from
 * @shared/authPeriodMetrics instead of an inline duplicate formula.
 *
 * Also covers C6C: the authPeriod field exposed on each authAlerts result is a
 * read-only passthrough of this same targetPeriod value — no new calculation.
 */

import { describe, it, expect } from 'vitest';
import { deriveAuthPeriodMetrics, getPeriodMetrics, type AuthPeriodVisit } from '../shared/authPeriodMetrics';

// Inline copy of the target-period resolution in getAuthAlertSummaries
// (server/db.ts), scoped to the fields under test.
function resolveTargetPeriodSummary(pVisits: AuthPeriodVisit[]) {
  const { periods: allPeriods, activePeriod } = deriveAuthPeriodMetrics(pVisits);
  const latestPeriod = allPeriods[allPeriods.length - 1];
  const targetPeriod = activePeriod ?? latestPeriod;
  const targetVisits = pVisits.filter(v => (v.authPeriod ?? 1) === targetPeriod);

  const authRow = targetVisits.find(v => v.sessionsAuthorized != null);
  const sessionsAuthorized = authRow?.sessionsAuthorized ?? null;
  const sessionsRemaining = activePeriod !== null
    ? getPeriodMetrics(pVisits, targetPeriod).remaining
    : 0;

  return { sessionsAuthorized, sessionsRemaining, activePeriod, authPeriod: targetPeriod };
}

function visit(authPeriod: number | null, sessionsAuthorized: number | null, dateOfService: unknown): AuthPeriodVisit {
  return { authPeriod, sessionsAuthorized, dateOfService };
}

describe('getAuthAlertSummaries target-period summary (post-C3B)', () => {
  it('CASE A: single active period', () => {
    const visits = [
      visit(1, 10, '2026-01-01'),
      visit(1, null, '2026-01-02'),
      visit(1, null, '2026-01-03'),
      visit(1, null, null),
    ];
    expect(resolveTargetPeriodSummary(visits)).toEqual({ sessionsAuthorized: 10, sessionsRemaining: 7, activePeriod: 1, authPeriod: 1 });
  });

  it('CASE B: period 1 exhausted, period 2 active', () => {
    const visits = [
      visit(1, 5, '2026-01-01'),
      visit(1, null, '2026-01-02'),
      visit(1, null, '2026-01-03'),
      visit(1, null, '2026-01-04'),
      visit(1, null, '2026-01-05'),
      visit(2, 8, '2026-02-01'),
      visit(2, null, '2026-02-02'),
      visit(2, null, null),
    ];
    expect(resolveTargetPeriodSummary(visits)).toEqual({ sessionsAuthorized: 8, sessionsRemaining: 6, activePeriod: 2, authPeriod: 2 });
  });

  it('CASE C: period 1 still active while period 2 exists', () => {
    const visits = [
      visit(1, 10, '2026-01-01'),
      visit(1, null, '2026-01-02'),
      visit(2, 10, null),
    ];
    expect(resolveTargetPeriodSummary(visits)).toEqual({ sessionsAuthorized: 10, sessionsRemaining: 8, activePeriod: 1, authPeriod: 1 });
  });

  it('CASE D: all periods exhausted — falls back to the latest period; sessionsAuthorized is preserved (not zeroed) while sessionsRemaining is forced to 0', () => {
    const visits = [
      visit(1, 5, '2026-01-01'),
      visit(1, null, '2026-01-02'),
      visit(1, null, '2026-01-03'),
      visit(1, null, '2026-01-04'),
      visit(1, null, '2026-01-05'),
    ];
    expect(resolveTargetPeriodSummary(visits)).toEqual({ sessionsAuthorized: 5, sessionsRemaining: 0, activePeriod: null, authPeriod: 1 });
  });

  it('CASE E: null authPeriod normalizes to period 1', () => {
    const visits = [visit(null, 10, '2026-01-01'), visit(null, null, null)];
    expect(resolveTargetPeriodSummary(visits)).toEqual({ sessionsAuthorized: 10, sessionsRemaining: 9, activePeriod: 1, authPeriod: 1 });
  });

  it('CASE F: a stale sessionsRemaining field on the input row does not influence the active-period decision', () => {
    const base = [visit(1, 10, '2026-01-01'), visit(1, null, '2026-01-02')];
    const withStale = base.map(v => ({ ...v, sessionsRemaining: 999 }));

    expect(resolveTargetPeriodSummary(withStale)).toEqual(resolveTargetPeriodSummary(base));
    expect(resolveTargetPeriodSummary(base)).toEqual({ sessionsAuthorized: 10, sessionsRemaining: 8, activePeriod: 1, authPeriod: 1 });
  });
});

describe('getAuthAlertSummaries authPeriod field (C6C)', () => {
  it('CASE A: single period 1 → authPeriod = 1', () => {
    const visits = [visit(1, 10, '2026-01-01'), visit(1, null, '2026-01-02')];
    expect(resolveTargetPeriodSummary(visits).authPeriod).toBe(1);
  });

  it('CASE B: period 1 exhausted, period 2 active → authPeriod = 2', () => {
    const visits = [
      visit(1, 5, '2026-01-01'), visit(1, null, '2026-01-02'), visit(1, null, '2026-01-03'),
      visit(1, null, '2026-01-04'), visit(1, null, '2026-01-05'),
      visit(2, 8, '2026-02-01'), visit(2, null, '2026-02-02'),
    ];
    expect(resolveTargetPeriodSummary(visits).authPeriod).toBe(2);
  });

  it('CASE C: period 1 active, period 2 newer exists → authPeriod = 1', () => {
    const visits = [visit(1, 10, '2026-01-01'), visit(1, null, '2026-01-02'), visit(2, 10, null)];
    expect(resolveTargetPeriodSummary(visits).authPeriod).toBe(1);
  });

  it('CASE D: all periods exhausted → authPeriod = latestPeriod', () => {
    const visits = [
      visit(1, 5, '2026-01-01'), visit(1, null, '2026-01-02'), visit(1, null, '2026-01-03'),
      visit(1, null, '2026-01-04'), visit(1, null, '2026-01-05'),
      visit(2, 3, '2026-02-01'), visit(2, null, '2026-02-02'), visit(2, null, '2026-02-03'),
      visit(2, null, '2026-02-04'),
    ];
    const result = resolveTargetPeriodSummary(visits);
    expect(result.activePeriod).toBeNull();
    expect(result.authPeriod).toBe(2);
  });

  it('CASE E: null auth_period rows normalize to period 1, preserving shared normalization', () => {
    const visits = [visit(null, 10, '2026-01-01'), visit(null, null, null)];
    expect(resolveTargetPeriodSummary(visits).authPeriod).toBe(1);
  });

  it('CASE F: unordered periods still resolve by the active-period rule, not array order', () => {
    const visits = [
      visit(2, 8, '2026-02-01'), visit(2, null, '2026-02-02'),
      visit(1, 5, '2026-01-01'), visit(1, null, '2026-01-02'), visit(1, null, '2026-01-03'),
      visit(1, null, '2026-01-04'), visit(1, null, '2026-01-05'),
    ];
    // period 1 (listed second in the array) is exhausted, period 2 (listed first) is active
    expect(resolveTargetPeriodSummary(visits).authPeriod).toBe(2);
  });
});
