import { deriveAuthPeriodMetrics, type AuthPeriodVisit } from '@shared/authPeriodMetrics';
import { deriveAuthorizationUrgency, type AuthUrgency } from '@shared/authUrgency';

export interface AuthUrgencyVisit extends AuthPeriodVisit {
  authStatus?: string | null;
}

export interface PatientAlertPresentation {
  urgency: AuthUrgency;
  authExpiryWarning: boolean;
  label: string;
  color: string;
  /** P4-P30: the target period's status row, as the Dashboard alert reads it — 'pending' shows Approved / Re-request. */
  authStatus: string | null;
}

export const URGENCY_LABEL: Record<AuthUrgency, string> = {
  exhausted: 'Sessions Exhausted',
  critical: 'Critical — 1-2 Sessions Left',
  warning: 'Warning — 3 Sessions Left',
  pending: 'Authorization Pending',
  ok: 'On Track',
  denied: 'Authorization Denied',
};

export const URGENCY_COLOR: Record<AuthUrgency, string> = {
  exhausted: 'bg-red-100 text-red-800',
  critical: 'bg-orange-100 text-orange-800',
  warning: 'bg-yellow-100 text-yellow-800',
  pending: 'bg-blue-100 text-blue-800',
  ok: 'bg-green-100 text-green-800',
  // Reuses the existing authorization-denied badge convention (VisitAuthStatusSelect),
  // distinct from exhausted's red-800 text.
  denied: 'bg-red-100 text-red-700',
};

// Mirrors server/db.ts getAuthAlertSummaries' target-period + status-row
// lookup: targetPeriod = activePeriod ?? latestPeriod, authStatus read from
// the last row within that period. Visits must already be sorted
// auth_period asc, session_number asc — true for every client visits query,
// since they all go through getVisitsByPatientId on the server, which uses
// that same order. Kept separate from getPatientMetrics because that
// helper's all-exhausted display fallback intentionally discards the status
// row along with zeroing remaining (see patientMetrics.ts).
function resolveAuthStatus(visits: AuthUrgencyVisit[]): string | null {
  if (visits.length === 0) return null;

  const { periods, activePeriod } = deriveAuthPeriodMetrics(visits);
  const latestPeriod = periods[periods.length - 1];
  const targetPeriod = activePeriod ?? latestPeriod;

  const targetVisits = visits.filter(v => (v.authPeriod ?? 1) === targetPeriod);
  const lastActiveRow = targetVisits[targetVisits.length - 1];
  return lastActiveRow?.authStatus ?? null;
}

/**
 * Client adapter over shared/authUrgency.ts. The only classifier is
 * deriveAuthorizationUrgency — this just resolves the same
 * (authStatus, authValidUntil) inputs the server uses and maps the shared
 * 5-state result to the badge presentation used by PatientSnapshotPane and
 * the active-patient banner.
 */
export function derivePatientAlertPresentation(
  visits: AuthUrgencyVisit[],
  remaining: number,
  authValidUntil: number | string | Date | null | undefined,
  now?: Date,
): PatientAlertPresentation {
  // P4-P28: no visit rows means no authorization was ever set up (e.g. a patient
  // created by a claims import), not exhausted sessions. Same as getAuthAlertSummaries.
  if (visits.length === 0) {
    return { urgency: 'ok', authExpiryWarning: false, label: 'No Authorization On File', color: 'bg-gray-100 text-gray-700', authStatus: null };
  }
  const authStatus = resolveAuthStatus(visits);
  const { urgency, authExpiryWarning } = deriveAuthorizationUrgency({
    remaining,
    authStatus,
    authValidUntil,
    now,
  });

  return {
    urgency,
    authExpiryWarning,
    label: authExpiryWarning ? 'Auth Expiring Soon' : URGENCY_LABEL[urgency],
    color: URGENCY_COLOR[urgency],
    authStatus,
  };
}
