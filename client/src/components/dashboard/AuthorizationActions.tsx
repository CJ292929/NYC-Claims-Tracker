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
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
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
import { CalendarX, CheckCircle2, Loader2, Pencil, RotateCcw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { createSingleFlightGuard } from '@/lib/concurrencyGuards';

export interface ApproveTarget {
  id: string;
  name: string;
  insurance: string;
  /** P4-P32: the patient has no authorization period yet (created while
   *  awaiting approval) — record the FIRST approval as period 1 instead of a
   *  renewal. The server refuses it once any period exists. */
  initial?: boolean;
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
  // P4-P32: a number alone never implies approval — the initial period is
  // only created once staff confirm the payer's approval was received.
  const [approvalReceived, setApprovalReceived] = useState(false);
  const initial = target?.initial === true;

  // Each opening starts from a blank form for that patient.
  useEffect(() => {
    if (!target) return;
    setNewSessions('');
    setNewAuthDate(today());
    setNewInsurance(target.insurance ?? '');
    setNewAuthValidUntil('');
    setApprovalReceived(false);
  }, [target?.id, target?.initial]);

  // A double click must not create two batches of session records: isPending
  // only disables Confirm after a re-render, so guard synchronously too.
  const submitGuard = useRef(createSingleFlightGuard());
  const approveAuthorization = trpc.visits.approveAuthorization.useMutation({
    onSettled: () => submitGuard.current.exit(),
    onSuccess: (data, { patientId, initial: wasInitial }) => {
      toast.success(wasInitial
        ? `Initial authorization recorded — Period 1 created with ${data.newVisitCount} sessions`
        : `Authorization approved — ${data.newVisitCount} new session records created`);
      onClose();
      refresh(patientId);
    },
    onError: (err, vars) => {
      toast.error(err.message || 'Failed to approve authorization');
      // A refused initial approval usually means a period now exists (e.g.
      // created in another tab), so refresh to show it.
      if (vars?.initial) refresh(vars.patientId);
    },
  });

  const parsedCount = Number(newSessions);
  const countValid = Number.isInteger(parsedCount) && parsedCount >= 1 && parsedCount <= 200;
  const canSubmit = !approveAuthorization.isPending && !!newSessions && (!initial || approvalReceived);

  const handleApproveSubmit = () => {
    if (!target) return;
    if (!countValid) { toast.error('Please enter a whole number of sessions from 1 to 200'); return; }
    if (initial && !approvalReceived) { toast.error('Confirm the approval was received before creating sessions'); return; }
    if (!submitGuard.current.tryEnter()) return;
    approveAuthorization.mutate({
      patientId: target.id,
      sessionsAuthorized: parsedCount,
      authDate: newAuthDate || null,
      newInsurance: newInsurance || undefined,
      authValidUntil: newAuthValidUntil ? new Date(newAuthValidUntil + 'T00:00:00Z').getTime() : null,
      ...(initial ? { initial: true } : {}),
    });
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-brand-blue flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-green-600" />
            {initial ? 'Record Initial Authorization' : 'New Authorization Approved'}
          </DialogTitle>
          <DialogDescription>
            {initial ? (
              <>
                <strong>{target?.name}</strong> has no authorization period yet. Once the payer has approved
                the authorization, enter the approved details to create <strong>Authorization Period 1</strong>.
              </>
            ) : (
              <>
                Enter the new authorization details for <strong>{target?.name}</strong>.
                A fresh batch of session records will be created automatically.
              </>
            )}
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
            <strong>{countValid ? parsedCount : 0}</strong> new session rows will be created
            {initial ? ' as Authorization Period 1, numbered 1 onward.' : ', numbered sequentially from the last existing session.'}
            {' '}Sessions remaining will count down from the authorized total.
          </div>
          {initial && (
            <label htmlFor="approval-received" className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
              <Checkbox
                id="approval-received"
                checked={approvalReceived}
                onCheckedChange={(v) => setApprovalReceived(v === true)}
                className="mt-0.5"
              />
              <span>The payer has approved this authorization (approval received).</span>
            </label>
          )}
        </div>
        <div className="flex gap-3 pt-2">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={approveAuthorization.isPending}>
            Cancel
          </Button>
          <Button
            className="flex-1 bg-green-600 hover:bg-green-700 text-white"
            onClick={handleApproveSubmit}
            disabled={!canSubmit}
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
 * P4-P31: Mark Expired / Restore for ONE authorization period (the card it
 * sits in). Always an explicit, confirmed staff action — expiry is never
 * inferred from dates or a zero balance. Expiry is a period-level mark: it
 * never rewrites any session's authorization status, so Restore has nothing
 * to guess — it only removes the mark, after the user reviews the effect and
 * gives a reason. Restore is unavailable once a later period exists. Every
 * change is audited (who, when, counts, reason).
 */
export function PeriodExpiryControl({
  patientId,
  patientName,
  period,
  expired,
  authorized,
  completed,
  hasLaterPeriod,
  className = '',
}: {
  patientId: string;
  patientName: string;
  period: number;
  expired: boolean;
  authorized: number;
  completed: number;
  hasLaterPeriod: boolean;
  className?: string;
}) {
  const refresh = useRefreshAfterAuthorizationChange();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const guard = useRef(createSingleFlightGuard());
  const mutation = trpc.visits.setPeriodExpired.useMutation({
    onSettled: () => guard.current.exit(),
    onSuccess: (_data, vars) => {
      toast.success(vars.expired
        ? `Authorization Period ${vars.authPeriod} marked Expired`
        : `Authorization Period ${vars.authPeriod} restored`);
      setOpen(false);
      setReason('');
      refresh(vars.patientId);
    },
    onError: (err) => toast.error(err.message || 'Failed to update authorization period'),
  });
  const unused = Math.max(0, authorized - completed);
  const trimmedReason = reason.trim();
  const restoreBlocked = expired && hasLaterPeriod;
  const canConfirm = !mutation.isPending && !restoreBlocked && (!expired || trimmedReason.length > 0);

  const confirm = () => {
    if (!canConfirm || !guard.current.tryEnter()) return;
    mutation.mutate(expired
      ? { patientId, authPeriod: period, expired: false, reason: trimmedReason }
      : { patientId, authPeriod: period, expired: true });
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
        {expired ? 'Restore Period' : 'Mark Expired'}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => { if (!mutation.isPending) { setOpen(next); if (!next) setReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {expired ? `Restore Authorization Period ${period}?` : `Mark Authorization Period ${period} Expired?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                {expired ? (
                  restoreBlocked ? (
                    <p>
                      Period {period} for <strong>{patientName}</strong> can&apos;t be restored because a newer
                      authorization period already exists. It stays expired.
                    </p>
                  ) : (
                    <>
                      <p>
                        Removes the Expired mark from Period {period} for <strong>{patientName}</strong>.
                        Session statuses, dates, counts, claims and amounts were never changed by Mark Expired,
                        so nothing else changes now.
                      </p>
                      <p>
                        Authorized <strong>{authorized}</strong> · completed <strong>{completed}</strong>
                        {unused > 0
                          ? <> · <strong>{unused}</strong> session(s) become available again.</>
                          : <> · no sessions become available (all were used).</>}
                      </p>
                    </>
                  )
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
                      <span> Session statuses, claims and amounts are not changed. Sessions dated after today can&apos;t be recorded on this period.</span>
                    </p>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {expired && !restoreBlocked && (
            <div className="space-y-1.5">
              <Label htmlFor={`restore-reason-${period}`}>Reason for restoring (required)</Label>
              <Textarea
                id={`restore-reason-${period}`}
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Marked expired by mistake — payer confirmed authorization is still valid"
                disabled={mutation.isPending}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>{restoreBlocked ? 'Close' : 'Cancel'}</AlertDialogCancel>
            {!restoreBlocked && (
              <AlertDialogAction
                disabled={!canConfirm}
                onClick={(e) => { e.preventDefault(); confirm(); }}
                className={expired ? '' : 'bg-slate-700 hover:bg-slate-800 text-white'}
              >
                {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                {expired ? 'Restore Period' : 'Mark Expired'}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** What a count correction will do to a period's session rows. Mirrors
 *  correct_auth_period_sessions_with_audit so the dialog can say it up front. */
export function describePeriodCountCorrection(input: { authorized: number; completed: number; sessionRows: number; next: number }) {
  const { authorized, completed, sessionRows, next } = input;
  if (!Number.isInteger(next) || next < 1 || next > 200) return { ok: false as const, message: 'Enter a whole number of sessions from 1 to 200.' };
  if (next < completed) return { ok: false as const, message: `Can't be lower than the ${completed} completed session(s) in this period.` };
  if (next === authorized) return { ok: false as const, message: 'This is already the authorized count.' };
  const oneRowPerSession = sessionRows >= authorized;
  const added = oneRowPerSession && next > sessionRows ? next - sessionRows : 0;
  const removed = oneRowPerSession && next < sessionRows ? sessionRows - next : 0;
  return { ok: true as const, added, removed };
}

/**
 * P4-P32: correct ONE authorization period's authorized session count. The
 * count stays owned by the period (its rows), never by the patient.
 * Completed sessions, dates, clinical/workflow fields and money are kept; a
 * decrease only removes empty session rows and is refused, with nothing
 * changed, below completed sessions or over rows that hold data. An Expired
 * period can't be corrected (restore it first), so a count edit can never
 * reactivate it.
 */
export function CorrectPeriodCountControl({
  patientId,
  patientName,
  period,
  authorized,
  completed,
  sessionRows,
  expired,
  className = '',
}: {
  patientId: string;
  patientName: string;
  period: number;
  authorized: number;
  completed: number;
  sessionRows: number;
  expired: boolean;
  className?: string;
}) {
  const refresh = useRefreshAfterAuthorizationChange();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  const guard = useRef(createSingleFlightGuard());
  const mutation = trpc.visits.correctPeriodSessions.useMutation({
    onSettled: () => guard.current.exit(),
    onSuccess: (data, vars) => {
      const rows = [
        data.added > 0 ? `${data.added} session row(s) added` : null,
        data.removed > 0 ? `${data.removed} empty session row(s) removed` : null,
      ].filter(Boolean).join(', ');
      toast.success(data.changed
        ? `Period ${vars.authPeriod} corrected to ${data.sessionsAuthorized} sessions${rows ? ` (${rows})` : ''}`
        : `Period ${vars.authPeriod} already has ${data.sessionsAuthorized} sessions, nothing changed`);
      setOpen(false);
      refresh(vars.patientId);
    },
    onError: (err, vars) => {
      setServerError(err.message || 'Failed to correct the session count');
      toast.error(err.message || 'Failed to correct the session count');
      // The count may have changed elsewhere; show the current one.
      refresh(vars.patientId);
    },
  });

  const openDialog = () => {
    setValue(authorized > 0 ? String(authorized) : '');
    setReason('');
    setServerError(null);
    setOpen(true);
  };

  const next = Number(value);
  const plan = describePeriodCountCorrection({ authorized, completed, sessionRows, next });
  const canConfirm = !expired && !mutation.isPending && value.trim() !== '' && plan.ok;
  const minimum = Math.max(1, completed);

  let hint: string;
  if (value.trim() === '') hint = `At least ${minimum}.`;
  else if (!plan.ok) hint = plan.message;
  else if (plan.added > 0) hint = `${plan.added} empty session row(s) will be added.`;
  else if (plan.removed > 0) hint = `${plan.removed} empty session row(s), the highest-numbered ones without a date of service, will be removed. If any of them holds data, nothing is changed.`;
  else hint = 'Only the count changes. No session rows are added or removed.';

  const confirm = () => {
    if (!canConfirm || !guard.current.tryEnter()) return;
    setServerError(null);
    mutation.mutate({
      patientId,
      authPeriod: period,
      sessionsAuthorized: next,
      expectedCurrent: authorized,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={openDialog}
        aria-label={`Correct session count for Authorization Period ${period}`}
        className={`bg-white text-slate-700 border-slate-300 hover:bg-slate-50 ${className}`}
      >
        <Pencil className="w-4 h-4" />
        Correct Count
      </Button>
      <Dialog open={open} onOpenChange={(nextOpen) => { if (!mutation.isPending) setOpen(nextOpen); }}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-brand-blue">Correct Sessions Authorized: Period {period}</DialogTitle>
            <DialogDescription>
              Authorization Period {period} for <strong>{patientName}</strong>. Only this period changes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <dl className="grid grid-cols-3 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-center text-sm">
              <div><dt className="text-xs text-slate-500">Current</dt><dd className="font-semibold text-brand-blue">{authorized}</dd></div>
              <div><dt className="text-xs text-slate-500">Completed</dt><dd className="font-semibold text-brand-blue">{completed}</dd></div>
              <div><dt className="text-xs text-slate-500">Remaining</dt><dd className="font-semibold text-brand-blue">{expired ? 0 : Math.max(0, authorized - completed)}</dd></div>
            </dl>
            {expired ? (
              <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                Period {period} is marked Expired, so its count can&apos;t be corrected here. Restore the period first
                (only possible while no newer period exists). Correcting a count never reactivates an expired period.
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`correct-count-${period}`} className="text-brand-blue font-semibold">
                    Correct Sessions Authorized <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id={`correct-count-${period}`}
                    type="number"
                    inputMode="numeric"
                    min={minimum}
                    max={200}
                    value={value}
                    onChange={(e) => { setValue(e.target.value); setServerError(null); }}
                    disabled={mutation.isPending}
                  />
                  <p className="text-xs text-slate-500" aria-live="polite">{hint}</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`correct-reason-${period}`}>Reason <span className="text-gray-400 font-normal">(optional, saved in history)</span></Label>
                  <Textarea
                    id={`correct-reason-${period}`}
                    value={reason}
                    maxLength={500}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Payer approval letter lists 20 sessions, not 16"
                    disabled={mutation.isPending}
                  />
                </div>
                <p className="text-xs text-slate-500">
                  Completed sessions, dates of service, statuses, workflow fields and payment amounts are kept.
                </p>
              </>
            )}
            {serverError && (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{serverError}</p>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row">
            <Button variant="outline" className="flex-1" onClick={() => setOpen(false)} disabled={mutation.isPending}>
              {expired ? 'Close' : 'Cancel'}
            </Button>
            {!expired && (
              <Button className="flex-1 bg-brand-blue hover:bg-brand-blue/90 text-white" onClick={confirm} disabled={!canConfirm}>
                {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                Save Correction
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
