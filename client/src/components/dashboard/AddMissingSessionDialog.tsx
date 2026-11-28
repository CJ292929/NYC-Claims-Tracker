/**
 * client/src/components/dashboard/AddMissingSessionDialog.tsx
 *
 * "Add Missing Session" for a previous (Expired or completed) authorization
 * period: records a visit that already happened into THIS period, without
 * restoring it (visits.addMissingSession). Historical correction is not
 * restoration — the period stays Expired/completed and a newer period stays
 * current.
 *
 * - The period is passed explicitly and sent explicitly; nothing defaults to
 *   the newest period.
 * - The server fills the period's first unused session row (no row is added
 *   or renumbered) and refuses a duplicate date, a future date, a date after
 *   the period's expiry and a full period, with a message kept inline.
 * - Enter in the date field submits; a single-flight guard stops repeated
 *   Enter / Enter + click from saving twice. On failure the entered date stays.
 * - On success: sessions, counts, alerts and that period's claims refresh,
 *   the dialog closes, and focus returns to the trigger (Radix Dialog).
 */
import { useRef, useState, type FormEvent } from 'react';
import { CalendarPlus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createSingleFlightGuard } from '@/lib/concurrencyGuards';
import { guardFormEnter } from '@/lib/keyboardEntry';
import { isCompleteSessionDate } from '@/lib/sessionDate';
import { trpc } from '@/lib/trpc';

export const INVALID_MISSING_SESSION_DATE = 'Enter a complete, valid date of service.';

/** Today's calendar date in New York (the clinic's dates of service are NY dates). */
export function newYorkToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

/** The NY calendar date an expiry mark falls on: the last date that period accepts. */
export function newYorkDateOf(value: unknown): string | null {
  if (value == null) return null;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : newYorkToday(d);
}

export interface AddMissingSessionDialogProps {
  patientId: string;
  patientName: string;
  period: number;
  authorized: number;
  completed: number;
  /** Session rows of this period with no date of service. */
  unusedRows: number;
  expired: boolean;
  /** The period's period_expired_at (any row's), when expired. */
  periodExpiredAt?: unknown;
}

export function AddMissingSessionDialog({
  patientId, patientName, period, authorized, completed, unusedRows, expired, periodExpiredAt,
}: AddMissingSessionDialogProps) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const guard = useRef(createSingleFlightGuard());
  const addMissing = trpc.visits.addMissingSession.useMutation();

  const today = newYorkToday();
  const cutoff = expired ? newYorkDateOf(periodExpiredAt) : null;
  const maxDate = cutoff && cutoff < today ? cutoff : today;
  const full = unusedRows === 0;
  const fieldId = `missing-session-date-${period}`;
  const errorId = `missing-session-error-${period}`;

  const handleOpenChange = (next: boolean) => {
    if (pending) return; // keep the dialog while a save is in flight
    setOpen(next);
    if (next) {
      setDate('');
      setError(null);
    }
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (full) return;
    if (!isCompleteSessionDate(date)) { setError(INVALID_MISSING_SESSION_DATE); return; }
    if (date > maxDate) {
      setError(cutoff && date > cutoff
        ? `Period ${period} accepts dates up to its expiry date. Pick a date on or before ${cutoff}.`
        : 'That date is in the future. Add Missing Session is only for visits that already happened.');
      return;
    }
    if (!guard.current.tryEnter()) return;
    setPending(true);
    setError(null);
    addMissing.mutate({ patientId, authPeriod: period, dateOfService: date }, {
      onSuccess: (out) => {
        void utils.visits.listByPatient.invalidate({ patientId });
        void utils.visits.completedPatientIds.invalidate();
        void utils.visits.authAlerts.invalidate();
        void utils.visits.historyForPatient.invalidate({ patientId });
        void utils.claims.getByPatientAndPeriod.invalidate({ patientId, authPeriod: period });
        toast.success(`Missing session recorded in Period ${period} as Session ${out.sessionNumber ?? '—'}. Period ${period} was not restored.`);
        setOpen(false);
      },
      onError: (err) => {
        setError(err.message || 'Failed to add the missing session.');
      },
      onSettled: () => {
        guard.current.exit();
        setPending(false);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Add missing session to Authorization Period ${period}`}
          className="bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
        >
          <CalendarPlus className="w-4 h-4" />
          Add Missing Session
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-brand-blue">Add Missing Session: Period {period}</DialogTitle>
          <DialogDescription>
            Record a visit for <strong>{patientName}</strong> that already happened in Authorization Period {period}
            {expired ? ' (Expired)' : ''}. The period is not restored and the current period is not changed.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" noValidate onSubmit={handleSubmit} onKeyDown={guardFormEnter}>
          <dl className="grid grid-cols-3 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-center text-sm">
            <div><dt className="text-xs text-slate-500">Authorized</dt><dd className="font-semibold text-brand-blue">{authorized}</dd></div>
            <div><dt className="text-xs text-slate-500">Recorded</dt><dd className="font-semibold text-brand-blue">{completed}</dd></div>
            <div><dt className="text-xs text-slate-500">Unused</dt><dd className="font-semibold text-brand-blue">{unusedRows}</dd></div>
          </dl>
          {full ? (
            <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Every authorized session of Period {period} already has a date of service, so another visit can&apos;t be
              added without exceeding the authorization. If a recorded visit is only missing its CMS-1500, add the claim
              to that session instead.
            </p>
          ) : (
            <div>
              <Label htmlFor={fieldId} className="text-brand-blue font-semibold">Date of Service</Label>
              <Input
                id={fieldId}
                type="date"
                value={date}
                max={maxDate}
                onChange={e => { setDate(e.target.value); setError(null); }}
                aria-invalid={error !== null}
                aria-describedby={error ? errorId : `${fieldId}-hint`}
                disabled={pending}
                className="border-brand-cream-dark mt-2"
              />
              <p id={`${fieldId}-hint`} className="mt-2 text-xs text-slate-500">
                It goes into the next unused session of Period {period}. Any date in the period works, including one
                between dates already recorded{cutoff ? `, up to ${cutoff} (when the period was marked Expired)` : ''}.
                A date that is already recorded is refused, so a visit is never entered twice.
              </p>
            </div>
          )}
          {error && (
            <p id={errorId} role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="flex-1" onClick={() => handleOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            {!full && (
              <Button type="submit" disabled={pending} className="flex-1 bg-brand-blue hover:bg-brand-blue-dark text-white font-semibold">
                {pending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                Add Session to Period {period}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
