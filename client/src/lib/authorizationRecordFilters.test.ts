import { describe, it, expect } from 'vitest';
import {
  matchesAuthorizationRecordFilters,
  sortAuthorizationRecords,
  getCompletedSessions,
  getAuthorizationActivity,
  formatAuthPeriod,
  type AuthorizationRecord,
} from './authorizationRecordFilters';

const record = (overrides: Partial<AuthorizationRecord> = {}): AuthorizationRecord => ({
  patientId: '1',
  patientName: 'Doe, Jane',
  insurance: 'Aetna',
  sessionsAuthorized: 20,
  sessionsRemaining: 10,
  authStatus: 'approved',
  urgency: 'ok',
  ...overrides,
});

const baseScope = { search: '', insurance: '', authStatus: 'all', urgency: 'all', activity: 'all' };

describe('getCompletedSessions', () => {
  it('computes authorized minus remaining', () => {
    expect(getCompletedSessions(20, 10)).toBe(10);
  });

  it('floors at 0 instead of going negative', () => {
    expect(getCompletedSessions(5, 8)).toBe(0);
  });

  it('treats missing remaining as 0 completed sessions used', () => {
    expect(getCompletedSessions(5, null)).toBe(5);
  });

  it('returns null when authorized is unknown', () => {
    expect(getCompletedSessions(null, 10)).toBeNull();
    expect(getCompletedSessions(null, null)).toBeNull();
  });
});

describe('getAuthorizationActivity', () => {
  it('is active when sessions remain', () => {
    expect(getAuthorizationActivity(5)).toBe('active');
  });

  it('is exhausted at exactly 0', () => {
    expect(getAuthorizationActivity(0)).toBe('exhausted');
  });

  it('is null (unknown) when remaining is null', () => {
    expect(getAuthorizationActivity(null)).toBeNull();
  });
});

describe('formatAuthPeriod', () => {
  it('formats a known period', () => {
    expect(formatAuthPeriod(2)).toBe('Period 2');
  });

  it('shows an em dash for null (no visit history yet)', () => {
    expect(formatAuthPeriod(null)).toBe('—');
  });
});

describe('matchesAuthorizationRecordFilters', () => {
  it('matches everyone with the default all-open scope', () => {
    expect(matchesAuthorizationRecordFilters(record(), baseScope)).toBe(true);
  });

  it('filters by search against patient name, case-insensitively', () => {
    expect(matchesAuthorizationRecordFilters(record({ patientName: 'Doe, Jane' }), { ...baseScope, search: 'doe' })).toBe(true);
    expect(matchesAuthorizationRecordFilters(record({ patientName: 'Doe, Jane' }), { ...baseScope, search: 'smith' })).toBe(false);
  });

  it('filters by insurance', () => {
    expect(matchesAuthorizationRecordFilters(record({ insurance: 'Aetna' }), { ...baseScope, insurance: 'Aetna' })).toBe(true);
    expect(matchesAuthorizationRecordFilters(record({ insurance: 'Cigna Healthcare' }), { ...baseScope, insurance: 'Aetna' })).toBe(false);
  });

  it('filters by auth status', () => {
    expect(matchesAuthorizationRecordFilters(record({ authStatus: 'pending' }), { ...baseScope, authStatus: 'pending' })).toBe(true);
    expect(matchesAuthorizationRecordFilters(record({ authStatus: 'approved' }), { ...baseScope, authStatus: 'pending' })).toBe(false);
  });

  it('filters by urgency', () => {
    expect(matchesAuthorizationRecordFilters(record({ urgency: 'critical' }), { ...baseScope, urgency: 'critical' })).toBe(true);
    expect(matchesAuthorizationRecordFilters(record({ urgency: 'ok' }), { ...baseScope, urgency: 'critical' })).toBe(false);
  });

  it('filters by activity', () => {
    expect(matchesAuthorizationRecordFilters(record({ sessionsRemaining: 3 }), { ...baseScope, activity: 'active' })).toBe(true);
    expect(matchesAuthorizationRecordFilters(record({ sessionsRemaining: 0 }), { ...baseScope, activity: 'active' })).toBe(false);
    expect(matchesAuthorizationRecordFilters(record({ sessionsRemaining: 0 }), { ...baseScope, activity: 'exhausted' })).toBe(true);
    expect(matchesAuthorizationRecordFilters(record({ sessionsRemaining: null }), { ...baseScope, activity: 'active' })).toBe(false);
    expect(matchesAuthorizationRecordFilters(record({ sessionsRemaining: null }), { ...baseScope, activity: 'exhausted' })).toBe(false);
  });

  it('AND-combines every active filter', () => {
    const r = record({ patientName: 'Doe, Jane', insurance: 'Aetna', authStatus: 'pending', urgency: 'warning', sessionsRemaining: 3 });
    const matchingScope = { search: 'jane', insurance: 'Aetna', authStatus: 'pending', urgency: 'warning', activity: 'active' };
    expect(matchesAuthorizationRecordFilters(r, matchingScope)).toBe(true);
    expect(matchesAuthorizationRecordFilters(r, { ...matchingScope, insurance: 'Cigna Healthcare' })).toBe(false);
  });
});

describe('sortAuthorizationRecords', () => {
  it('orders by urgency severity: denied, exhausted, critical, warning, pending, ok', () => {
    const records = [
      { patientName: 'Z', urgency: 'ok' as const },
      { patientName: 'Y', urgency: 'pending' as const },
      { patientName: 'X', urgency: 'denied' as const },
      { patientName: 'W', urgency: 'exhausted' as const },
      { patientName: 'V', urgency: 'critical' as const },
      { patientName: 'U', urgency: 'warning' as const },
    ];
    const sorted = sortAuthorizationRecords(records).map(r => r.urgency);
    expect(sorted).toEqual(['denied', 'exhausted', 'critical', 'warning', 'pending', 'ok']);
  });

  it('breaks ties alphabetically by patient name within the same urgency', () => {
    const records = [
      { patientName: 'Zeta', urgency: 'critical' as const },
      { patientName: 'Alpha', urgency: 'critical' as const },
      { patientName: 'Mid', urgency: 'critical' as const },
    ];
    const sorted = sortAuthorizationRecords(records).map(r => r.patientName);
    expect(sorted).toEqual(['Alpha', 'Mid', 'Zeta']);
  });

  it('does not mutate the input array', () => {
    const records = [{ patientName: 'B', urgency: 'ok' as const }, { patientName: 'A', urgency: 'denied' as const }];
    const original = [...records];
    sortAuthorizationRecords(records);
    expect(records).toEqual(original);
  });
});
