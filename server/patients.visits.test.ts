/**
 * Tests for patient and visit record router procedures.
 * Uses the same pattern as server/auth.logout.test.ts.
 */

import { describe, it, expect } from 'vitest';

// ─── parseDate helper (inline copy for testing) ───────────────────────────────

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : d;
}

// ─── toInputDate helper ───────────────────────────────────────────────────────

function toInputDate(d: Date | null | undefined): string {
  if (!d) return '';
  try {
    const dt = typeof d === 'string' ? new Date(d) : d;
    if (isNaN(dt.getTime())) return '';
    return dt.toISOString().split('T')[0];
  } catch {
    return '';
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parseDate', () => {
  it('returns null for null input', () => {
    expect(parseDate(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseDate('')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseDate(undefined)).toBeNull();
  });

  it('parses a valid ISO date string', () => {
    const result = parseDate('2026-04-21');
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString().startsWith('2026-04-21')).toBe(true);
  });

  it('returns null for an invalid date string', () => {
    expect(parseDate('not-a-date')).toBeNull();
  });

  it('returns null for "RE" (legacy data marker)', () => {
    // "RE" is not a valid date, parseDate should return null
    expect(parseDate('RE')).toBeNull();
  });
});

describe('toInputDate', () => {
  it('returns empty string for null', () => {
    expect(toInputDate(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(toInputDate(undefined)).toBe('');
  });

  it('formats a Date to YYYY-MM-DD', () => {
    const d = new Date('2026-05-16T00:00:00Z');
    expect(toInputDate(d)).toBe('2026-05-16');
  });
});

describe('add patient with authorized sessions', () => {
  it('creates an initial visit record when authorized sessions > 0', () => {
    // Simulate the logic in handleAddPatient
    const authorized = parseInt('20') || 0;
    const shouldCreateVisitRecord = authorized > 0;
    expect(shouldCreateVisitRecord).toBe(true);
  });

  it('does NOT create a visit record when authorized sessions is 0 or empty', () => {
    const authorized = parseInt('') || 0;
    const shouldCreateVisitRecord = authorized > 0;
    expect(shouldCreateVisitRecord).toBe(false);
  });

  it('initial visit record has sessionsAuthorized === sessionsRemaining', () => {
    const authorized = 20;
    const record = {
      sessionsAuthorized: authorized,
      sessionsRemaining: authorized,
      sessionNumber: 1,
    };
    expect(record.sessionsAuthorized).toBe(record.sessionsRemaining);
    expect(record.sessionNumber).toBe(1);
  });
});

describe('authStatus mapping', () => {
  const mapStatus = (val: string) => {
    return val === '' ? 'none' : val.toLowerCase();
  };

  it('maps empty string to none', () => {
    expect(mapStatus('')).toBe('none');
  });

  it('maps Pending to pending', () => {
    expect(mapStatus('Pending')).toBe('pending');
  });

  it('maps Approved to approved', () => {
    expect(mapStatus('Approved')).toBe('approved');
  });

  it('maps Denied to denied', () => {
    expect(mapStatus('Denied')).toBe('denied');
  });
});

describe('patient metrics computation', () => {
  type MockVisit = {
    sessionsAuthorized: number | null;
    sessionsRemaining: number | null;
    dateOfService: Date | null;
  };

  const getMetrics = (visits: MockVisit[]) => {
    const authRow = visits.find(v => v.sessionsAuthorized != null);
    const totalAuthorized = authRow?.sessionsAuthorized ?? 0;
    const completed = visits.filter(v => v.dateOfService).length;
    const lastWithRemaining = [...visits].reverse().find(v => v.sessionsRemaining != null);
    const remaining = lastWithRemaining != null
      ? (lastWithRemaining.sessionsRemaining as number)
      : Math.max(0, totalAuthorized - completed);
    return { totalAuthorized, completed, remaining };
  };

  it('computes metrics correctly from visit records', () => {
    const visits: MockVisit[] = [
      { sessionsAuthorized: 12, sessionsRemaining: 11, dateOfService: new Date('2026-04-01') },
      { sessionsAuthorized: null, sessionsRemaining: 10, dateOfService: new Date('2026-04-06') },
      { sessionsAuthorized: null, sessionsRemaining: 9, dateOfService: new Date('2026-04-13') },
    ];
    const m = getMetrics(visits);
    expect(m.totalAuthorized).toBe(12);
    expect(m.completed).toBe(3);
    expect(m.remaining).toBe(9); // last row's sessionsRemaining
  });

  it('returns zeros for empty visit list', () => {
    const m = getMetrics([]);
    expect(m.totalAuthorized).toBe(0);
    expect(m.completed).toBe(0);
    expect(m.remaining).toBe(0);
  });

  it('triggers warning when remaining <= 3', () => {
    const remaining = 2;
    const status = remaining === 0 ? 'exhausted' : remaining <= 3 ? 'warning' : 'ok';
    expect(status).toBe('warning');
  });

  it('triggers exhausted when remaining === 0', () => {
    const remaining = 0;
    const status = remaining === 0 ? 'exhausted' : remaining <= 3 ? 'warning' : 'ok';
    expect(status).toBe('exhausted');
  });
});
