import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  BellRing,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';

const URGENCY_CONFIG = {
  exhausted: {
    label: 'Sessions Exhausted',
    sublabel: 'Request authorization ASAP',
    icon: <XCircle className="w-4 h-4" />,
    cardClass: 'border-l-4 border-red-500 bg-red-50',
    badgeClass: 'bg-red-100 text-red-800',
    iconClass: 'text-red-600',
  },
  critical: {
    label: 'Critical — 1-2 Sessions Left',
    sublabel: 'Request new authorization immediately',
    icon: <ShieldAlert className="w-4 h-4" />,
    cardClass: 'border-l-4 border-orange-500 bg-orange-50',
    badgeClass: 'bg-orange-100 text-orange-800',
    iconClass: 'text-orange-600',
  },
  warning: {
    label: 'Warning — 3 Sessions Left',
    sublabel: 'Request new authorization soon',
    icon: <AlertTriangle className="w-4 h-4" />,
    cardClass: 'border-l-4 border-yellow-400 bg-yellow-50',
    badgeClass: 'bg-yellow-100 text-yellow-800',
    iconClass: 'text-yellow-600',
  },
  pending: {
    label: 'Authorization Pending',
    sublabel: 'Follow up with insurance',
    icon: <Clock className="w-4 h-4" />,
    cardClass: 'border-l-4 border-blue-400 bg-blue-50',
    badgeClass: 'bg-blue-100 text-blue-800',
    iconClass: 'text-blue-600',
  },
  ok: {
    label: 'On Track',
    sublabel: '',
    icon: <ShieldCheck className="w-4 h-4" />,
    cardClass: 'border-l-4 border-green-400 bg-green-50',
    badgeClass: 'bg-green-100 text-green-800',
    iconClass: 'text-green-600',
  },
};

const insuranceList = [
  'AARP Medicare Advantage',
  'AARP Medicare Supplement',
  'Aetna',
  'Aetna International',
  'American Transit',
  'Cigna Healthcare',
  'Emblem Health',
  'Emblem Health GHI Senior',
  'Empire NYSHIP (United Healthcare)',
  'GEICO NY PIP',
  'Global Excel Management',
  'Humana',
  'Kaiser Permanente',
  'Medicare - Queens (Part B)',
  'Meritain Health',
  'NYCE PPO Plan',
  'NY Empire BCBS',
  'Oxford Health Insurance',
  'Progressive No Fault',
  'United Healthcare',
  'United Healthcare Medicare',
];

