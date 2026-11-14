// Pure authorization-period metrics primitives. No React, no Supabase, no
// server/client dependencies — safe to import from either side of the
// client/server boundary. Mirrors the active-period rule used by
// server/db.ts (determineActiveAuthPeriod / getAuthAlertSummaries) and
// client/src/pages/Dashboard.tsx (getPatientMetrics): the oldest period
// whose authorized minus completed is still > 0, or null once every period
// is exhausted.
//
// P4-P31: a period is EXPIRED when any of its rows has auth_status
// 'expired'. Expired is only ever set manually (never inferred from dates or
// a zero balance). An expired period keeps its authorized and completed
// counts as history, reports its leftover sessions as `unusedExpired`, and
// reports `remaining` 0 — those sessions are no longer available, so an
// expired period is never the active one.

export interface AuthPeriodVisit {
  authPeriod: number | null;
  sessionsAuthorized: number | null;
  dateOfService: unknown;
  /** Optional so callers that never read status keep compiling; without it a period is never expired. */
  authStatus?: string | null;
}

export interface AuthPeriodMetrics {
  authorized: number;
  completed: number;
  /** Sessions still available. Always 0 for an expired period. */
  remaining: number;
  expired: boolean;
  /** Sessions authorized but never used before the period expired (history only, never available). 0 unless expired. */
  unusedExpired: number;
}

export const EXPIRED_AUTH_STATUS = 'expired';

export interface AuthPeriodSummary {
  periods: number[];
  activePeriod: number | null;
  activeMetrics: AuthPeriodMetrics;
}

function normalizePeriod(visit: AuthPeriodVisit): number {
  return visit.authPeriod ?? 1;
}

function getSortedUniquePeriods(visits: AuthPeriodVisit[]): number[] {
  return Array.from(new Set(visits.map(normalizePeriod))).sort((a, b) => a - b);
}

export function getPeriodMetrics(visits: AuthPeriodVisit[], period: number): AuthPeriodMetrics {
  const periodVisits = visits.filter(v => normalizePeriod(v) === period);
  const authRow = periodVisits.find(v => v.sessionsAuthorized != null);
  const authorized = authRow?.sessionsAuthorized ?? 0;
  const completed = periodVisits.filter(v => v.dateOfService != null).length;
  const leftover = Math.max(0, authorized - completed);
  const expired = periodVisits.some(v => v.authStatus === EXPIRED_AUTH_STATUS);

  return {
    authorized,
    completed,
    remaining: expired ? 0 : leftover,
    expired,
    unusedExpired: expired ? leftover : 0,
  };
}

export function isPeriodExpired(visits: AuthPeriodVisit[], period: number): boolean {
  return visits.some(v => normalizePeriod(v) === period && v.authStatus === EXPIRED_AUTH_STATUS);
}

export function determineActivePeriod(visits: AuthPeriodVisit[]): number | null {
  const periods = getSortedUniquePeriods(visits);

  for (const period of periods) {
    if (getPeriodMetrics(visits, period).remaining > 0) return period;
  }

  return null;
}

export function deriveAuthPeriodMetrics(visits: AuthPeriodVisit[]): AuthPeriodSummary {
  const periods = getSortedUniquePeriods(visits);
  const activePeriod = determineActivePeriod(visits);
  const activeMetrics = activePeriod != null
    ? getPeriodMetrics(visits, activePeriod)
    : { authorized: 0, completed: 0, remaining: 0, expired: false, unusedExpired: 0 };

  return { periods, activePeriod, activeMetrics };
}

/** P4-P31: whether the patient's newest period was manually marked Expired. */
export function isLatestPeriodExpired(visits: AuthPeriodVisit[]): boolean {
  const periods = getSortedUniquePeriods(visits);
  if (periods.length === 0) return false;
  return isPeriodExpired(visits, periods[periods.length - 1]);
}
