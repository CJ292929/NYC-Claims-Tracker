// Pure authorization-period metrics primitives. No React, no Supabase, no
// server/client dependencies — safe to import from either side of the
// client/server boundary. Mirrors the active-period rule used by
// server/db.ts (determineActiveAuthPeriod / getAuthAlertSummaries) and
// client/src/pages/Dashboard.tsx (getPatientMetrics): the oldest period
// whose authorized minus completed is still > 0, or null once every period
// is exhausted.

export interface AuthPeriodVisit {
  authPeriod: number | null;
  sessionsAuthorized: number | null;
  dateOfService: unknown;
}

export interface AuthPeriodMetrics {
  authorized: number;
  completed: number;
  remaining: number;
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
  const remaining = Math.max(0, authorized - completed);

  return { authorized, completed, remaining };
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
    : { authorized: 0, completed: 0, remaining: 0 };

  return { periods, activePeriod, activeMetrics };
}
