/**
 * A session's Auth Status dropdown, with Expired beside Pending / Approved /
 * Denied.
 *
 * Expired is NOT a row status. It is the period-level mark (P4-P31:
 * period_expired_at, New York cutoff, audited mark/restore). So:
 *  - Choosing Expired never writes auth_status — it asks the caller to open
 *    the period's existing Mark Expired confirmation (the same dialog as the
 *    period header button), which expires the ENTIRE period only on confirm.
 *  - In an expired period the dropdown shows Expired, with the row's own
 *    status kept and shown underneath.
 *  - Choosing Pending / Approved / Denied / None in an expired period never
 *    restores it. The user is told so and picks: review Restore Period (the
 *    reviewed, reason-required flow), change only this session's underlying
 *    status (the period stays Expired), or cancel.
 */
import { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export type RowAuthStatus = 'none' | 'pending' | 'approved' | 'denied';
export const EXPIRED_OPTION = 'expired';
type Option = RowAuthStatus | typeof EXPIRED_OPTION;

const LABELS: Record<RowAuthStatus, string> = {
  none: '— None —',
  pending: 'Pending',
  approved: 'Approved',
  denied: 'Denied',
};
const SHORT: Record<RowAuthStatus, string> = { ...LABELS, none: 'None' };

export type AuthStatusSelection =
  | { kind: 'noop' }
  | { kind: 'setRowStatus'; status: RowAuthStatus }
  | { kind: 'openPeriodExpiry' }
  | { kind: 'confirmExpiredRowChange'; status: RowAuthStatus };

/** What picking `option` should do. Pure, so the rules are unit-tested. */
export function resolveAuthStatusSelection(input: {
  option: string;
  rowStatus: RowAuthStatus;
  periodExpired: boolean;
}): AuthStatusSelection {
  const { option, rowStatus, periodExpired } = input;
  if (option === EXPIRED_OPTION) {
    return periodExpired ? { kind: 'noop' } : { kind: 'openPeriodExpiry' };
  }
  if (!(option in LABELS)) return { kind: 'noop' };
  const status = option as RowAuthStatus;
  if (periodExpired) return { kind: 'confirmExpiredRowChange', status };
  return status === rowStatus ? { kind: 'noop' } : { kind: 'setRowStatus', status };
}

const ROW_COLORS: Record<RowAuthStatus, string> = {
  approved: 'bg-green-100 text-green-700',
  denied: 'bg-red-100 text-red-700',
  pending: 'bg-yellow-100 text-yellow-700',
  none: 'bg-gray-100 text-gray-600',
};

export function VisitAuthStatusSelect({
  rowStatus,
  period,
  periodExpired,
  onSetRowStatus,
  onRequestPeriodExpiry,
}: {
  rowStatus: RowAuthStatus;
  period: number;
  periodExpired: boolean;
  /** Writes this session row's auth_status (never 'expired'). */
  onSetRowStatus: (status: RowAuthStatus) => void;
  /** Opens the period's existing Mark Expired / Restore Period dialog. */
  onRequestPeriodExpiry: () => void;
}) {
  const [pendingChange, setPendingChange] = useState<RowAuthStatus | null>(null);
  const value: Option = periodExpired ? EXPIRED_OPTION : rowStatus;
  const colorClass = periodExpired ? 'bg-slate-200 text-slate-700' : ROW_COLORS[rowStatus];

  const handle = (option: string) => {
    const action = resolveAuthStatusSelection({ option, rowStatus, periodExpired });
    if (action.kind === 'setRowStatus') onSetRowStatus(action.status);
    else if (action.kind === 'openPeriodExpiry') onRequestPeriodExpiry();
    else if (action.kind === 'confirmExpiredRowChange') setPendingChange(action.status);
  };

  return (
    <>
      <Select value={value} onValueChange={handle}>
        <SelectTrigger
          size="sm"
          aria-label={periodExpired ? `Auth status: Expired (period ${period}); session status ${SHORT[rowStatus]}` : 'Auth status'}
          className={`h-auto w-auto border-0 rounded-full px-3 py-1 text-xs font-medium shadow-none ${colorClass}`}
        >
          {periodExpired ? (
            <span className="flex flex-col items-start leading-tight">
              <span>Expired</span>
              <span className="text-[10px] font-normal opacity-75">Session: {SHORT[rowStatus]}</span>
            </span>
          ) : (
            <SelectValue />
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{LABELS.none}</SelectItem>
          <SelectItem value="pending">Pending</SelectItem>
          <SelectItem value="approved">Approved</SelectItem>
          <SelectItem value="denied">Denied</SelectItem>
          <SelectItem value={EXPIRED_OPTION}>Expired</SelectItem>
        </SelectContent>
      </Select>

      <AlertDialog open={pendingChange !== null} onOpenChange={(next) => { if (!next) setPendingChange(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Authorization Period {period} stays Expired</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Choosing <strong>{pendingChange ? SHORT[pendingChange] : ''}</strong> here does not restore
                  the period. Restoring is done only through <strong>Restore Period</strong>, where you review the
                  effect and give a reason.
                </p>
                <p>
                  You can instead change only this session&apos;s underlying status
                  (currently <strong>{SHORT[rowStatus]}</strong>). The period stays Expired with no sessions available.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              disabled={pendingChange === rowStatus}
              onClick={() => {
                const next = pendingChange;
                setPendingChange(null);
                if (next && next !== rowStatus) onSetRowStatus(next);
              }}
            >
              Change session status only
            </Button>
            <AlertDialogAction
              onClick={() => {
                setPendingChange(null);
                onRequestPeriodExpiry();
              }}
            >
              Review Restore Period…
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
