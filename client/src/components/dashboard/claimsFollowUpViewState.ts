import { formatCalendarDate } from '@/lib/date';

// Card color per claim_status, per product spec:
// Rejected=Black, Denied=Red, Pending=Yellow, Pended=Orange, Approved=Green,
// Resubmitted=Violet, Submitted=Blue.
export const FOLLOW_UP_ROW_STYLES: Record<string, { badge: string; row: string }> = {
  rejected:    { badge: 'bg-gray-900 text-white',     row: 'hover:bg-gray-50' },
  denied:      { badge: 'bg-red-100 text-red-800',    row: 'hover:bg-red-50/60' },
  pended:      { badge: 'bg-orange-100 text-orange-800', row: 'hover:bg-orange-50/60' },
  pending:     { badge: 'bg-yellow-100 text-yellow-800', row: 'hover:bg-yellow-50/60' },
  submitted:   { badge: 'bg-blue-100 text-blue-800',  row: 'hover:bg-blue-50/60' },
  approved:    { badge: 'bg-green-100 text-green-800', row: 'hover:bg-green-50/60' },
  resubmitted: { badge: 'bg-violet-100 text-violet-800', row: 'hover:bg-violet-50/60' },
};

export function getFollowUpRowStyle(status: string): { badge: string; row: string } {
  return FOLLOW_UP_ROW_STYLES[status] ?? FOLLOW_UP_ROW_STYLES.rejected;
}

export function formatChargeAmount(value: unknown): string {
  return value != null ? `$${parseFloat(String(value)).toFixed(2)}` : '—';
}

export function formatReimbursement(value: unknown): string {
  return `$${(value != null ? parseFloat(String(value)) : 0).toFixed(2)}`;
}

export function formatDateOrDash(value: unknown): string {
  return formatCalendarDate(value as string | number | Date | null | undefined, {});
}

export type ClaimsFollowUpViewState = 'loading' | 'error' | 'empty' | 'data';

export function getClaimsFollowUpViewState(params: {
  isLoading: boolean;
  isError: boolean;
  data: unknown[];
}): ClaimsFollowUpViewState {
  if (params.isLoading) return 'loading';
  if (params.isError) return 'error';
  if (params.data.length === 0) return 'empty';
  return 'data';
}
