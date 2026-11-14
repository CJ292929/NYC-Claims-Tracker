// Pure authorization-period metrics primitives. No React, no Supabase, no
// server/client dependencies — safe to import from either side of the
// client/server boundary. Mirrors the active-period rule used by
// server/db.ts (determineActiveAuthPeriod / getAuthAlertSummaries) and
// client/src/pages/Dashboard.tsx (getPatientMetrics): the oldest period
// whose authorized minus completed is still > 0, or null once every period
// is exhausted.
//
// P4-P31: a period is EXPIRED when its rows carry period_expired_at
// (periodExpiredAt). That mark is period-level — the database trigger
// visit_records_period_expiry_guard keeps it identical on every row of the
// period, and only set_auth_period_expired_with_audit can change it — and it
// is independent of each row's auth_status. Expired is only ever set manually
// (never inferred from dates or a zero balance). An expired period keeps its
// authorized and completed counts as history, reports its leftover sessions
// as `unusedExpired`, and reports `remaining` 0 — those sessions are no
// longer available, so an expired period is never the active one.

export interface AuthPeriodVisit {
  authPeriod: number | null;
  sessionsAuthorized: number | null;
  dateOfService: unknown;
  /** P4-P31: period-level expiry mark (visit_records.period_expired_at). Optional so
   *  callers that never read it keep compiling; absent/null means not expired. */
  periodExpiredAt?: unknown;
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
  const expired = periodVisits.some(v => v.periodExpiredAt != null);

  return {
    authorized,
    completed,
    remaining: expired ? 0 : leftover,
    expired,
    unusedExpired: expired ? leftover : 0,
  };
}

export function isPeriodExpired(visits: AuthPeriodVisit[], period: number): boolean {
  return visits.some(v => normalizePeriod(v) === period && v.periodExpiredAt != null);
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

/** "Sessions exhausted" (the Completed Patients metric): every authorized
 *  session of every period has a date of service. Expiry is deliberately
 *  ignored — an expired period with unused sessions is not exhausted, and a
 *  fully used period stays exhausted whether or not it was also marked
 *  Expired. This is the pre-P4-P31 definition, unchanged. */
export function areAllAuthorizedSessionsUsed(visits: AuthPeriodVisit[]): boolean {
  if (visits.length === 0) return false;
  return determineActivePeriod(visits.map(v => ({ ...v, periodExpiredAt: null }))) === null;
}
