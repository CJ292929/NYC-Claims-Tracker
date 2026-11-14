/**
 * P4-P30: the authorization actions shared by the Dashboard's Authorization
 * Alerts and the patient details alert banner — Mark Requested, Approved
 * (with the New Authorization dialog) and Re-request. Both places call the
 * same audited procedures (visits.markAsRequested, which targets the period
 * the alert is about, and visits.approveAuthorization) and refresh the same
 * data afterwards, so the two views cannot drift apart.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { CalendarX, CheckCircle2, Loader2, RotateCcw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { createSingleFlightGuard } from '@/lib/concurrencyGuards';

export interface ApproveTarget {
  id: string;
  name: string;
  insurance: string;
}

const today = () => new Date().toISOString().split('T')[0];

/** Refreshes everything an authorization change can move: alerts, the patient's sessions and totals, completion, the patient list. */
function useRefreshAfterAuthorizationChange() {
  const utils = trpc.useUtils();
  return (patientId: string) => {
    utils.visits.authAlerts.invalidate();
    utils.visits.listByPatient.invalidate({ patientId });
    utils.visits.completedPatientIds.invalidate();
    utils.patients.list.invalidate();
    // Only refetches where the Claims view already loaded it (Claims access).
    utils.claims.periodsForPatient.invalidate({ patientId });
  };
}

/** Mark Requested / Re-request, plus which patient is waiting on it. */
export function useMarkAuthorizationRequested() {
  const refresh = useRefreshAfterAuthorizationChange();
  const [requestingId, setRequestingId] = useState<string | null>(null);
  // Disabling the button needs a re-render, so two clicks in one frame would
  // both get through; this set stops a second request for the same patient
  // synchronously (other patients' buttons stay usable).
  const inFlight = useRef(new Set<string>());
  const mutation = trpc.visits.markAsRequested.useMutation({
    onMutate: ({ patientId }) => setRequestingId(patientId),
    onSuccess: (_data, { patientId }) => {
      toast.success('Authorization request marked — Authorization date set to today');
      refresh(patientId);
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to mark as requested');
    },
    onSettled: (_data, _err, { patientId }) => {
      inFlight.current.delete(patientId);
      setRequestingId(null);
    },
  });
  const markRequested = (patientId: string) => {
    if (inFlight.current.has(patientId)) return;
    inFlight.current.add(patientId);
    mutation.mutate({ patientId });
  };
  return { requestingId, markRequested };
}

