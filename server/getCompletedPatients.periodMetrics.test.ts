/**
 * server/getCompletedPatients.periodMetrics.test.ts
 * Regression coverage for the C3D migration: getCompletedPatients' completion
 * classification must be derived from @shared/authPeriodMetrics (all
 * authorization periods exhausted) instead of trusting a single visit row's
 * stored sessions_remaining column.
 */

import { describe, it, expect } from 'vitest';
import { determineActivePeriod, type AuthPeriodVisit } from '../shared/authPeriodMetrics';

// Inline copy of the per-patient completion check in getCompletedPatients
// (server/db.ts), scoped to the field under test.
function isCompleted(pVisits: AuthPeriodVisit[]): boolean {
  if (pVisits.length === 0) return false;
  return determineActivePeriod(pVisits) === null;
}

function visit(authPeriod: number | null, sessionsAuthorized: number | null, dateOfService: unknown): AuthPeriodVisit {
  return { authPeriod, sessionsAuthorized, dateOfService };
}

describe('getCompletedPatients classification (post-C3D)', () => {
  it('CASE 1: one partially-used period → not completed', () => {
    const visits = [
      visit(1, 10, '2026-01-01'),
      visit(1, 10, '2026-01-02'),
      visit(1, null, null),
    ];
    expect(isCompleted(visits)).toBe(false);
  });

  it('CASE 2: one exhausted period → completed', () => {
    const visits = [
      visit(1, 2, '2026-01-01'),
      visit(1, null, '2026-01-02'),
    ];
    expect(isCompleted(visits)).toBe(true);
  });

  it('CASE 3: historical exhausted period + current active period → not completed', () => {
    const visits = [
      visit(1, 10, '2026-01-01'),
      visit(1, 10, '2026-01-02'),
      visit(2, 10, '2026-02-01'),
      visit(2, null, '2026-02-02'),
      visit(2, null, null),
    ];
    expect(isCompleted(visits)).toBe(false);
  });

  it('CASE 4: two exhausted periods → completed', () => {
    const visits = [
      visit(1, 2, '2026-01-01'),
      visit(1, null, '2026-01-02'),
      visit(2, 2, '2026-02-01'),
      visit(2, null, '2026-02-02'),
    ];
    expect(isCompleted(visits)).toBe(true);
  });

  it('CASE 5: stale sessionsRemaining falsely says 0 on the last row → derived result still requires actual exhaustion', () => {
    const base: AuthPeriodVisit[] = [
      visit(1, 10, '2026-01-01'),
      visit(1, 10, '2026-01-02'),
      { ...visit(1, null, null), sessionsAuthorized: null },
    ];
    const withStaleZero = base.map(v => ({ ...v, sessionsRemaining: 0 }));
    expect(isCompleted(withStaleZero)).toBe(false);
    expect(isCompleted(withStaleZero)).toBe(isCompleted(base));
  });

  it('CASE 6: stale sessionsRemaining falsely says >0 on the last row → derived result still recognizes exhaustion', () => {
    const base: AuthPeriodVisit[] = [
      visit(1, 2, '2026-01-01'),
      visit(1, null, '2026-01-02'),
    ];
    const withStaleNonzero = base.map(v => ({ ...v, sessionsRemaining: 999 }));
    expect(isCompleted(withStaleNonzero)).toBe(true);
    expect(isCompleted(withStaleNonzero)).toBe(isCompleted(base));
  });

  it('CASE 7: null authPeriod normalizes to period 1 and is still classified correctly', () => {
    const visits = [
      visit(null, 2, '2026-01-01'),
      visit(null, null, '2026-01-02'),
    ];
    expect(isCompleted(visits)).toBe(true);
  });

  it('CASE 8: completed > authorized (legacy/inconsistent data) → remaining clamps at 0, still completed', () => {
    const visits = [
      visit(1, 2, '2026-01-01'),
      visit(1, null, '2026-01-02'),
      visit(1, null, '2026-01-03'),
    ];
    expect(isCompleted(visits)).toBe(true);
  });

  it('CASE 9: zero visits → not completed', () => {
    expect(isCompleted([])).toBe(false);
  });

  it('CASE 10: period 1 exhausted, period 2 exists with no completed visits yet → not completed', () => {
    const visits = [
      visit(1, 2, '2026-01-01'),
      visit(1, null, '2026-01-02'),
      visit(2, 5, null),
      visit(2, null, null),
    ];
    expect(isCompleted(visits)).toBe(false);
  });
});
