import type { AuthorizationOverviewRecord } from './authorizationOverview';
import { deriveAuthorizationOverviewMetrics } from './authorizationOverview';

export interface DashboardKpis {
  activePatients: number;
  authorizationAttention: number;
  /** "Pending Authorization Request": requests deliberately put on hold
   *  (hold effective on the current period) — the exact rows Authorization
   *  Attention excludes. Same classifier, so the two never overlap. */
  pendingAuthorizationRequest: number;
  claimsFollowUp: number;
  completedPatients: number;
}

/**
 * Pure clinic-wide KPI rollup for the main Dashboard overview.
 *
 * Every input here is already clinic-wide — not scoped to the Insurance/
 * Claims Status UI filters, and not derived from any selected-patient state.
 * There is deliberately no selectedPatientId/activePatient parameter: the
 * Dashboard's clinic KPIs must read the same regardless of which patient (if
 * any) happens to be selected elsewhere in the app.
 */
export function deriveDashboardKpis(params: {
  activePatientCount: number;
  authAlerts: AuthorizationOverviewRecord[];
  followUpClaimCount: number;
  completedPatientCount: number;
}): DashboardKpis {
  const auth = deriveAuthorizationOverviewMetrics(params.authAlerts);
  return {
    activePatients: params.activePatientCount,
    authorizationAttention: auth.needsAttention,
    pendingAuthorizationRequest: auth.onHold,
    claimsFollowUp: params.followUpClaimCount,
    completedPatients: params.completedPatientCount,
  };
}