/** The buttons the Dashboard alert shows: Mark Requested, or Approved + Re-request once a request is pending. */
export function AuthorizationActionButtons({
  authPending,
  requesting,
  onMarkRequested,
  onApprove,
  className = 'flex gap-2',
  buttonClassName = 'flex-1 h-7 text-xs',
}: {
  authPending: boolean;
  requesting: boolean;
  onMarkRequested: () => void;
  onApprove: () => void;
  className?: string;
  buttonClassName?: string;
}) {
  return (
    <div className={className}>
      {!authPending && (
        <Button
          size="sm"
          disabled={requesting}
          onClick={(e) => { e.stopPropagation(); onMarkRequested(); }}
          className={`${buttonClassName} bg-brand-blue text-white hover:bg-brand-blue-dark`}
        >
          {requesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
          Mark Requested
        </Button>
      )}
      {authPending && (
        <>
          <Button
            size="sm"
            onClick={(e) => { e.stopPropagation(); onApprove(); }}
            className={`${buttonClassName} bg-green-600 text-white hover:bg-green-700`}
          >
            <ShieldCheck className="w-3 h-3" /> Approved
          </Button>
          <Button
            size="sm"
            disabled={requesting}
            onClick={(e) => { e.stopPropagation(); onMarkRequested(); }}
            className={`${buttonClassName} bg-blue-100 text-blue-700 hover:bg-blue-200`}
          >
            {requesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} Re-request
          </Button>
        </>
      )}
    </div>
  );
}

/** New Authorization dialog: the required session count and optional date, insurer and expiry. */
export function ApproveAuthorizationDialog({ target, onClose }: { target: ApproveTarget | null; onClose: () => void }) {
  const refresh = useRefreshAfterAuthorizationChange();
  // Same shared catalog as the patient forms; only active insurers are offered
  // (the "(current)" item below keeps a since-deactivated current value).
  const { data: insurerCatalog = [] } = trpc.insurance.list.useQuery();
  const insuranceList = insurerCatalog.filter(entry => entry.isActive).map(entry => entry.name);

  const [newSessions, setNewSessions] = useState('');
  const [newAuthDate, setNewAuthDate] = useState(today);
  const [newInsurance, setNewInsurance] = useState('');
  const [newAuthValidUntil, setNewAuthValidUntil] = useState('');

  // Each opening starts from a blank form for that patient.
  useEffect(() => {
    if (!target) return;
    setNewSessions('');
    setNewAuthDate(today());
    setNewInsurance(target.insurance ?? '');
    setNewAuthValidUntil('');
  }, [target?.id]);

  // A double click must not create two batches of session records: isPending
  // only disables Confirm after a re-render, so guard synchronously too.
  const submitGuard = useRef(createSingleFlightGuard());
  const approveAuthorization = trpc.visits.approveAuthorization.useMutation({
    onSettled: () => submitGuard.current.exit(),
    onSuccess: (data, { patientId }) => {
      toast.success(`Authorization approved — ${data.newVisitCount} new session records created`);
      onClose();
      refresh(patientId);
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to approve authorization');
    },
  });

  const handleApproveSubmit = () => {
    if (!target) return;
    const count = parseInt(newSessions, 10);
    if (!count || count < 1) { toast.error('Please enter a valid session count'); return; }
    if (!submitGuard.current.tryEnter()) return;
    approveAuthorization.mutate({
      patientId: target.id,
      sessionsAuthorized: count,
      authDate: newAuthDate || null,
      newInsurance: newInsurance || undefined,
      authValidUntil: newAuthValidUntil ? new Date(newAuthValidUntil + 'T00:00:00Z').getTime() : null,
    });
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-brand-blue flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-green-600" />
            New Authorization Approved
          </DialogTitle>
          <DialogDescription>
            Enter the new authorization details for <strong>{target?.name}</strong>.
            A fresh batch of session records will be created automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-sessions" className="text-brand-blue font-semibold">
              Sessions Authorized <span className="text-red-500">*</span>
            </Label>
            <Input
              id="new-sessions"
              type="number"
              min={1}
              max={200}
              placeholder="e.g. 20"
              value={newSessions}
              onChange={(e) => setNewSessions(e.target.value)}
              className="border-brand-blue/30 focus:border-brand-blue"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-auth-date" className="text-brand-blue font-semibold">
              Authorization Date
            </Label>
            <Input
              id="new-auth-date"
              type="date"
              value={newAuthDate}
              onChange={(e) => setNewAuthDate(e.target.value)}
              className="border-brand-blue/30 focus:border-brand-blue"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-insurance" className="text-brand-blue font-semibold">
              Insurance Company
            </Label>
            <Select value={newInsurance} onValueChange={setNewInsurance}>
              <SelectTrigger id="new-insurance" className="border-brand-blue/30 focus:border-brand-blue">
                <SelectValue placeholder="Select insurance company" />
              </SelectTrigger>
              <SelectContent>
                {target?.insurance && !insuranceList.includes(target.insurance) && (
                  <SelectItem value={target.insurance}>{target.insurance} (current)</SelectItem>
                )}
                {insuranceList.map(ins => (
                  <SelectItem key={ins} value={ins}>{ins}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-auth-valid-until" className="text-brand-blue font-semibold">
              Authorization Valid Until <span className="text-gray-400 font-normal">(optional)</span>
            </Label>
            <p className="text-xs text-gray-500">Staff will be alerted 1 week before this date to request a new authorization.</p>
            <Input
              id="new-auth-valid-until"
              type="date"
              value={newAuthValidUntil}
              onChange={(e) => setNewAuthValidUntil(e.target.value)}
              className="border-brand-blue/30 focus:border-brand-blue"
            />
          </div>
          <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-800">
            <strong>{newSessions ? parseInt(newSessions, 10) || 0 : 0}</strong> new session rows will be created,
            numbered sequentially from the last existing session.
            Sessions remaining will count down from the authorized total.
          </div>
        </div>
        <div className="flex gap-3 pt-2">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={approveAuthorization.isPending}>
            Cancel
          </Button>
          <Button
            className="flex-1 bg-green-600 hover:bg-green-700 text-white"
            onClick={handleApproveSubmit}
            disabled={approveAuthorization.isPending || !newSessions}
          >
            {approveAuthorization.isPending ? (
              <><Loader2 className="w-4 h-4 animate-spin mr-1" /> Creating Records…</>
            ) : (
              <><ShieldCheck className="w-4 h-4 mr-1" /> Confirm &amp; Create Records</>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * P4-P31: Mark Expired / Clear Expired for ONE authorization period (the card
 * it sits in). Always an explicit, confirmed staff action — expiry is never
 * inferred from dates or a zero balance. Only that period's authorization
 * status changes: session counts, dates of service, claims and money are
 * untouched, and each changed row is audited with its before/after status.
 */
export function PeriodExpiryControl({
  patientId,
  patientName,
  period,
  expired,
  authorized,
  completed,
  className = '',
}: {
  patientId: string;
  patientName: string;
  period: number;
  expired: boolean;
  authorized: number;
  completed: number;
  className?: string;
}) {
  const refresh = useRefreshAfterAuthorizationChange();
  const [open, setOpen] = useState(false);
  const guard = useRef(createSingleFlightGuard());
  const mutation = trpc.visits.setPeriodExpired.useMutation({
    onSettled: () => guard.current.exit(),
    onSuccess: (_data, vars) => {
      toast.success(vars.expired
        ? `Authorization Period ${vars.authPeriod} marked Expired`
        : `Expired cleared for Authorization Period ${vars.authPeriod}`);
      setOpen(false);
      refresh(vars.patientId);
    },
    onError: (err) => toast.error(err.message || 'Failed to update authorization period'),
  });
  const unused = Math.max(0, authorized - completed);

  const confirm = () => {
    if (!guard.current.tryEnter()) return;
    mutation.mutate({ patientId, authPeriod: period, expired: !expired });
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className={`bg-white text-slate-700 border-slate-300 hover:bg-slate-50 ${className}`}
      >
        {expired ? <RotateCcw className="w-4 h-4" /> : <CalendarX className="w-4 h-4" />}
        {expired ? 'Clear Expired' : 'Mark Expired'}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => { if (!mutation.isPending) setOpen(next); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {expired ? `Clear Expired on Authorization Period ${period}?` : `Mark Authorization Period ${period} Expired?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                {expired ? (
                  <p>
                    Period {period} for <strong>{patientName}</strong> stops being expired. Its rows marked
                    Expired go back to no status, so any unused sessions count as available again. The change
                    is recorded in the history.
                  </p>
                ) : (
                  <>
                    <p>
                      Only Period {period} for <strong>{patientName}</strong> changes. Other periods are not touched.
                    </p>
                    <p>
                      Authorized stays <strong>{authorized}</strong> and completed stays <strong>{completed}</strong>.
                      {unused > 0 && (
                        <span> The <strong>{unused}</strong> unused session(s) stay visible as history but will no longer be available.</span>
                      )}
                      <span> No sessions, claims or amounts are changed.</span>
                    </p>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={mutation.isPending}
              onClick={(e) => { e.preventDefault(); confirm(); }}
              className={expired ? '' : 'bg-slate-700 hover:bg-slate-800 text-white'}
            >
              {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              {expired ? 'Clear Expired' : 'Mark Expired'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