export function AuthAlertPanel({ onSelectPatient }: { onSelectPatient: (id: string) => void }) {
  const utils = trpc.useUtils();
  const { data: alerts = [], isLoading, error } = trpc.visits.authAlerts.useQuery();
  const [requestingId, setRequestingId] = useState<string | null>(null);

  // New Authorization dialog state
  const [approveDialogPatient, setApproveDialogPatient] = useState<{ id: string; name: string; insurance: string } | null>(null);
  const [newSessions, setNewSessions] = useState('');
  const [newAuthDate, setNewAuthDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [newInsurance, setNewInsurance] = useState('');
  const [newAuthValidUntil, setNewAuthValidUntil] = useState('');

  const approveAuthorization = trpc.visits.approveAuthorization.useMutation({
    onSuccess: (data, { patientId }) => {
      toast.success(`Authorization approved — ${data.newVisitCount} new session records created`);
      setApproveDialogPatient(null);
      setNewSessions('');
      setNewInsurance('');
      setNewAuthValidUntil('');
      utils.visits.authAlerts.invalidate();
      utils.visits.listByPatient.invalidate({ patientId });
      utils.patients.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to approve authorization');
    },
  });

  const handleApproveSubmit = () => {
    if (!approveDialogPatient) return;
    const count = parseInt(newSessions, 10);
    if (!count || count < 1) { toast.error('Please enter a valid session count'); return; }
    const authValidUntilMs = newAuthValidUntil
      ? new Date(newAuthValidUntil + 'T00:00:00Z').getTime()
      : null;
    approveAuthorization.mutate({
      patientId: approveDialogPatient.id,
      sessionsAuthorized: count,
      authDate: newAuthDate || null,
      newInsurance: newInsurance || undefined,
      authValidUntil: authValidUntilMs,
    });
  };

  const markAsRequested = trpc.visits.markAsRequested.useMutation({
    onMutate: ({ patientId }) => setRequestingId(patientId as string),
    onSuccess: (_data, { patientId }) => {
      toast.success('Authorization request marked — ASH date set to today');
      // Optimistically remove the card if it was 'pending' urgency; otherwise refresh
      utils.visits.authAlerts.invalidate();
      // Also refresh the patient's visit list in case it's open
      utils.visits.listByPatient.invalidate({ patientId });
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to mark as requested');
    },
    onSettled: () => setRequestingId(null),
  });

  // Only show patients that need attention (not 'ok')
  const urgent = alerts
    .filter(a => a.urgency !== 'ok')
    .sort((a, b) => {
      const order = { exhausted: 0, critical: 1, warning: 2, pending: 3, ok: 4 };
      return order[a.urgency] - order[b.urgency];
    });

  return (
    <Card className="border-border shadow-sm rounded-xl h-full flex flex-col py-0 gap-0 overflow-hidden">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border px-4 py-3 shrink-0 [.border-b]:pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-brand-blue">
          <BellRing className="w-4 h-4 text-brand-gold" />
          Authorization Alerts
        </CardTitle>
        {urgent.length > 0 && (
          <Badge variant="destructive" className="rounded-full min-w-5 h-5 px-1.5 justify-center">
            {urgent.length}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="p-0 flex-1 min-h-0 overflow-y-auto max-h-[350px]">
        {error ? (
          <div className="flex items-start gap-2.5 p-4 text-sm">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <p className="text-red-700">Could not load authorization alerts. Please refresh.</p>
          </div>
        ) : isLoading ? (
          <div className="p-3 space-y-2">
            {[1, 2].map(i => <div key={i} className="h-16 rounded-lg bg-gray-100 animate-pulse" />)}
          </div>
        ) : urgent.length === 0 ? (
          <div className="flex items-start gap-2.5 p-4 text-sm">
            <ShieldCheck className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
            <p className="text-green-700">All patients are on track. No authorization requests needed.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {urgent.map(alert => {
              const cfg = URGENCY_CONFIG[alert.urgency];
              const isRequesting = requestingId === alert.patientId;
              const alreadyPending = alert.authStatus === 'pending';
              return (
                <div key={alert.patientId} className={cfg.cardClass}>
                  <button onClick={() => onSelectPatient(alert.patientId)} className="w-full text-left px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <span className={`mt-0.5 shrink-0 ${cfg.iconClass}`}>{cfg.icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-semibold text-sm text-brand-blue truncate">{alert.patientName}</p>
                          {alert.sessionsRemaining !== null && (
                            <span className="shrink-0 text-xs font-semibold text-gray-600">{alert.sessionsRemaining} left</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{alert.insurance}</p>
                        <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${cfg.badgeClass}`}>
                          {alert.authExpiryWarning ? 'Auth Expiring Soon' : cfg.label}
                        </span>
                      </div>
                    </div>
                  </button>
                  <div className="px-3 pb-2.5 flex gap-2">
                    {!alreadyPending && (
                      <Button
                        size="sm"
                        disabled={isRequesting}
                        onClick={(e) => { e.stopPropagation(); markAsRequested.mutate({ patientId: alert.patientId }); }}
                        className="flex-1 h-7 text-xs bg-brand-blue text-white hover:bg-brand-blue-dark"
                      >
                        {isRequesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                        Mark Requested
                      </Button>
                    )}
                    {alreadyPending && (
                      <>
                        <Button
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setApproveDialogPatient({ id: alert.patientId, name: alert.patientName, insurance: alert.insurance ?? '' });
                            setNewSessions('');
                            setNewAuthDate(new Date().toISOString().split('T')[0]);
                            setNewInsurance(alert.insurance ?? '');
                            setNewAuthValidUntil('');
                          }}
                          className="flex-1 h-7 text-xs bg-green-600 text-white hover:bg-green-700"
                        >
                          <ShieldCheck className="w-3 h-3" /> Approved
                        </Button>
                        <Button
                          size="sm"
                          disabled={isRequesting}
                          onClick={(e) => { e.stopPropagation(); markAsRequested.mutate({ patientId: alert.patientId }); }}
                          className="flex-1 h-7 text-xs bg-blue-100 text-blue-700 hover:bg-blue-200"
                        >
                          <CheckCircle2 className="w-3 h-3" /> Re-request
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* New Authorization Dialog */}
      <Dialog open={!!approveDialogPatient} onOpenChange={(open) => { if (!open) { setApproveDialogPatient(null); setNewAuthValidUntil(''); } }}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-brand-blue flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-green-600" />
              New Authorization Approved
            </DialogTitle>
            <DialogDescription>
              Enter the new authorization details for <strong>{approveDialogPatient?.name}</strong>.
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
              <Select
                value={newInsurance}
                onValueChange={setNewInsurance}
              >
                <SelectTrigger id="new-insurance" className="border-brand-blue/30 focus:border-brand-blue">
                  <SelectValue placeholder="Select insurance company" />
                </SelectTrigger>
                <SelectContent>
                  {/* Show current insurance at top if it's not in the standard list */}
                  {approveDialogPatient?.insurance &&
                    !insuranceList.includes(approveDialogPatient.insurance) && (
                    <SelectItem value={approveDialogPatient.insurance}>{approveDialogPatient.insurance} (current)</SelectItem>
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
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setApproveDialogPatient(null)}
              disabled={approveAuthorization.isPending}
            >
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
    </Card>
  );
}
