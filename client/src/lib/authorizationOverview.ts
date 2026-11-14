import type { AuthUrgency } from '@shared/authUrgency';
import { URGENCY_SORT_ORDER, sortAuthorizationRecords } from '@/lib/authorizationRecordFilters';

/**
 * Shape the Authorizations Overview derives KPIs/distributions from — the
 * same per-patient row trpc.visits.authAlerts returns (see
 * server/db.ts getAuthAlertSummaries). authExpiryWarning is absent on the
 * "no visit history yet" branch of that function, hence optional here.
 */
export interface AuthorizationOverviewRecord {
  patientId: string;
  patientName: string;
  insurance: string | null;
  authPeriod: number | null;
  sessionsAuthorized: number | null;
  sessionsRemaining: number | null;
  authStatus: string;
  authValidUntil: number | null;
  urgency: AuthUrgency;
  authExpiryWarning?: boolean;
  /** P4-P31 */
  periodExpired?: boolean;
  unusedExpiredSessions?: number;
}

export const AUTH_STATUS_VALUES = ['none', 'pending', 'approved', 'denied'] as const;
export type AuthStatusValue = (typeof AUTH_STATUS_VALUES)[number];

export interface AuthorizationOverviewMetrics {
  totalRecords: number;
  needsAttention: number;
  pending: number;
  denied: number;
  expired: number;
  critical: number;
  exhausted: number;
  expiring: number;
  statusDistribution: Record<AuthStatusValue, number>;
  urgencyDistribution: Record<AuthUrgency, number>;
}

/** Pure clinic-wide rollup — no re-derivation of urgency/status, only counting
 *  what trpc.visits.authAlerts already computed server-side. */
export function deriveAuthorizationOverviewMetrics(
  records: AuthorizationOverviewRecord[],
): AuthorizationOverviewMetrics {
  const statusDistribution: Record<AuthStatusValue, number> = { none: 0, pending: 0, approved: 0, denied: 0 };
  const urgencyDistribution: Record<AuthUrgency, number> = {
    denied: 0, expired: 0, exhausted: 0, critical: 0, warning: 0, pending: 0, ok: 0,
  };

  let needsAttention = 0;
  let pending = 0;
  let denied = 0;
  let expired = 0;
  let critical = 0;
  let exhausted = 0;
  let expiring = 0;

  for (const record of records) {
    urgencyDistribution[record.urgency]++;
    if ((AUTH_STATUS_VALUES as readonly string[]).includes(record.authStatus)) {
      statusDistribution[record.authStatus as AuthStatusValue]++;
    }
    if (record.urgency !== 'ok') needsAttention++;
    if (record.urgency === 'pending') pending++;
    if (record.urgency === 'denied') denied++;
    if (record.urgency === 'expired') expired++;
    if (record.urgency === 'critical') critical++;
    if (record.urgency === 'exhausted') exhausted++;
    if (record.authExpiryWarning === true) expiring++;
  }

  return {
    totalRecords: records.length,
    needsAttention,
    pending,
    denied,
    expired,
    critical,
    exhausted,
    expiring,
    statusDistribution,
    urgencyDistribution,
  };
}

/** Top-N needs-attention summary for the Overview page. Reuses the same
 *  sortAuthorizationRecords/URGENCY_SORT_ORDER the Records workspace already
 *  established (denied, exhausted, critical, warning, pending, ok, then
 *  alphabetical) so the two pages can never silently drift apart. */
export function getTopAuthorizationAttention<T extends { patientName: string; urgency: AuthUrgency }>(
  records: T[],
  limit = 5,
): T[] {
  const attention = records.filter(r => r.urgency !== 'ok');
  return sortAuthorizationRecords(attention).slice(0, limit);
}

// Re-exported so consumers of this module don't need a second import from
// authorizationRecordFilters just to label the same priority order.
export { URGENCY_SORT_ORDER };
