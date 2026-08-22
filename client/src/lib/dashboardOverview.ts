import type { AuthorizationOverviewRecord } from './authorizationOverview';
import { deriveAuthorizationOverviewMetrics } from './authorizationOverview';

export interface DashboardKpis {
  activePatients: number;
  authorizationAttention: number;
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
  return {
    activePatients: params.activePatientCount,
    authorizationAttention: deriveAuthorizationOverviewMetrics(params.authAlerts).needsAttention,
    claimsFollowUp: params.followUpClaimCount,
    completedPatients: params.completedPatientCount,
  };
}
