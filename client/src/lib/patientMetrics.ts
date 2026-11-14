import { deriveAuthPeriodMetrics, getPeriodMetrics, type AuthPeriodVisit } from '@shared/authPeriodMetrics';

export interface PatientMetrics {
  totalAuthorized: number;
  completed: number;
  remaining: number;
  activePeriod: number | null;
  /** P4-P31: the period these totals describe was manually marked Expired. */
  expired: boolean;
  /** P4-P31: sessions left unused when it expired (history only; `remaining` stays 0). */
  unusedExpired: number;
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
  if (patientVisits.length === 0) return { totalAuthorized: 0, completed: 0, remaining: 0, activePeriod: null, expired: false, unusedExpired: 0 };

  const { periods, activePeriod, activeMetrics } = deriveAuthPeriodMetrics(patientVisits);

  if (activePeriod === null) {
    const latestPeriod = periods[periods.length - 1];
    const latestMetrics = getPeriodMetrics(patientVisits, latestPeriod);
    return {
      totalAuthorized: latestMetrics.authorized,
      completed: latestMetrics.completed,
      remaining: 0,
      activePeriod: null,
      expired: latestMetrics.expired,
      unusedExpired: latestMetrics.unusedExpired,
    };
  }

  return {
    totalAuthorized: activeMetrics.authorized,
    completed: activeMetrics.completed,
    remaining: activeMetrics.remaining,
    activePeriod,
    expired: false,
    unusedExpired: 0,
  };
}
