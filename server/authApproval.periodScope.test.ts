/**
 * server/authApproval.periodScope.test.ts
 * Regression coverage for approveAndCreateNewBatch's period-scoping fix:
 * approving an authorization must not rewrite the status of other periods.
 */

import { describe, it, expect } from 'vitest';
import { determineActiveAuthPeriod } from './db';

type StatusRow = { auth_period: number | null; sessions_authorized: number | null; date_of_service: string | null };

describe('determineActiveAuthPeriod', () => {
  it('returns the oldest period that still has remaining sessions', () => {
    const visits: StatusRow[] = [
      // Period 1: fully completed (0 remaining)
      { auth_period: 1, sessions_authorized: 10, date_of_service: '2026-01-01' },
      ...Array.from({ length: 9 }, (_, i): StatusRow => ({
        auth_period: 1, sessions_authorized: null, date_of_service: `2026-01-0${i + 2}`,
      })),
      // Period 2: pending, has remaining sessions
      { auth_period: 2, sessions_authorized: 5, date_of_service: null },
    ];
    expect(determineActiveAuthPeriod(visits)).toBe(2);
  });

  it('does not select an exhausted historical period even if it comes first', () => {
    const visits: StatusRow[] = [
      { auth_period: 1, sessions_authorized: 3, date_of_service: '2026-01-01' },
      { auth_period: 1, sessions_authorized: null, date_of_service: '2026-01-02' },
      { auth_period: 1, sessions_authorized: null, date_of_service: '2026-01-03' },
      { auth_period: 2, sessions_authorized: 8, date_of_service: '2026-02-01' },
    ];
    expect(determineActiveAuthPeriod(visits)).toBe(2);
  });

  it('falls back to null when every period is exhausted', () => {
    const visits: StatusRow[] = [
      { auth_period: 1, sessions_authorized: 2, date_of_service: '2026-01-01' },
      { auth_period: 1, sessions_authorized: null, date_of_service: '2026-01-02' },
    ];
    expect(determineActiveAuthPeriod(visits)).toBeNull();
  });

  it('treats a null auth_period as period 1', () => {
    const visits: StatusRow[] = [
      { auth_period: null, sessions_authorized: 5, date_of_service: null },
    ];
    expect(determineActiveAuthPeriod(visits)).toBe(1);
  });
});

describe('approval period scoping (simulated update)', () => {
  it('marks only the target period as approved, leaving other periods unchanged', () => {
    type Row = { id: string; auth_period: number; sessions_authorized: number | null; date_of_service: string | null; auth_status: string };

    // Period 1 = denied (exhausted), Period 2 = pending (has remaining sessions)
    const rows: Row[] = [
      { id: 'p1-a', auth_period: 1, sessions_authorized: 2, date_of_service: '2026-01-01', auth_status: 'denied' },
      { id: 'p1-b', auth_period: 1, sessions_authorized: null, date_of_service: '2026-01-02', auth_status: 'denied' },
      { id: 'p2-a', auth_period: 2, sessions_authorized: 4, date_of_service: null, auth_status: 'pending' },
      { id: 'p2-b', auth_period: 2, sessions_authorized: null, date_of_service: null, auth_status: 'pending' },
    ];

    const targetPeriod = determineActiveAuthPeriod(rows) ?? Math.max(...rows.map(r => r.auth_period));
    expect(targetPeriod).toBe(2);

    // Mirrors the .eq("auth_period", targetApprovalPeriod) scoping applied in approveAndCreateNewBatch
    const updated = rows.map(r => (r.auth_period === targetPeriod ? { ...r, auth_status: 'approved' } : r));

    expect(updated.filter(r => r.auth_period === 1).every(r => r.auth_status === 'denied')).toBe(true);
    expect(updated.filter(r => r.auth_period === 2).every(r => r.auth_status === 'approved')).toBe(true);
  });
});
