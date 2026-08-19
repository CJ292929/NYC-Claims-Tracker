/**
 * server/markAsRequested.periodScope.test.ts
 * Regression coverage for markAsRequested's period-scoping fix: the mutation
 * must target the same active-period row getAuthAlertSummaries/
 * approveAndCreateNewBatch consider active, not just the highest
 * auth_period/session_number row overall.
 */

import { describe, it, expect } from 'vitest';
import { determineMarkAsRequestedTargetRow } from './db';

type Row = {
  id: string;
  auth_period: number | null;
  session_number: number | null;
  sessions_authorized: number | null;
  date_of_service: string | null;
};

describe('determineMarkAsRequestedTargetRow', () => {
  it('CASE A: targets Period 1 when it still has remaining sessions and Period 2 is newer', () => {
    const rows: Row[] = [
      { id: 'p1-a', auth_period: 1, session_number: 1, sessions_authorized: 10, date_of_service: '2026-01-01' },
      { id: 'p1-b', auth_period: 1, session_number: 2, sessions_authorized: null, date_of_service: null },
      { id: 'p2-a', auth_period: 2, session_number: 1, sessions_authorized: 8, date_of_service: null },
      { id: 'p2-b', auth_period: 2, session_number: 2, sessions_authorized: null, date_of_service: null },
    ];

    const target = determineMarkAsRequestedTargetRow(rows);
    expect(target?.id).toBe('p1-b');
    expect(target?.auth_period).toBe(1);
  });

  it('CASE B: targets Period 2 once Period 1 is exhausted', () => {
    const rows: Row[] = [
      { id: 'p1-a', auth_period: 1, session_number: 1, sessions_authorized: 2, date_of_service: '2026-01-01' },
      { id: 'p1-b', auth_period: 1, session_number: 2, sessions_authorized: null, date_of_service: '2026-01-02' },
      { id: 'p2-a', auth_period: 2, session_number: 1, sessions_authorized: 6, date_of_service: null },
      { id: 'p2-b', auth_period: 2, session_number: 2, sessions_authorized: null, date_of_service: null },
    ];

    const target = determineMarkAsRequestedTargetRow(rows);
    expect(target?.id).toBe('p2-b');
    expect(target?.auth_period).toBe(2);
  });

  it('falls back to the latest period when every period is exhausted', () => {
    const rows: Row[] = [
      { id: 'p1-a', auth_period: 1, session_number: 1, sessions_authorized: 2, date_of_service: '2026-01-01' },
      { id: 'p1-b', auth_period: 1, session_number: 2, sessions_authorized: null, date_of_service: '2026-01-02' },
      { id: 'p2-a', auth_period: 2, session_number: 1, sessions_authorized: 3, date_of_service: '2026-02-01' },
      { id: 'p2-b', auth_period: 2, session_number: 2, sessions_authorized: null, date_of_service: '2026-02-02' },
      { id: 'p2-c', auth_period: 2, session_number: 3, sessions_authorized: null, date_of_service: '2026-02-03' },
    ];

    const target = determineMarkAsRequestedTargetRow(rows);
    expect(target?.id).toBe('p2-c');
    expect(target?.auth_period).toBe(2);
  });

  it('returns null when there are no visit rows', () => {
    expect(determineMarkAsRequestedTargetRow([])).toBeNull();
  });
});

describe('mark-requested period scoping (simulated update)', () => {
  it('CASE C & D: writes pending/dateAshSubmitted only to the active-period row, leaving other periods unchanged', () => {
    const rows: (Row & { auth_status: string; date_ash_submitted: string | null })[] = [
      { id: 'p1-a', auth_period: 1, session_number: 1, sessions_authorized: 10, date_of_service: '2026-01-01', auth_status: 'approved', date_ash_submitted: '2026-01-01' },
      { id: 'p1-b', auth_period: 1, session_number: 2, sessions_authorized: null, date_of_service: null, auth_status: 'none', date_ash_submitted: null },
      { id: 'p2-a', auth_period: 2, session_number: 1, sessions_authorized: 8, date_of_service: null, auth_status: 'denied', date_ash_submitted: '2026-02-01' },
    ];

    const target = determineMarkAsRequestedTargetRow(rows);
    expect(target?.id).toBe('p1-b');

    const today = '2026-08-19';
    const updated = rows.map(r =>
      r.id === target?.id ? { ...r, auth_status: 'pending', date_ash_submitted: today } : r,
    );

    // Target row updated
    const targetRow = updated.find(r => r.id === 'p1-b');
    expect(targetRow?.auth_status).toBe('pending');
    expect(targetRow?.date_ash_submitted).toBe(today);

    // Other rows in the SAME active period untouched
    const otherP1Row = updated.find(r => r.id === 'p1-a');
    expect(otherP1Row?.auth_status).toBe('approved');
    expect(otherP1Row?.date_ash_submitted).toBe('2026-01-01');

    // Historical/other-period row completely untouched
    const p2Row = updated.find(r => r.id === 'p2-a');
    expect(p2Row?.auth_status).toBe('denied');
    expect(p2Row?.date_ash_submitted).toBe('2026-02-01');
  });
});
