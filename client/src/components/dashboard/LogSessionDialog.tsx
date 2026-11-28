/**
 * client/src/components/dashboard/LogSessionDialog.tsx
 *
 * "Log Session" trigger + "Log New Session" dialog for the active
 * authorization period (moved out of pages/Dashboard.tsx unchanged in
 * behavior, so its submit wiring can be tested directly).
 *
 * - The body is a <form>: Enter in the Date of Service input and the
 *   Confirm Session button both submit through `handleSubmit`.
 * - Targeting is unchanged: fill the first undated row of the active period
 *   (visits.update), or create a row if none exists (visits.create).
 * - A synchronous single-flight guard (client/src/lib/concurrencyGuards.ts)
 *   stops repeated Enter, a held Enter and Enter + click from saving twice
 *   before the pending state re-renders the button disabled.
 * - On failure the dialog stays open with the entered date and an inline
 *   error; on success it toasts, refreshes and closes as before.
 */
import { useRef, useState, type FormEvent } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { CheckCircle2, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { AppRouter } from '../../../../server/routers';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createSingleFlightGuard } from '@/lib/concurrencyGuards';
import { isCompleteSessionDate } from '@/lib/sessionDate';
import { trpc } from '@/lib/trpc';

type VisitRow = inferRouterOutputs<AppRouter>['visits']['listByPatient'][number];

export const INVALID_SESSION_DATE_MESSAGE = 'Enter a complete, valid date of service.';

const today = () => new Date().toISOString().split('T')[0];

export interface LogSessionDialogProps {
  patientId: string;
  patientName: string;
  /** Sessions remaining in the active period (getPatientMetrics().remaining). */
  remaining: number;
  /** The active period (oldest with remaining sessions). */
  activePeriod: number | null;
  /** All loaded visit rows for the patient. */
  visits: VisitRow[];
}

export function LogSessionDialog({ patientId, patientName, remaining, activePeriod, visits }: LogSessionDialogProps) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [sessionDate, setSessionDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /**
   * Released on failure (so the user can retry) and on the next open after a
   * success — never while a save is still in flight.
   */
  const guardRef = useRef(createSingleFlightGuard());
  const inFlightRef = useRef(false);

  const createVisit = trpc.visits.create.useMutation({
    onSuccess: () => {
      utils.visits.listByPatient.invalidate({ patientId });
      utils.visits.completedPatientIds.invalidate();
      toast.success('Session logged successfully!');
      setOpen(false);
    },
  });

  const updateVisit = trpc.visits.update.useMutation({
    onSuccess: () => {
      utils.visits.listByPatient.invalidate({ patientId });
      utils.visits.completedPatientIds.invalidate();
      // P4-P31: an auth status / date edit can change the alerts.
      utils.visits.authAlerts.invalidate();
    },
  });

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setError(null);
      if (!inFlightRef.current) guardRef.current.exit();
    }
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (remaining <= 0) {
      toast.error('No sessions remaining for this patient');
      return;
    }
    if (!isCompleteSessionDate(sessionDate)) {
      setError(INVALID_SESSION_DATE_MESSAGE);
      return;
    }
    if (!guardRef.current.tryEnter()) return;
    inFlightRef.current = true;
    setPending(true);
    setError(null);

    const settle = (failure?: { message: string }) => {
      inFlightRef.current = false;
      setPending(false);
      if (failure) {
        // Keep the dialog open with the entered date so the user can retry.
        const message = `Failed to log session: ${failure.message}`;
        guardRef.current.exit();
        setError(message);
        toast.error(message);
      }
    };

    const newRemaining = remaining - 1;
    const activePeriodVisits = visits.filter(v => (v.authPeriod ?? 1) === activePeriod);
    const firstUndated = activePeriodVisits.find(v => !v.dateOfService);
    if (firstUndated) {
      // Fill the existing pre-created row with the date of service.
      updateVisit.mutate({
        id: firstUndated.id,
        dateOfService: sessionDate,
        sessionsRemaining: newRemaining,
        authStatus: firstUndated.authStatus === 'none' ? 'none' : firstUndated.authStatus,
      }, {
        onSuccess: () => {
          settle();
          toast.success('Session logged successfully!');
          setOpen(false);
          setSessionDate(today());
        },
        onError: err => settle(err),
      });
    } else {
      // Fallback: create a new row if no pre-created rows exist.
      createVisit.mutate({
        patientId,
        sessionsRemaining: newRemaining,
        sessionNumber: activePeriodVisits.length + 1,
        authPeriod: activePeriod ?? undefined,
        dateOfService: sessionDate,
        newAuth: 'NO',
        authStatus: 'none',
      }, {
        onSuccess: () => settle(),
        onError: err => settle(err),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button className="bg-brand-gold hover:bg-brand-gold-dark text-brand-blue font-semibold px-5 py-2.5 rounded-lg inline-flex items-center gap-2 transition-all shadow-sm hover:shadow-md">
          <Plus className="w-4 h-4" strokeWidth={2.5} />
          Log Session
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-white">
        <DialogHeader>
          <DialogTitle className="text-brand-blue">Log New Session</DialogTitle>
          <DialogDescription>Record a therapy session for {patientName}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={handleSubmit}
          onKeyDown={e => {
            // Ignore auto-repeat from a held Enter and IME composition;
            // the single-flight guard covers everything else.
            if (e.key === 'Enter' && (e.repeat || e.nativeEvent.isComposing)) e.preventDefault();
          }}
        >
          <div>
            <Label htmlFor="log-session-date" className="text-brand-blue font-semibold">Date of Service</Label>
            <Input
              id="log-session-date"
              type="date"
              value={sessionDate}
              onChange={e => {
                setSessionDate(e.target.value);
                setError(null);
              }}
              aria-invalid={error !== null}
              aria-describedby={error ? 'log-session-error' : undefined}
              className="border-brand-cream-dark mt-2"
            />
            {error && (
              <p id="log-session-error" role="alert" className="mt-2 text-sm text-red-600">
                {error}
              </p>
            )}
          </div>
          <div className="bg-brand-cream rounded-lg p-4 text-sm text-brand-blue">
            <p><strong>Sessions remaining:</strong> {remaining}</p>
            <p><strong>After this session:</strong> {Math.max(0, remaining - 1)}</p>
          </div>
          <div className="flex gap-3">
            <Button
              type="submit"
              disabled={pending}
              className="flex-1 bg-brand-blue hover:bg-brand-blue-dark text-white font-semibold"
            >
              {pending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
              Confirm Session
            </Button>
            <Button type="button" onClick={() => setOpen(false)} variant="outline" className="flex-1">
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
