/**
 * Clear a wrong Date of Service on ONE completed session row.
 *
 * Always confirmed: the dialog names the authorization period and session so
 * the user can check it is the right row before anything is written. Only
 * that row's date_of_service is cleared (visits.clearDateOfService, atomic
 * and audited) — the session, its authorization period, claims, payments
 * and every other field stay as they are, and the date is never moved to
 * another period. Completed/remaining recompute from dates after the reload.
 * An Expired period stays Expired with no sessions available.
 *
 * Controlled by the caller so the inline date editor that opened it keeps
 * its unsaved input while the dialog is open, and after Cancel.
 */
import { useRef, useState } from 'react';
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
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { createSingleFlightGuard } from '@/lib/concurrencyGuards';
import { useRefreshAfterAuthorizationChange } from './AuthorizationActions';

export function ClearDateOfServiceDialog({
  open,
  onOpenChange,
  onCleared,
  visitId,
  patientId,
  period,
  sessionNumber,
  dateLabel,
  completed,
  periodExpired,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the server confirmed the clear (e.g. to close the inline editor). */
  onCleared?: () => void;
  visitId: string;
  patientId: string;
  period: number;
  sessionNumber: number | null;
  /** The stored date, already formatted for display. */
  dateLabel: string;
  /** Completed sessions in this period before the clear. */
  completed: number;
  periodExpired: boolean;
}) {
  const refresh = useRefreshAfterAuthorizationChange();
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(createSingleFlightGuard());
  const sessionText = sessionNumber != null ? `Session #${sessionNumber}` : 'this session (no session number)';
  const mutation = trpc.visits.clearDateOfService.useMutation({
    onSettled: () => guard.current.exit(),
    onSuccess: () => {
      toast.success(`Date of Service cleared — Period ${period}, ${sessionText}`);
      setError(null);
      onOpenChange(false);
      onCleared?.();
      refresh(patientId);
    },
    onError: (err) => setError(err.message || 'Failed to clear the Date of Service. Nothing was changed.'),
  });

  const confirm = () => {
    if (mutation.isPending || !guard.current.tryEnter()) return;
    setError(null);
    mutation.mutate({ id: visitId, patientId });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (mutation.isPending) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear Date of Service?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                Authorization Period <strong>{period}</strong> · <strong>{sessionText}</strong> ·
                Date of Service <strong>{dateLabel}</strong>
              </p>
              <p>
                Only this session&apos;s Date of Service is cleared. The session, its authorization period,
                claims, payments and every other field are kept, and the date is not moved to another period.
              </p>
              <p>
                Completed sessions in Period {period} go from <strong>{completed}</strong> to{' '}
                <strong>{Math.max(0, completed - 1)}</strong>.
                {periodExpired
                  ? <> Period {period} stays <strong>Expired</strong>, so no session becomes available.</>
                  : <> One more session becomes available in this period.</>}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending}
            onClick={(e) => { e.preventDefault(); confirm(); }}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {error ? 'Try Again' : 'Clear Date of Service'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
