/**
 * Hold Request for Authorization — shared by the Dashboard's Authorization
 * Alerts, the patient details alert and the "Authorization Requests on Hold"
 * card. Classification (what counts as held / actionable) lives in ONE place:
 * shared/authRequestHold.ts classifyAuthorizationAlert.
 *
 * A hold never changes the authorization itself (status, period, expiry,
 * sessions, claims) and never ends on its own: only Remove Hold / Resume
 * ends it, after which the server re-derives the patient's category.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, PauseCircle, PlayCircle } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { formatTimestamp } from '@/lib/date';
import { createSingleFlightGuard } from '@/lib/concurrencyGuards';
import { HOLD_REASON_MAX, heldAuthorizationAlerts, isHoldEffective, isHoldSuperseded, normalizeHoldReason, type AuthorizationRequestHoldInfo } from '@shared/authRequestHold';
import { useRefreshAfterAuthorizationChange } from './AuthorizationActions';

export interface HoldTarget {
  patientId: string;
  patientName: string;
  /** The period the alert is about (null = no period yet) — the hold's scope. */
  authPeriod: number | null;
}

export interface ReleaseTarget {
  patientId: string;
  patientName: string;
  holdId: string;
}

function periodLabel(authPeriod: number | null) {
  return authPeriod === null ? 'the initial authorization request' : `authorization period ${authPeriod}`;
}

/** "Hold Request" button for an alert row / the patient details alert. */
export function HoldRequestButton({ onClick, className = 'h-7 text-xs' }: { onClick: () => void; className?: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`${className} border-amber-300 text-amber-800 hover:bg-amber-50`}
    >
      <PauseCircle className="w-3 h-3" /> Hold Request
    </Button>
  );
}

