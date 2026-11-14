import { describe, it, expect } from 'vitest';
import {
  deriveAuthorizationOverviewMetrics,
  getTopAuthorizationAttention,
  type AuthorizationOverviewRecord,
} from './authorizationOverview';

const record = (overrides: Partial<AuthorizationOverviewRecord> = {}): AuthorizationOverviewRecord => ({
  patientId: '1',
  patientName: 'Doe, Jane',
  insurance: 'Aetna',
  authPeriod: 1,
  sessionsAuthorized: 20,
  sessionsRemaining: 10,
  authStatus: 'approved',
  authValidUntil: null,
  urgency: 'ok',
  authExpiryWarning: false,
  ...overrides,
});

describe('deriveAuthorizationOverviewMetrics', () => {
  it('A: all records ok -> needsAttention is 0', () => {
    const metrics = deriveAuthorizationOverviewMetrics([
      record({ patientId: '1', urgency: 'ok' }),
      record({ patientId: '2', urgency: 'ok' }),
    ]);
    expect(metrics.needsAttention).toBe(0);
    expect(metrics.urgencyDistribution.ok).toBe(2);
  });

  it('B: pending urgency increments pending + needsAttention', () => {
    const metrics = deriveAuthorizationOverviewMetrics([record({ urgency: 'pending', authStatus: 'pending' })]);
    expect(metrics.pending).toBe(1);
    expect(metrics.needsAttention).toBe(1);
  });

  it('C: denied urgency increments denied + needsAttention', () => {
    const metrics = deriveAuthorizationOverviewMetrics([record({ urgency: 'denied', authStatus: 'denied' })]);
    expect(metrics.denied).toBe(1);
    expect(metrics.needsAttention).toBe(1);
  });

  it('D: critical urgency increments critical + needsAttention', () => {
    const metrics = deriveAuthorizationOverviewMetrics([record({ urgency: 'critical' })]);
    expect(metrics.critical).toBe(1);
    expect(metrics.needsAttention).toBe(1);
  });

  it('E: exhausted urgency increments exhausted + needsAttention', () => {
    const metrics = deriveAuthorizationOverviewMetrics([record({ urgency: 'exhausted' })]);
    expect(metrics.exhausted).toBe(1);
    expect(metrics.needsAttention).toBe(1);
  });

  it('F: authExpiryWarning true increments expiring', () => {
    const metrics = deriveAuthorizationOverviewMetrics([
      record({ urgency: 'warning', authExpiryWarning: true }),
    ]);
    expect(metrics.expiring).toBe(1);
    // warning isn't one of the named KPI buckets, but it does count toward attention
    expect(metrics.needsAttention).toBe(1);
  });

  it('does not count expiring when authExpiryWarning is false or absent', () => {
    const metrics = deriveAuthorizationOverviewMetrics([
      record({ authExpiryWarning: false }),
      record({ patientId: '2', authExpiryWarning: undefined }),
    ]);
    expect(metrics.expiring).toBe(0);
  });

  it('G: mixed records produce correct totals across all buckets', () => {
    const metrics = deriveAuthorizationOverviewMetrics([
      record({ patientId: '1', urgency: 'ok', authStatus: 'approved' }),
      record({ patientId: '2', urgency: 'pending', authStatus: 'pending' }),
      record({ patientId: '3', urgency: 'denied', authStatus: 'denied' }),
      record({ patientId: '4', urgency: 'critical', authStatus: 'approved' }),
      record({ patientId: '5', urgency: 'exhausted', authStatus: 'approved' }),
      record({ patientId: '6', urgency: 'warning', authStatus: 'none', authExpiryWarning: true }),
    ]);
    expect(metrics.totalRecords).toBe(6);
    expect(metrics.needsAttention).toBe(5);
    expect(metrics.pending).toBe(1);
    expect(metrics.denied).toBe(1);
    expect(metrics.critical).toBe(1);
    expect(metrics.exhausted).toBe(1);
    expect(metrics.expiring).toBe(1);
    expect(metrics.statusDistribution).toEqual({ none: 1, pending: 1, approved: 3, denied: 1 });
    expect(metrics.urgencyDistribution).toEqual({
      denied: 1, expired: 0, exhausted: 1, critical: 1, warning: 1, pending: 1, ok: 1,
    });
  });
});

describe('getTopAuthorizationAttention', () => {
  it('H: sorts by urgency priority: denied, exhausted, critical, warning, pending, ok', () => {
    const records = [
      record({ patientId: '1', patientName: 'Z', urgency: 'ok' }),
      record({ patientId: '2', patientName: 'Y', urgency: 'pending' }),
      record({ patientId: '3', patientName: 'X', urgency: 'denied' }),
      record({ patientId: '4', patientName: 'W', urgency: 'exhausted' }),
      record({ patientId: '5', patientName: 'V', urgency: 'critical' }),
      record({ patientId: '6', patientName: 'U', urgency: 'warning' }),
    ];
    const top = getTopAuthorizationAttention(records, 10).map(r => r.urgency);
    expect(top).toEqual(['denied', 'exhausted', 'critical', 'warning', 'pending']);
  });

  it('excludes ok records entirely', () => {
    const records = [record({ patientId: '1', urgency: 'ok' })];
    expect(getTopAuthorizationAttention(records)).toEqual([]);
  });

  it('I: truncates to the requested limit, keeping highest priority first', () => {
    const records = [
      record({ patientId: '1', patientName: 'A', urgency: 'pending' }),
      record({ patientId: '2', patientName: 'B', urgency: 'denied' }),
      record({ patientId: '3', patientName: 'C', urgency: 'critical' }),
      record({ patientId: '4', patientName: 'D', urgency: 'exhausted' }),
      record({ patientId: '5', patientName: 'E', urgency: 'warning' }),
    ];
    const top = getTopAuthorizationAttention(records, 3);
    expect(top).toHaveLength(3);
    expect(top.map(r => r.urgency)).toEqual(['denied', 'exhausted', 'critical']);
  });

  it('defaults to a limit of 5', () => {
    const records = Array.from({ length: 8 }, (_, i) =>
      record({ patientId: String(i), patientName: `P${i}`, urgency: 'critical' }));
    expect(getTopAuthorizationAttention(records)).toHaveLength(5);
  });
});
