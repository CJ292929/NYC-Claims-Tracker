import { describe, it, expect } from 'vitest';
import { getPatientMetrics } from './patientMetrics';
import type { AuthPeriodVisit } from '@shared/authPeriodMetrics';

function visit(authPeriod: number | null, sessionsAuthorized: number | null, dateOfService: unknown): AuthPeriodVisit {
  return { authPeriod, sessionsAuthorized, dateOfService };
}

describe('getPatientMetrics', () => {
  it('CASE A: single active period', () => {
    const result = getPatientMetrics([
      visit(1, 10, '2026-01-01'),
      visit(1, null, '2026-01-02'),
      visit(1, null, '2026-01-03'),
      visit(1, null, null),
    ]);

    expect(result).toEqual({ totalAuthorized: 10, completed: 3, remaining: 7, activePeriod: 1, expired: false, unusedExpired: 0 });
  });

  it('CASE B: period 1 exhausted / period 2 active', () => {
    const result = getPatientMetrics([
      visit(1, 5, '2026-01-01'),
      visit(1, null, '2026-01-02'),
      visit(1, null, '2026-01-03'),
      visit(1, null, '2026-01-04'),
      visit(1, null, '2026-01-05'),
      visit(2, 8, '2026-02-01'),
      visit(2, null, '2026-02-02'),
      visit(2, null, null),
    ]);

    expect(result).toEqual({ totalAuthorized: 8, completed: 2, remaining: 6, activePeriod: 2, expired: false, unusedExpired: 0 });
  });

  it('CASE C: period 1 active while period 2 exists (oldest non-exhausted wins)', () => {
    const result = getPatientMetrics([
      visit(1, 10, '2026-01-01'),
      visit(1, null, '2026-01-02'),
      visit(2, 10, null),
    ]);

    expect(result.activePeriod).toBe(1);
    expect(result).toEqual({ totalAuthorized: 10, completed: 2, remaining: 8, activePeriod: 1, expired: false, unusedExpired: 0 });
  });

  it('CASE D: all periods exhausted — falls back to latest period totals, remaining 0', () => {
    const result = getPatientMetrics([
      visit(1, 5, '2026-01-01'),
      visit(1, null, '2026-01-02'),
      visit(1, null, '2026-01-03'),
      visit(1, null, '2026-01-04'),
      visit(1, null, '2026-01-05'),
    ]);

    expect(result).toEqual({ totalAuthorized: 5, completed: 5, remaining: 0, activePeriod: null, expired: false, unusedExpired: 0 });
  });

  it('CASE D2: all periods exhausted with multiple periods — uses the latest period, not period 1', () => {
    const result = getPatientMetrics([
      visit(1, 5, '2026-01-01'),
      visit(1, null, '2026-01-02'),
      visit(1, null, '2026-01-03'),
      visit(1, null, '2026-01-04'),
      visit(1, null, '2026-01-05'),
      visit(2, 3, '2026-02-01'),
      visit(2, null, '2026-02-02'),
      visit(2, null, '2026-02-03'),
    ]);

    expect(result).toEqual({ totalAuthorized: 3, completed: 3, remaining: 0, activePeriod: null, expired: false, unusedExpired: 0 });
  });

  it('CASE E: null authPeriod normalizes to period 1', () => {
    const result = getPatientMetrics([visit(null, 10, '2026-01-01'), visit(null, null, null)]);

    expect(result).toEqual({ totalAuthorized: 10, completed: 1, remaining: 9, activePeriod: 1, expired: false, unusedExpired: 0 });
  });

  it('CASE F: stale stored sessionsRemaining on the input row does not affect output', () => {
    const rows = [visit(1, 10, '2026-01-01'), visit(1, null, '2026-01-02')];
    const withStale = rows.map(v => ({ ...v, sessionsRemaining: 999 }));

    expect(getPatientMetrics(withStale)).toEqual(getPatientMetrics(rows));
  });

  it('CASE H (empty): no visits at all', () => {
    expect(getPatientMetrics([])).toEqual({ totalAuthorized: 0, completed: 0, remaining: 0, activePeriod: null, expired: false, unusedExpired: 0 });
  });
});