/** Reason + explicit confirmation. Confirm stays disabled until the trimmed reason is nonblank. */
export function HoldAuthorizationRequestDialog({ target, onClose }: { target: HoldTarget | null; onClose: () => void }) {
  const refresh = useRefreshAfterAuthorizationChange();
  const [reason, setReason] = useState('');
  // Why the last attempt failed. The dialog stays open with the reason kept.
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { if (target) { setReason(''); setFailure(null); } }, [target?.patientId, target?.authPeriod]);

  const guard = useRef(createSingleFlightGuard());
  const hold = trpc.visits.holdAuthorizationRequest.useMutation({
    onSettled: () => guard.current.exit(),
    // Only after the server confirms the hold (and its audit row) is saved.
    onSuccess: (data, { patientId }) => {
      toast.success(data.changed ? 'Authorization request put on hold' : 'This authorization request was already on hold');
      onClose();
      refresh(patientId);
    },
    // Nothing was held: keep the dialog and the typed reason, say why.
    onError: (err, { patientId }) => {
      const message = err.message || 'Failed to hold authorization request. Your reason is kept — try again.';
      setFailure(message);
      toast.error(message);
      refresh(patientId);
    },
  });

  const normalized = normalizeHoldReason(reason);
  const submit = () => {
    if (!target || !normalized) return;
    if (!guard.current.tryEnter()) return;
    setFailure(null);
    hold.mutate({ patientId: target.patientId, authPeriod: target.authPeriod, reason: normalized });
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open && !hold.isPending) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Hold Request for Authorization</DialogTitle>
          <DialogDescription>
            {target ? `${target.patientName} — ${periodLabel(target.authPeriod)}. ` : ''}
            The request leaves Authorization Alerts until you remove the hold. Nothing else changes: status, sessions, expiry and claims stay as they are.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="hold-reason">Reason (required)</Label>
          <Textarea
            id="hold-reason"
            value={reason}
            maxLength={HOLD_REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Waiting for updated referral from physician"
            aria-invalid={reason.length > 0 && !normalized}
            aria-describedby="hold-reason-help"
          />
          <p id="hold-reason-help" className="text-xs text-muted-foreground">
            {reason.length > 0 && !normalized ? 'Enter a reason, not just spaces.' : `${reason.trim().length}/${HOLD_REASON_MAX}`}
          </p>
          {failure && (
            <p role="alert" className="text-xs font-medium text-red-700 bg-red-50 rounded px-2 py-1.5">{failure}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={hold.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={!normalized || hold.isPending} className="bg-brand-blue text-white hover:bg-brand-blue-dark">
            {hold.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Hold Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Remove Hold / Resume confirmation. The server re-derives the category from current data. */
export function ReleaseAuthorizationHoldDialog({ target, onClose }: { target: ReleaseTarget | null; onClose: () => void }) {
  const refresh = useRefreshAfterAuthorizationChange();
  const guard = useRef(createSingleFlightGuard());
  const release = trpc.visits.releaseAuthorizationRequestHold.useMutation({
    onSettled: () => guard.current.exit(),
    onSuccess: (data, { patientId }) => {
      if (!data.changed) toast.info('This hold was already removed');
      else toast.success(data.category === 'attention'
        ? 'Hold removed — back in Authorization Alerts'
        : data.category === 'inactive'
          ? 'Hold removed — patient is discharged, so no authorization alert'
          : 'Hold removed — no authorization action needed right now');
      onClose();
      refresh(patientId);
    },
    onError: (err, { patientId }) => {
      toast.error(err.message || 'Failed to remove hold');
      refresh(patientId);
    },
  });
  const submit = () => {
    if (!target || !guard.current.tryEnter()) return;
    release.mutate({ patientId: target.patientId, holdId: target.holdId });
  };
  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open && !release.isPending) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove Hold / Resume</DialogTitle>
          <DialogDescription>
            {target?.patientName}'s authorization is re-checked from current data. It returns to Authorization Alerts only if it still needs attention.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={release.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={release.isPending} className="bg-brand-blue text-white hover:bg-brand-blue-dark">
            {release.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Remove Hold
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Who/when/why line shared by the hold list and the patient details banner. */
export function HoldDetails({ hold }: { hold: AuthorizationRequestHoldInfo }) {
  return (
    <div className="text-xs text-muted-foreground space-y-0.5">
      <p className="text-brand-blue break-words"><span className="font-semibold">Reason:</span> {hold.reason}</p>
      <p>Held {formatTimestamp(hold.heldAt)} by {hold.heldByDisplay}</p>
    </div>
  );
}

/** "Authorization Requests on Hold" summary card + list. */
export function AuthorizationHoldsPanel({ onSelectPatient }: { onSelectPatient: (id: string) => void }) {
  const { data: alerts = [], isLoading, error } = trpc.visits.authAlerts.useQuery();
  const [releaseTarget, setReleaseTarget] = useState<ReleaseTarget | null>(null);
  const held = heldAuthorizationAlerts(alerts).sort((a, b) => a.patientName.localeCompare(b.patientName));
  // The badge counts holds that actually defer a request (effective on the
  // current period) — the same number as the Dashboard's "Pending
  // Authorization Request" card. Superseded holds are still listed so they
  // can be removed, but they no longer hide anything, so they are not counted.
  const effectiveCount = held.filter(isHoldEffective).length;
  const supersededCount = held.length - effectiveCount;

  return (
    <Card className="border-border shadow-sm rounded-xl flex flex-col py-0 gap-0 overflow-hidden">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border px-4 py-3 [.border-b]:pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-brand-blue">
          <PauseCircle className="w-4 h-4 text-amber-600" />
          Authorization Requests on Hold
        </CardTitle>
        <Badge variant="secondary" className="rounded-full min-w-5 h-5 px-1.5 justify-center" aria-label={`${effectiveCount} on hold`}>
          {effectiveCount}
        </Badge>
      </CardHeader>
      {supersededCount > 0 && (
        <p className="px-4 py-1.5 text-xs text-muted-foreground border-b border-border">
          Also listed: {supersededCount} superseded {supersededCount === 1 ? 'hold' : 'holds'} (not counted — a newer period exists).
        </p>
      )}
      <CardContent className="p-0 max-h-[350px] overflow-y-auto">
        {error ? (
          <p className="p-4 text-sm text-red-700">Could not load holds. Please refresh.</p>
        ) : isLoading ? (
          <div className="p-3"><div className="h-12 rounded-lg bg-gray-100 animate-pulse" /></div>
        ) : held.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No authorization requests are on hold.</p>
        ) : (
          <ul className="divide-y divide-border">
            {held.map(a => {
              const hold = a.hold!;
              const superseded = isHoldSuperseded(a);
              return (
                <li key={a.patientId} className="px-3 py-2.5 space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <button onClick={() => onSelectPatient(a.patientId)} className="min-w-0 text-left">
                      <p className="font-semibold text-sm text-brand-blue truncate">{a.patientName}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {a.insurance || '—'} · {hold.authPeriod === null ? 'Initial request' : `Period ${hold.authPeriod}`}
                        {' · '}{a.isActive ? 'Active' : <span className="font-semibold text-red-700">Discharged</span>}
                      </p>
                    </button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs shrink-0"
                      onClick={() => setReleaseTarget({ patientId: a.patientId, patientName: a.patientName, holdId: hold.holdId })}
                    >
                      <PlayCircle className="w-3 h-3" /> Remove Hold / Resume
                    </Button>
                  </div>
                  <HoldDetails hold={hold} />
                  {superseded && (
                    <p className="text-xs font-medium text-amber-800 bg-amber-50 rounded px-2 py-1">
                      Superseded: a newer authorization period exists, so this hold no longer hides any alert.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <ReleaseAuthorizationHoldDialog target={releaseTarget} onClose={() => setReleaseTarget(null)} />
    </Card>
  );
}
