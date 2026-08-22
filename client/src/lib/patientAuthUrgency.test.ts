import { describe, it, expect } from 'vitest';
import { derivePatientAlertPresentation, type AuthUrgencyVisit } from './patientAuthUrgency';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-01-15T00:00:00.000Z');

function ms(offsetDays: number): number {
  return NOW.getTime() + offsetDays * DAY_MS;
}

function visit(
  authPeriod: number | null,
  sessionsAuthorized: number | null,
  dateOfService: unknown,
  authStatus: string | null = null,
): AuthUrgencyVisit {
  return { authPeriod, sessionsAuthorized, dateOfService, authStatus };
}

describe('derivePatientAlertPresentation: core matrix', () => {
  it('CASE A: remaining 0, approved => exhausted', () => {
    const visits = [visit(1, 10, '2026-01-01', 'approved'), visit(1, null, '2026-01-02', 'approved')];
    const result = derivePatientAlertPresentation(visits, 0, null, NOW);
    expect(result.urgency).toBe('exhausted');
    expect(result.label).toBe('Sessions Exhausted');
  });

  it('CASE B: remaining 1, approved => critical', () => {
    const visits = [visit(1, 10, '2026-01-01', 'approved')];
    const result = derivePatientAlertPresentation(visits, 1, null, NOW);
    expect(result.urgency).toBe('critical');
    expect(result.label).toBe('Critical — 1-2 Sessions Left');
  });

  it('CASE C: remaining 2, approved => critical', () => {
    const visits = [visit(1, 10, '2026-01-01', 'approved')];
    const result = derivePatientAlertPresentation(visits, 2, null, NOW);
    expect(result.urgency).toBe('critical');
  });

  it('CASE D: remaining 3, approved => warning', () => {
    const visits = [visit(1, 10, '2026-01-01', 'approved')];
    const result = derivePatientAlertPresentation(visits, 3, null, NOW);
    expect(result.urgency).toBe('warning');
    expect(result.label).toBe('Warning — 3 Sessions Left');
  });

  it('CASE E: remaining 8, pending => pending', () => {
    const visits = [visit(1, 10, '2026-01-01', 'pending')];
    const result = derivePatientAlertPresentation(visits, 8, null, NOW);
    expect(result.urgency).toBe('pending');
    expect(result.label).toBe('Authorization Pending');
  });

  it('CASE F: remaining 8, denied => denied', () => {
    const visits = [visit(1, 10, '2026-01-01', 'denied')];
    const result = derivePatientAlertPresentation(visits, 8, null, NOW);
    expect(result.urgency).toBe('denied');
    expect(result.label).toBe('Authorization Denied');
    // Regression: denied with sessions remaining must never render as exhausted.
    expect(result.label).not.toBe('Sessions Exhausted');
  });

  it('CASE G: remaining 8, approved, expiry in 3 days => warning + expiry presentation', () => {
    const visits = [visit(1, 10, '2026-01-01', 'approved')];
    const result = derivePatientAlertPresentation(visits, 8, ms(3), NOW);
    expect(result.urgency).toBe('warning');
    expect(result.authExpiryWarning).toBe(true);
    expect(result.label).toBe('Auth Expiring Soon');
  });

  it('CASE H: remaining 8, approved, expired => warning + expiry presentation', () => {
    const visits = [visit(1, 10, '2026-01-01', 'approved')];
    const result = derivePatientAlertPresentation(visits, 8, ms(-3), NOW);
    expect(result.urgency).toBe('warning');
    expect(result.authExpiryWarning).toBe(true);
    expect(result.label).toBe('Auth Expiring Soon');
  });

  it('CASE I: remaining 8, approved, no expiry => ok', () => {
    const visits = [visit(1, 10, '2026-01-01', 'approved')];
    const result = derivePatientAlertPresentation(visits, 8, null, NOW);
    expect(result.urgency).toBe('ok');
    expect(result.label).toBe('On Track');
  });
});

describe('derivePatientAlertPresentation: multi-period authStatus lookup', () => {
  it('CASE J: period 1 active (pending), period 2 newer exists (approved) => uses period 1 pending', () => {
    const visits = [
      visit(1, 10, '2026-01-01', 'pending'),
      visit(1, null, null, 'pending'),
      visit(2, 10, null, 'approved'),
    ];
    // remaining is derived independently in Dashboard.tsx via getPatientMetrics;
    // here we pass the value that corresponds to period 1 being active (9 remaining).
    const result = derivePatientAlertPresentation(visits, 9, null, NOW);
    expect(result.urgency).toBe('pending');
  });

  it('CASE K: period 1 exhausted, period 2 active (pending) => uses period 2 pending', () => {
    const visits = [
      visit(1, 2, '2026-01-01', 'approved'),
      visit(1, null, '2026-01-02', 'approved'),
      visit(2, 10, null, 'pending'),
    ];
    const result = derivePatientAlertPresentation(visits, 10, null, NOW);
    expect(result.urgency).toBe('pending');
  });

  // With remaining: 0 (the real value getPatientMetrics reports once every
  // period is exhausted), deriveAuthorizationUrgency forces "exhausted"
  // regardless of authStatus — remaining=0 short-circuits before authStatus
  // is even consulted. To actually prove the status lookup targets the
  // latest period (server parity) rather than period 1, these two cases pass
  // an artificial non-exhausted remaining so authStatus's effect is
  // observable; production always pairs this fallback with remaining: 0.
  it('CASE L: all periods exhausted => authStatus resolved from latest period, not period 1', () => {
    const visits = [
      visit(1, 2, '2026-01-01', 'denied'),
      visit(1, null, '2026-01-02', 'denied'),
      visit(2, 3, '2026-02-01', 'pending'),
      visit(2, null, '2026-02-02', 'pending'),
      visit(2, null, '2026-02-03', 'pending'),
    ];
    const result = derivePatientAlertPresentation(visits, 8, null, NOW);
    // If period 1 ("denied") were used instead, this would be "exhausted".
    expect(result.urgency).toBe('pending');
  });

  it('CASE L2: same fallback with statuses swapped confirms the same targeting', () => {
    const visits = [
      visit(1, 2, '2026-01-01', 'pending'),
      visit(1, null, '2026-01-02', 'pending'),
      visit(2, 3, '2026-02-01', 'denied'),
      visit(2, null, '2026-02-02', 'denied'),
      visit(2, null, '2026-02-03', 'denied'),
    ];
    const result = derivePatientAlertPresentation(visits, 8, null, NOW);
    // If period 1 ("pending") were used instead, this would be "pending".
    expect(result.urgency).toBe('denied');
  });

  it('CASE M: stored sessionsRemaining is irrelevant — urgency depends only on the passed-in derived remaining', () => {
    const visits = [visit(1, 10, '2026-01-01', 'approved')];
    const withStale = visits.map(v => ({ ...v, sessionsRemaining: 999 }));
    const result = derivePatientAlertPresentation(withStale, 1, null, NOW);
    expect(result.urgency).toBe('critical');
  });
});

describe('derivePatientAlertPresentation: no visits', () => {
  it('empty visits => authStatus null, urgency derived from remaining alone', () => {
    const result = derivePatientAlertPresentation([], 0, null, NOW);
    expect(result.urgency).toBe('exhausted');
  });
});
