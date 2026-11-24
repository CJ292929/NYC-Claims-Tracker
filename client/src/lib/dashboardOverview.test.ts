import { describe, it, expect } from 'vitest';
import { deriveDashboardKpis } from './dashboardOverview';
import type { AuthorizationOverviewRecord } from './authorizationOverview';

const alert = (overrides: Partial<AuthorizationOverviewRecord> = {}): AuthorizationOverviewRecord => ({
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

describe('deriveDashboardKpis', () => {
  it('A: no records -> all counts 0', () => {
    const kpis = deriveDashboardKpis({
      activePatientCount: 0,
      authAlerts: [],
      followUpClaimCount: 0,
      completedPatientCount: 0,
    });
    expect(kpis).toEqual({
      activePatients: 0,
      authorizationAttention: 0,
      pendingAuthorizationRequest: 0,
      claimsFollowUp: 0,
      completedPatients: 0,
    });
  });

  it('B: active patients count passes through unchanged', () => {
    const kpis = deriveDashboardKpis({
      activePatientCount: 5,
      authAlerts: [],
      followUpClaimCount: 0,
      completedPatientCount: 0,
    });
    expect(kpis.activePatients).toBe(5);
  });

  it('C: only non-ok auth alerts count toward authorizationAttention', () => {
    const kpis = deriveDashboardKpis({
      activePatientCount: 0,
      authAlerts: [
        alert({ patientId: '1', urgency: 'ok' }),
        alert({ patientId: '2', urgency: 'ok' }),
        alert({ patientId: '3', urgency: 'critical' }),
        alert({ patientId: '4', urgency: 'pending' }),
        alert({ patientId: '5', urgency: 'denied' }),
      ],
      followUpClaimCount: 0,
      completedPatientCount: 0,
    });
    expect(kpis.authorizationAttention).toBe(3);
  });

  it('D: claims follow-up count passes through unchanged', () => {
    const kpis = deriveDashboardKpis({
      activePatientCount: 0,
      authAlerts: [],
      followUpClaimCount: 4,
      completedPatientCount: 0,
    });
    expect(kpis.claimsFollowUp).toBe(4);
  });

  it('E: completed patients count passes through unchanged', () => {
    const kpis = deriveDashboardKpis({
      activePatientCount: 0,
      authAlerts: [],
      followUpClaimCount: 0,
      completedPatientCount: 7,
    });
    expect(kpis.completedPatients).toBe(7);
  });

  it('F: mixed data produces the full expected KPI set', () => {
    const kpis = deriveDashboardKpis({
      activePatientCount: 42,
      authAlerts: [
        alert({ patientId: '1', urgency: 'ok' }),
        alert({ patientId: '2', urgency: 'exhausted' }),
        alert({ patientId: '3', urgency: 'warning' }),
      ],
      followUpClaimCount: 6,
      completedPatientCount: 9,
    });
    expect(kpis).toEqual({
      activePatients: 42,
      authorizationAttention: 2,
      pendingAuthorizationRequest: 0,
      claimsFollowUp: 6,
      completedPatients: 9,
    });
  });

  // G: deriveDashboardKpis has no selectedPatientId/activePatient parameter
  // by design — clinic KPI results are a pure function of clinic-wide counts
  // only, so they structurally cannot vary based on which patient (if any)
  // is selected elsewhere in the app. Calling it twice with identical
  // clinic-wide inputs — as would happen regardless of selection state —
  // must yield identical results.
  it('G: identical clinic-wide inputs yield identical results regardless of call site', () => {
    const input = {
      activePatientCount: 10,
      authAlerts: [alert({ urgency: 'denied' })],
      followUpClaimCount: 2,
      completedPatientCount: 1,
    };
    expect(deriveDashboardKpis(input)).toEqual(deriveDashboardKpis(input));
  });
});

describe('Pending Authorization Request KPI (held requests)', () => {
  const hold = (authPeriod: number | null) => ({ holdId: 'h', authPeriod, reason: 'Waiting on referral', heldAt: '2026-11-20T15:00:00Z', heldByDisplay: 'Synthetic Staff' });
  const base = { activePatientCount: 0, followUpClaimCount: 0, completedPatientCount: 0 };

  it('a hold moves a row from Authorization Attention into Pending Authorization Request', () => {
    const before = deriveDashboardKpis({ ...base, authAlerts: [alert({ urgency: 'pending' })] });
    expect([before.authorizationAttention, before.pendingAuthorizationRequest]).toEqual([1, 0]);
    const held = deriveDashboardKpis({ ...base, authAlerts: [alert({ urgency: 'pending', hold: hold(1) })] });
    expect([held.authorizationAttention, held.pendingAuthorizationRequest]).toEqual([0, 1]);
  });

  it('resume (hold removed) recalculates: back in Attention only while still eligible', () => {
    expect(deriveDashboardKpis({ ...base, authAlerts: [alert({ urgency: 'pending', hold: null })] }).authorizationAttention).toBe(1);
    const ok = deriveDashboardKpis({ ...base, authAlerts: [alert({ urgency: 'ok', hold: null })] });
    expect([ok.authorizationAttention, ok.pendingAuthorizationRequest]).toEqual([0, 0]);
  });

  it('a superseded hold (newer period) is not counted as pending and no longer hides the alert', () => {
    const k = deriveDashboardKpis({ ...base, authAlerts: [alert({ authPeriod: 2, urgency: 'critical', hold: hold(1) })] });
    expect([k.authorizationAttention, k.pendingAuthorizationRequest]).toEqual([1, 0]);
  });
});
