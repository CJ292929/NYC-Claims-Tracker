import type { AuthUrgency } from '@shared/authUrgency';

/**
 * Shape the Authorization Records workspace filters/sorts over — a subset of
 * trpc.visits.authAlerts' per-patient row (one row = the patient's current/
 * target authorization period, not full history).
 */
export interface AuthorizationRecord {
  patientId: string;
  patientName: string;
  insurance: string | null;
  sessionsAuthorized: number | null;
  sessionsRemaining: number | null;
  authStatus: string;
  urgency: AuthUrgency;
}

export interface AuthorizationRecordFilterScope {
  search: string;
  insurance: string;
  authStatus: string;
  urgency: string;
  activity: string;
}

/** derived = max(0, authorized - remaining); null when authorized is unknown,
 *  since the formula has no meaningful answer without it (see getAuthAlertSummaries). */
export function getCompletedSessions(
  sessionsAuthorized: number | null,
  sessionsRemaining: number | null,
): number | null {
  if (sessionsAuthorized === null) return null;
  return Math.max(0, sessionsAuthorized - (sessionsRemaining ?? 0));
}

/** Coarser than urgency: just whether the current period still has sessions
 *  left. null (no period data) matches neither 'active' nor 'exhausted'
 *  explicitly — only the unfiltered 'all' state shows those patients. */
export function getAuthorizationActivity(sessionsRemaining: number | null): 'active' | 'exhausted' | null {
  if (sessionsRemaining === null) return null;
  return sessionsRemaining > 0 ? 'active' : 'exhausted';
}

export function formatAuthPeriod(authPeriod: number | null): string {
  return authPeriod === null ? '—' : `Period ${authPeriod}`;
}

/** AND-combines search, insurance, auth status, urgency, and activity. Each
 *  filter is a no-op when set to '' (search) or 'all' (the rest). */
export function matchesAuthorizationRecordFilters(
  record: AuthorizationRecord,
  scope: AuthorizationRecordFilterScope,
): boolean {
  const search = scope.search.trim().toLowerCase();
  if (search && !record.patientName.toLowerCase().includes(search)) return false;
  if (scope.insurance && record.insurance !== scope.insurance) return false;
  if (scope.authStatus !== 'all' && record.authStatus !== scope.authStatus) return false;
  if (scope.urgency !== 'all' && record.urgency !== scope.urgency) return false;
  if (scope.activity !== 'all' && getAuthorizationActivity(record.sessionsRemaining) !== scope.activity) return false;
  return true;
}

/** Same precedence AuthAlertPanel already established for its urgency queue —
 *  kept as a single exported constant so this table can never silently drift
 *  out of sync with it. */
export const URGENCY_SORT_ORDER: Record<AuthUrgency, number> = {
  denied: 0,
  exhausted: 1,
  critical: 2,
  warning: 3,
  pending: 4,
  ok: 5,
};

export function sortAuthorizationRecords<T extends { patientName: string; urgency: AuthUrgency }>(
  records: T[],
): T[] {
  return [...records].sort((a, b) => {
    const byUrgency = URGENCY_SORT_ORDER[a.urgency] - URGENCY_SORT_ORDER[b.urgency];
    if (byUrgency !== 0) return byUrgency;
    return a.patientName.localeCompare(b.patientName);
  });
}
