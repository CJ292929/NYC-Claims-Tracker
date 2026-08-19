import { deriveAuthPeriodMetrics, getPeriodMetrics, type AuthPeriodVisit } from '@shared/authPeriodMetrics';

export interface PatientMetrics {
  totalAuthorized: number;
  completed: number;
  remaining: number;
  activePeriod: number | null;
}

/**
 * Client adapter over the shared authorization-period math. Delegates
 * active-period selection and authorized/completed/remaining to
 * shared/authPeriodMetrics.ts (kept in sync with server/db.ts); the
 * "all periods exhausted" display fallback (show the latest period's
 * totals instead of zeros) is client display behavior, not core period
 * math, so it stays here rather than in the shared helper.
 */
export function getPatientMetrics(patientVisits: AuthPeriodVisit[]): PatientMetrics {
  if (patientVisits.length === 0) return { totalAuthorized: 0, completed: 0, remaining: 0, activePeriod: null };

  const { periods, activePeriod, activeMetrics } = deriveAuthPeriodMetrics(patientVisits);

  if (activePeriod === null) {
    const latestPeriod = periods[periods.length - 1];
    const latestMetrics = getPeriodMetrics(patientVisits, latestPeriod);
    return { totalAuthorized: latestMetrics.authorized, completed: latestMetrics.completed, remaining: 0, activePeriod: null };
  }

  return { totalAuthorized: activeMetrics.authorized, completed: activeMetrics.completed, remaining: activeMetrics.remaining, activePeriod };
}
