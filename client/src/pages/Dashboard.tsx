import { useState, useMemo, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertCircle, CheckCircle2, Clock, Users, Plus, ChevronLeft, Calendar, Upload, Download, Loader2, RefreshCw, Trash2, LogOut, BellRing, ShieldAlert, ShieldCheck, AlertTriangle, XCircle, UserX, UserCheck, Eye, EyeOff, Columns3, Search, X, SlidersHorizontal } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter, SheetTrigger } from '@/components/ui/sheet';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { findMatchingPatient, fuzzyNameMatch } from '@/lib/nameMatch';
import logoIcon from '@/assets/logos/logo-icon.png';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { PatientListItem } from '@/components/dashboard/PatientListItem';
import { FilterChips } from '@/components/dashboard/FilterChips';

/**
 * Dashboard Component — Database-backed
 * All data persists in MySQL via tRPC procedures.
 * "Date ASH Submitted" column is editable inline with a native date picker.
 */

const LOGO_URL = logoIcon;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DbPatient {
  id: string;
  name: string;
  insurance: string;
  authDate: Date | null;
  authValidUntil: number | null;
  isActive: boolean;
  dischargeDate: number | null;
  dischargeReason: string | null;
  claimsStatus: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DbVisit {
  id: string;
  patientId: string;
  sessionsAuthorized: number | null;
  sessionsRemaining: number | null;
  sessionNumber: number | null;
  authPeriod: number;
  dateOfService: Date | null;
  newAuth: string | null;
  dateAshSubmitted: Date | null;
  authStatus: 'none' | 'pending' | 'approved' | 'denied';
  createdAt: Date;
  updatedAt: Date;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

const CLAIM_STATUS_FILTERS = [
  { value: 'all', label: 'All Claims', color: 'bg-gray-100 text-gray-800' },
  { value: 'submitted', label: 'Submitted', color: 'bg-blue-100 text-blue-800' },
  { value: 'approved', label: 'Approved', color: 'bg-green-100 text-green-800' },
  { value: 'pending', label: 'Pending', color: 'bg-yellow-100 text-yellow-800' },
  { value: 'denied', label: 'Denied', color: 'bg-red-100 text-red-800' },
  { value: 'pended', label: 'Pended', color: 'bg-orange-100 text-orange-800' },
  { value: 'rejected', label: 'Rejected', color: 'bg-gray-900 text-white' },
  { value: 'resubmitted', label: 'Resubmitted', color: 'bg-violet-100 text-violet-800' },
  { value: 'none', label: 'No Status', color: 'bg-gray-50 text-gray-500' },
];

/** Format a Date or date-string for display */
const formatDate = (d: Date | string | null | undefined): string => {
  if (!d) return '—';
  try {
    const dt = typeof d === 'string' ? new Date(d) : d;
    if (isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return String(d);
  }
};

/** Convert a Date to "YYYY-MM-DD" for <input type="date"> value */
const toInputDate = (d: Date | null | undefined): string => {
  if (!d) return '';
  try {
    const dt = typeof d === 'string' ? new Date(d) : d;
    if (isNaN(dt.getTime())) return '';
    return dt.toISOString().split('T')[0];
  } catch {
    return '';
  }
};

/** Compact colored dropdown for a visit's auth status. `onChange` receives the
 *  same '' | 'Pending' | 'Approved' | 'Denied' shape handleUpdateAuthStatus expects. */
function VisitAuthStatusSelect({ visit, onChange }: { visit: DbVisit; onChange: (visitId: string, status: string) => void }) {
  const value = visit.authStatus === 'none' ? 'none' : visit.authStatus.charAt(0).toUpperCase() + visit.authStatus.slice(1);
  const colorClass =
    visit.authStatus === 'approved' ? 'bg-green-100 text-green-700' :
    visit.authStatus === 'denied' ? 'bg-red-100 text-red-700' :
    visit.authStatus === 'pending' ? 'bg-yellow-100 text-yellow-700' :
    'bg-gray-100 text-gray-600';
  return (
    <Select value={value} onValueChange={(v) => onChange(visit.id, v === 'none' ? '' : v)}>
      <SelectTrigger
        size="sm"
        aria-label="Auth status"
        className={`h-auto w-auto border-0 rounded-full px-3 py-1 text-xs font-medium shadow-none ${colorClass}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">— None —</SelectItem>
        <SelectItem value="Pending">Pending</SelectItem>
        <SelectItem value="Approved">Approved</SelectItem>
        <SelectItem value="Denied">Denied</SelectItem>
      </SelectContent>
    </Select>
  );
}

// ─── Authorization Alert Panel ──────────────────────────────────────────────────────

const URGENCY_CONFIG = {
  exhausted: {
    label: 'Sessions Exhausted',
    sublabel: 'Request authorization ASAP',
    icon: <XCircle className="w-5 h-5" />,
    cardClass: 'border-l-4 border-red-500 bg-red-50',
    badgeClass: 'bg-red-100 text-red-800',
    iconClass: 'text-red-600',
  },
  critical: {
    label: 'Critical — 1-2 Sessions Left',
    sublabel: 'Request new authorization immediately',
    icon: <ShieldAlert className="w-5 h-5" />,
    cardClass: 'border-l-4 border-orange-500 bg-orange-50',
    badgeClass: 'bg-orange-100 text-orange-800',
    iconClass: 'text-orange-600',
  },
  warning: {
    label: 'Warning — 3 Sessions Left',
    sublabel: 'Request new authorization soon',
    icon: <AlertTriangle className="w-5 h-5" />,
    cardClass: 'border-l-4 border-yellow-400 bg-yellow-50',
    badgeClass: 'bg-yellow-100 text-yellow-800',
    iconClass: 'text-yellow-600',
  },
  pending: {
    label: 'Authorization Pending',
    sublabel: 'Follow up with insurance',
    icon: <Clock className="w-5 h-5" />,
    cardClass: 'border-l-4 border-blue-400 bg-blue-50',
    badgeClass: 'bg-blue-100 text-blue-800',
    iconClass: 'text-blue-600',
  },
  ok: {
    label: 'On Track',
    sublabel: '',
    icon: <ShieldCheck className="w-5 h-5" />,
    cardClass: 'border-l-4 border-green-400 bg-green-50',
    badgeClass: 'bg-green-100 text-green-800',
    iconClass: 'text-green-600',
  },
};

function AuthAlertPanel({ onSelectPatient }: { onSelectPatient: (id: string) => void }) {
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

  if (error) {
    return (
      <div className="mb-6 flex items-center gap-3 bg-red-50 border-l-4 border-red-500 rounded-lg p-4">
        <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
        <div>
          <p className="font-semibold text-red-800">Could not load authorization alerts</p>
          <p className="text-sm text-red-700">Please refresh the page to try again.</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <BellRing className="w-5 h-5 text-brand-gold" />
          <h2 className="text-lg font-bold text-brand-blue">Authorization Alerts</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[1, 2].map(i => (
            <div key={i} className="h-20 rounded-lg bg-gray-100 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (urgent.length === 0) {
    return (
      <div className="mb-6 flex items-center gap-3 bg-green-50 border-l-4 border-green-500 rounded-lg p-4">
        <ShieldCheck className="w-5 h-5 text-green-600 shrink-0" />
        <div>
          <p className="font-semibold text-green-800">All patients are on track</p>
          <p className="text-sm text-green-700">No authorization requests needed at this time.</p>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <BellRing className="w-5 h-5 text-brand-gold animate-bounce" />
        <h2 className="text-lg font-bold text-brand-blue">Authorization Alerts</h2>
        <Badge variant="destructive" className="ml-1 rounded-full w-6 h-6 p-0 justify-center">
          {urgent.length}
        </Badge>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[28rem] overflow-y-auto pr-1">
        {urgent.map(alert => {
          const cfg = URGENCY_CONFIG[alert.urgency];
          const isRequesting = requestingId === alert.patientId;
          // Show Approved/Re-request buttons whenever the auth status is pending,
          // regardless of sessions remaining (exhausted + pending is the most urgent case)
          const alreadyPending = alert.authStatus === 'pending';
          return (
            <div
              key={alert.patientId}
              className={`rounded-xl shadow-sm hover:shadow-md transition-all ${cfg.cardClass}`}
            >
              {/* Top clickable area — opens patient detail */}
              <button
                onClick={() => onSelectPatient(alert.patientId)}
                className="w-full text-left p-4 pb-2"
              >
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 shrink-0 ${cfg.iconClass}`}>{cfg.icon}</span>
                  <div className="min-w-0">
                    <p className="font-bold text-brand-blue truncate">{alert.patientName}</p>
                    <p className="text-xs text-muted-foreground truncate">{alert.insurance}</p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${cfg.badgeClass}`}>
                        {alert.authExpiryWarning ? 'Auth Expiring Soon' : cfg.label}
                      </span>
                      {alert.sessionsRemaining !== null && (
                        <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-700">
                          {alert.sessionsRemaining} remaining
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {alert.authExpiryWarning ? 'Request new authorization before expiry date' : cfg.sublabel}
                    </p>
                    {alert.dateAshSubmitted && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Last submitted: {new Date(alert.dateAshSubmitted).toLocaleDateString()}
                      </p>
                    )}
                    {alert.authValidUntil && (() => {
                      const now = Date.now();
                      const daysLeft = Math.ceil((alert.authValidUntil - now) / (1000 * 60 * 60 * 24));
                      const expired = daysLeft < 0;
                      const expiresSoon = !expired && daysLeft <= 7;
                      return (
                        <p className={`text-xs mt-0.5 font-semibold ${
                          expired ? 'text-red-600' : expiresSoon ? 'text-orange-600' : 'text-gray-500'
                        }`}>
                          {expired
                            ? `Auth expired ${Math.abs(daysLeft)}d ago (${new Date(alert.authValidUntil).toLocaleDateString()})`
                            : expiresSoon
                            ? `Auth expires in ${daysLeft}d — ${new Date(alert.authValidUntil).toLocaleDateString()}`
                            : `Auth valid until ${new Date(alert.authValidUntil).toLocaleDateString()}`
                          }
                        </p>
                      );
                    })()}
                  </div>
                </div>
              </button>

              {/* Action buttons */}
              <div className="px-4 pb-3 flex gap-2">
                {/* Mark as Requested — only for non-pending cards */}
                {!alreadyPending && (
                  <Button
                    size="sm"
                    disabled={isRequesting}
                    onClick={(e) => {
                      e.stopPropagation();
                      markAsRequested.mutate({ patientId: alert.patientId });
                    }}
                    className="flex-1 mt-1 bg-brand-blue text-white hover:bg-brand-blue-dark active:scale-[0.97]"
                  >
                    {isRequesting ? (
                      <><Loader2 className="w-3 h-3 animate-spin" /> Saving…</>
                    ) : (
                      <><CheckCircle2 className="w-3 h-3" /> Mark as Requested</>
                    )}
                  </Button>
                )}

                {/* Approved — only for pending cards */}
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
                      className="flex-1 mt-1 bg-green-600 text-white hover:bg-green-700 active:scale-[0.97]"
                    >
                      <ShieldCheck className="w-3 h-3" /> Approved
                    </Button>
                    <Button
                      size="sm"
                      disabled={isRequesting}
                      onClick={(e) => {
                        e.stopPropagation();
                        markAsRequested.mutate({ patientId: alert.patientId });
                      }}
                      className="flex-1 mt-1 bg-blue-100 text-blue-700 hover:bg-blue-200 active:scale-[0.97]"
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
    </div>

    {/* New Authorization Dialog */}
    <Dialog open={!!approveDialogPatient} onOpenChange={(open) => { if (!open) { setApproveDialogPatient(null); setNewAuthValidUntil(''); } }}>
      <DialogContent className="sm:max-w-md">
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
    </>
  );
}

// ─── Claims Follow-Up Alert Panel ───────────────────────────────────────────
// Card color per claim_status, per product spec:
// Rejected=Black, Denied=Red, Pending=Yellow, Pended=Orange, Approved=Green,
// Resubmitted=Violet, Submitted=Blue.
const FOLLOW_UP_CARD_STYLES: Record<string, { card: string; hover: string; border: string; patientText: string; metaText: string; chargedLabel: string; chargedVal: string; badge: string; badgeText: string; reasonText: string }> = {
  rejected:    { card: 'bg-gray-900',   hover: 'hover:bg-gray-800',   border: 'border-gray-700',   patientText: 'text-white', metaText: 'text-gray-300',   chargedLabel: 'text-gray-400',   chargedVal: 'text-red-300', badge: 'bg-white/20',  badgeText: 'text-white', reasonText: 'text-red-300' },
  denied:      { card: 'bg-red-600',    hover: 'hover:bg-red-700',    border: 'border-red-500',    patientText: 'text-white', metaText: 'text-red-100',    chargedLabel: 'text-red-200',    chargedVal: 'text-white',   badge: 'bg-white/25',  badgeText: 'text-white', reasonText: 'text-red-100' },
  pended:      { card: 'bg-orange-500', hover: 'hover:bg-orange-600', border: 'border-orange-400', patientText: 'text-white', metaText: 'text-orange-100', chargedLabel: 'text-orange-200', chargedVal: 'text-white',   badge: 'bg-white/25',  badgeText: 'text-white', reasonText: 'text-orange-100' },
  pending:     { card: 'bg-yellow-400', hover: 'hover:bg-yellow-500', border: 'border-yellow-300', patientText: 'text-gray-900', metaText: 'text-gray-700', chargedLabel: 'text-gray-600', chargedVal: 'text-gray-900', badge: 'bg-black/10',  badgeText: 'text-gray-900', reasonText: 'text-gray-800' },
  submitted:   { card: 'bg-blue-600',   hover: 'hover:bg-blue-700',   border: 'border-blue-500',   patientText: 'text-white', metaText: 'text-blue-100',   chargedLabel: 'text-blue-200',   chargedVal: 'text-white',   badge: 'bg-white/25',  badgeText: 'text-white', reasonText: 'text-blue-100' },
  approved:    { card: 'bg-green-600',  hover: 'hover:bg-green-700',  border: 'border-green-500',  patientText: 'text-white', metaText: 'text-green-100',  chargedLabel: 'text-green-200',  chargedVal: 'text-white',   badge: 'bg-white/25',  badgeText: 'text-white', reasonText: 'text-green-100' },
  resubmitted: { card: 'bg-violet-500', hover: 'hover:bg-violet-600', border: 'border-violet-400', patientText: 'text-white', metaText: 'text-violet-100', chargedLabel: 'text-violet-200', chargedVal: 'text-white',   badge: 'bg-white/25',  badgeText: 'text-white', reasonText: 'text-violet-100' },
};

function ClaimsFollowUpPanel({ insurance, onSelectPatient }: { insurance?: string; onSelectPatient: (id: string) => void }) {
  const utils = trpc.useUtils();
  // Scoped by the same insurance filter as the Claims Status counts and the
  // Patients list, so this panel can never disagree with them on screen.
  const queryInput = { insurance: insurance || undefined };
  const { data: followUpClaims = [], isLoading } = trpc.claims.getFollowUpClaims.useQuery(queryInput);
  const markResolved = trpc.claims.markResolved.useMutation({
    onMutate: async ({ id }) => {
      // Optimistically remove the card immediately
      await utils.claims.getFollowUpClaims.cancel(queryInput);
      const prev = utils.claims.getFollowUpClaims.getData(queryInput);
      utils.claims.getFollowUpClaims.setData(queryInput, (old) =>
        (old ?? []).filter((c) => c.id !== id)
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      // Rollback on error
      if (ctx?.prev) utils.claims.getFollowUpClaims.setData(queryInput, ctx.prev);
    },
    onSettled: () => {
      utils.claims.getFollowUpClaims.invalidate();
      utils.claims.getStatusCounts.invalidate();
      // Also invalidate the claims tracker queries so the table rows
      // immediately reflect the updated 'pending' status
      utils.claims.getByPatientAndPeriod.invalidate();
    },
  });

  if (isLoading) {
    return (
      <div className="mb-6 bg-orange-50 border-l-4 border-orange-400 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <AlertCircle className="w-5 h-5 text-orange-500" />
          <h2 className="text-lg font-bold text-brand-blue">Claims Follow-Up Needed</h2>
        </div>
        <div className="text-sm text-gray-500">Loading claims…</div>
      </div>
    );
  }

  if (followUpClaims.length === 0) {
    return (
      <div className="mb-6 bg-green-50 border-l-4 border-green-500 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle2 className="w-5 h-5 text-green-500" />
          <h2 className="text-lg font-bold text-brand-blue">Claims Follow-Up</h2>
        </div>
        <p className="text-sm text-green-700">All billed claims have received insurance reimbursement. No follow-up needed.</p>
      </div>
    );
  }

  return (
    <div className="mb-6 bg-amber-50 border-l-4 border-amber-500 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-amber-500 animate-pulse" />
          <h2 className="text-lg font-bold text-brand-blue">Claims Follow-Up Needed</h2>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800">
            {followUpClaims.length} claim{followUpClaims.length !== 1 ? 's' : ''}
          </span>
        </div>
        <p className="text-xs text-gray-500">Rejected, denied, pended, or stale claims — review below</p>
      </div>
      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
        {followUpClaims.map((claim) => {
          const status = claim.claimStatus ?? 'submitted';
          const s = FOLLOW_UP_CARD_STYLES[status] ?? FOLLOW_UP_CARD_STYLES.rejected;
          return (
            <div
              key={claim.id}
              onClick={() => onSelectPatient(claim.patientId)}
              className={`flex items-center justify-between p-3 rounded-lg border ${s.card} ${s.hover} ${s.border} cursor-pointer transition-colors group`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`font-semibold text-sm truncate ${s.patientText}`}>{claim.patientName}</span>
                  <span className={`text-xs shrink-0 ${s.metaText}`}>Period {claim.authPeriod}</span>
                  {claim.dateOfService && (
                    <span className={`text-xs shrink-0 ${s.metaText}`}>
                      DOS: {new Date(claim.dateOfService).toLocaleDateString()}
                    </span>
                  )}
                  {claim.cptCodes && (
                    <span className={`text-xs shrink-0 ${s.metaText}`}>CPT: {claim.cptCodes}</span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                  {claim.followUpReason && (
                    <span className={`text-xs font-bold uppercase tracking-wide ${s.reasonText}`}>⚠ {claim.followUpReason}</span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className={`text-xs truncate ${s.metaText}`}>{claim.insurance}</span>
                  {claim.claimSubmittedDate && (
                    <span className={`text-xs shrink-0 ${s.metaText}`}>
                      Submitted: {new Date(claim.claimSubmittedDate).toLocaleDateString()}
                    </span>
                  )}
                  {claim.claimNumber && (
                    <span className={`text-xs shrink-0 ${s.metaText}`}>Claim #: {claim.claimNumber}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 ml-3 shrink-0">
                {claim.chargeAmount != null && (
                  <div className="text-right">
                    <div className={`text-xs ${s.chargedLabel}`}>Charged</div>
                    <div className={`text-sm font-bold ${s.chargedVal}`}>${parseFloat(String(claim.chargeAmount)).toFixed(2)}</div>
                  </div>
                )}
                <div className="text-right">
                  <div className={`text-xs ${s.chargedLabel}`}>Reimbursed</div>
                  <div className={`text-sm font-bold ${s.chargedVal}`}>
                    ${(claim.insuranceReimbursement != null ? parseFloat(String(claim.insuranceReimbursement)) : 0).toFixed(2)}
                  </div>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full font-bold capitalize ${s.badge} ${s.badgeText}`}>{status}</span>
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    markResolved.mutate({ id: claim.id });
                  }}
                  disabled={markResolved.isPending}
                  aria-label={`Mark claim for ${claim.patientName} as resolved`}
                  title="Mark as resolved and remove from follow-up list"
                  className="ml-1 h-auto rounded-full bg-white/90 text-gray-800 hover:bg-white hover:scale-105 active:scale-95 px-3 py-1 shadow-sm whitespace-nowrap"
                >
                  ✓ Resolved
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── CSV Export ─────────────────────────────────────────────────────────────
// The 18 canonical columns, in dashboard order. Reads the same raw (snake_case)
// claim shape returned by claims.getByPatientAndPeriod that the table itself renders.
const CSV_COLUMNS: Array<{ key: string; label: string; type?: 'currency' | 'date' }> = [
  { key: 'date_of_service', label: 'Date of Service', type: 'date' },
  { key: 'visit_number', label: 'Visit #' },
  { key: 'cpt_codes', label: 'CPT Codes' },
  { key: 'units_billed', label: 'Units' },
  { key: 'diagnosis_codes', label: 'Diagnosis' },
  { key: 'modifier', label: 'Modifier' },
  { key: 'charge_amount', label: 'Charge', type: 'currency' },
  { key: 'insurance_reimbursement', label: 'Ins. Reimb.', type: 'currency' },
  { key: 'patient_amount_paid', label: 'Pt. Paid', type: 'currency' },
  { key: 'patient_amount_due', label: 'Pt. Due', type: 'currency' },
  { key: 'insurance_billed', label: 'Ins. Billed' },
  { key: 'claim_submitted_date', label: 'Date Submitted', type: 'date' },
  { key: 'claim_number', label: 'Claim #' },
  { key: 'claim_status', label: 'Status' },
  { key: 'check_date', label: 'Check/Payment Date', type: 'date' },
  { key: 'check_number_virtual_card', label: 'Check/EFT #' },
  { key: 'date_of_appeal', label: 'Appeal Date', type: 'date' },
  { key: 'reference_no', label: 'Appeal Ref #' },
];

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** "YYYY-MM-DD" (how dates are stored) -> "MM/DD/YYYY", via string ops only
 *  (no Date parsing, which is exactly the kind of timezone/format footgun
 *  this codebase has been bitten by before). */
function isoDateToMDY(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : isoDate;
}

function claimsToCSV(claims: any[]): string {
  const header = CSV_COLUMNS.map((c) => csvEscape(c.label)).join(',');
  const rows = claims.map((claim) =>
    CSV_COLUMNS.map((col) => {
      const raw =
        col.key === 'claim_number'
          ? claim.expire_bcbs_claim_number || claim.oa_claim_number
          : claim[col.key];
      if (raw === null || raw === undefined || raw === '') return '';
      if (col.type === 'date') return csvEscape(isoDateToMDY(String(raw)));
      if (col.type === 'currency') return String(raw);
      return csvEscape(String(raw));
    }).join(',')
  );
  return [header, ...rows].join('\n');
}

function downloadCSV(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** "LASTNAME, FIRSTNAME" -> "lastname-firstname"; falls back to a slugified
 *  version of whatever the name actually is if it's not in that format. */
function patientNameForFilename(name: string): string {
  const parts = name.split(',').map((s) => s.trim()).filter(Boolean);
  const base = parts.length === 2 ? `${parts[0]}-${parts[1]}` : name;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function todayForFilename(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const utils = trpc.useUtils();

  // ── State ──────────────────────────────────────────────────────────────────
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [showDetailView, setShowDetailView] = useState(false);
  const [showAddPatient, setShowAddPatient] = useState(false);
  const [selectedInsurance, setSelectedInsurance] = useState<string>('Aetna');
  const [newPatientName, setNewPatientName] = useState('');
  const [newPatientInsurance, setNewPatientInsurance] = useState('Aetna');
  const [newPatientAuthorized, setNewPatientAuthorized] = useState('');
  const [newPatientAuthDate, setNewPatientAuthDate] = useState('');
  const [newPatientAuthValidUntil, setNewPatientAuthValidUntil] = useState('');
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showLogSessionDialog, setShowLogSessionDialog] = useState(false);
  const [sessionDate, setSessionDate] = useState(new Date().toISOString().split('T')[0]);
  /** Track which visit row is currently being edited for Date ASH Submitted */
  const [editingAshId, setEditingAshId] = useState<string | null>(null);
  const [editingAshValue, setEditingAshValue] = useState<string>('');
  /** Delete confirmation dialog */
  const [deletePatientId, setDeletePatientId] = useState<string | null>(null);
  const [deletePatientName, setDeletePatientName] = useState<string>('');
  const [mainTab, setMainTab] = useState<'active' | 'discharged'>('active');
  // Discharge confirmation dialog state
  const [showDischargeDialog, setShowDischargeDialog] = useState(false);
  const [pendingDischargePatientId, setPendingDischargePatientId] = useState<string | null>(null);
  const [dischargeDate, setDischargeDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [dischargeReason, setDischargeReason] = useState('');
  // Claims status filter for patient list
  const [selectedClaimsFilter, setSelectedClaimsFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  // Inline cell editing state for Claims Tracker
  const [editingCell, setEditingCell] = useState<{ claimId: string; field: string } | null>(null);
  const [editingValue, setEditingValue] = useState<string>('');
  // Column visibility for Claims Tracker — persisted in localStorage
  // Default visible set is the 18 core claim fields; Place of Service and LMN
  // Documents Date Sent start hidden (still reachable via the Columns toggle)
  // unless the user has already saved their own preference.
  const [hiddenClaimsColumns, setHiddenClaimsColumns] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('claims-hidden-columns');
      return saved ? new Set(JSON.parse(saved)) : new Set<string>(['placeOfService', 'lmn']);
    } catch { return new Set<string>(['placeOfService', 'lmn']); }
  });
  const toggleClaimsColumn = (key: string) => {
    setHiddenClaimsColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else { next.add(key); }
      localStorage.setItem('claims-hidden-columns', JSON.stringify(Array.from(next)));
      return next;
    });
  };
  // Add Claim dialog state
  const [showAddClaimDialog, setShowAddClaimDialog] = useState(false);
  const [addClaimPeriod, setAddClaimPeriod] = useState<number | null>(null);
  const [isSavingClaim, setIsSavingClaim] = useState(false);
  // PDF/CSV upload state
  const [showClaimUploadDialog, setShowClaimUploadDialog] = useState(false);
  const [claimUploadPeriod, setClaimUploadPeriod] = useState<number | null>(null);
  const [claimUploadType, setClaimUploadType] = useState<'reimbursement' | 'cms1500'>('reimbursement');
  const [isExtractingClaims, setIsExtractingClaims] = useState(false);
  const [extractedClaims, setExtractedClaims] = useState<any[]>([]);
  const [editingExtractedClaims, setEditingExtractedClaims] = useState<any[]>([]);
  const [isSavingExtractedClaims, setIsSavingExtractedClaims] = useState(false);
  const [uploadFileName, setUploadFileName] = useState<string>('');
  const [detectedTemplate, setDetectedTemplate] = useState<string>('');
  // Multi-patient EOB: groups from the server (one group per detected patient)
  const [eobPatientGroups, setEobPatientGroups] = useState<Array<{ patientName: string; claims: any[] }> | null>(null);
  const [isBulkImporting, setIsBulkImporting] = useState(false);
  const [bulkImportResults, setBulkImportResults] = useState<Array<{
    patientName: string;
    matched: boolean;
    patientId?: string;
    dashboardName?: string;
    authPeriod?: number;
    claimsImported: number;
    error?: string;
  }> | null>(null);
  const [claimFormData, setClaimFormData] = useState({
    placeOfService: '',
    dateOfService: '',
    visitNumber: '',
    cptCodes: '',
    unitsBilled: '',
    diagnosisCodes: '',
    modifier: '',
    chargeAmount: '',
    insuranceReimbursement: '',
    patientAmountPaid: '',
    patientAmountDue: '',
    insuranceBilled: '',
    oaClaimNumber: '',
    claimSubmittedDate: '',
    expireBcbsClaimNumber: '',
    claimStatus: 'submitted',
    lmn: '',
    notesDateSent: '',
    paymentReceived: '',
    checkDate: '',
    checkNumberVirtualCard: '',
    dateReceived: '',
    dateOfAppeal: '',
    referenceNo: '',
  });

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: patients = [], isLoading: patientsLoading, refetch: refetchPatients } =
    trpc.patients.list.useQuery();

  // The patient explicitly selected via selectedPatientId — unlike activePatient
  // below, this has NO fallback to patients[0], so it's only truthy when a
  // patient was actually chosen (by clicking a row, an alert card, etc.).
  const selectedPatient: DbPatient | null = patients.find(p => p.id === selectedPatientId) ?? null;

  const activePatient: DbPatient | null =
    patients.find(p => p.id === selectedPatientId) ??
    (patients.length > 0 ? patients[0] : null);

  const { data: visits = [], isLoading: visitsLoading, refetch: refetchVisits } =
    trpc.visits.listByPatient.useQuery(
      { patientId: activePatient?.id ?? '' },
      { enabled: !!activePatient }
    );

  // Pre-compute periods for claims queries
  const periods = useMemo(() => {
    return Array.from(new Set(visits.map(v => v.authPeriod ?? 1))).sort((a, b) => b - a);
  }, [visits]);

  // Pre-fetch claims for up to 5 periods
  const claimsQuery1 = trpc.claims.getByPatientAndPeriod.useQuery(
    { patientId: activePatient?.id ?? '', authPeriod: periods[0] ?? 1 },
    { enabled: !!activePatient && periods.length > 0 }
  );
  const claimsQuery2 = trpc.claims.getByPatientAndPeriod.useQuery(
    { patientId: activePatient?.id ?? '', authPeriod: periods[1] ?? 1 },
    { enabled: !!activePatient && periods.length > 1 }
  );
  const claimsQuery3 = trpc.claims.getByPatientAndPeriod.useQuery(
    { patientId: activePatient?.id ?? '', authPeriod: periods[2] ?? 1 },
    { enabled: !!activePatient && periods.length > 2 }
  );
  const claimsQuery4 = trpc.claims.getByPatientAndPeriod.useQuery(
    { patientId: activePatient?.id ?? '', authPeriod: periods[3] ?? 1 },
    { enabled: !!activePatient && periods.length > 3 }
  );
  const claimsQuery5 = trpc.claims.getByPatientAndPeriod.useQuery(
    { patientId: activePatient?.id ?? '', authPeriod: periods[4] ?? 1 },
    { enabled: !!activePatient && periods.length > 4 }
  );

  // Map period -> claims data
  const claimsDataMap = useMemo(() => {
    const map: Record<number, any[]> = {};
    const queries = [claimsQuery1, claimsQuery2, claimsQuery3, claimsQuery4, claimsQuery5];
    periods.forEach((period, idx) => {
      map[period] = queries[idx]?.data ?? [];
    });
    return map;
  }, [periods, claimsQuery1, claimsQuery2, claimsQuery3, claimsQuery4, claimsQuery5]);

  // Auto-select first patient
  useEffect(() => {
    if (!selectedPatientId && patients.length > 0) {
      setSelectedPatientId(patients[0].id);
    }
  }, [patients, selectedPatientId]);

  // Keep the Insurance filter in sync with whichever patient is actually
  // selected (via the Patients list, the Auth Alert panel, the Claims
  // Follow-Up panel, or the auto-select above). Without this, selecting a
  // patient on a different insurance than the active filter leaves the
  // Insurance sidebar, Claims Status counts, and Patients list all scoped to
  // the WRONG insurance while the detail view shows the right patient —
  // exactly the "Aetna highlighted but viewing a Meritain patient" bug.
  // Keyed on selectedPatient (no patients[0] fallback), so manually picking a
  // different insurance while no patient is selected is left alone.
  useEffect(() => {
    if (selectedPatient?.insurance && selectedPatient.insurance !== selectedInsurance) {
      setSelectedInsurance(selectedPatient.insurance);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPatient?.id]);

  // ── Mutations ──────────────────────────────────────────────────────────────
  const createPatient = trpc.patients.create.useMutation({
    onSuccess: () => {
      utils.patients.list.invalidate();
    },
    onError: (e) => toast.error(`Failed to add patient: ${e.message}`),
  });

  const createVisit = trpc.visits.create.useMutation({
    onSuccess: () => {
      utils.visits.listByPatient.invalidate({ patientId: activePatient?.id });
      utils.visits.completedPatientIds.invalidate();
      toast.success('Session logged successfully!');
      setShowLogSessionDialog(false);
    },
    onError: (e) => toast.error(`Failed to log session: ${e.message}`),
  });

  const updateVisit = trpc.visits.update.useMutation({
    onSuccess: () => {
      utils.visits.listByPatient.invalidate({ patientId: activePatient?.id });
      utils.visits.completedPatientIds.invalidate();
    },
    onError: (e) => toast.error(`Failed to update: ${e.message}`),
  });

  const updatePatient = trpc.patients.update.useMutation({
    onSuccess: () => {
      utils.patients.list.invalidate();
      // A patient's insurance (or claims_status) may have changed — both the
      // Claims Status counts and the Follow-Up panel are scoped by insurance.
      utils.claims.getStatusCounts.invalidate();
      utils.claims.getFollowUpClaims.invalidate();
      toast.success('Patient updated');
    },
    onError: (e) => toast.error(`Failed to update patient: ${e.message}`),
  });

  const setPatientActive = trpc.patients.setActive.useMutation({
    onSuccess: (_, vars) => {
      utils.patients.list.invalidate();
      const wasDischarging = !vars.isActive;
      if (wasDischarging) {
        toast.success('Patient moved to Discharged Patients');
        setMainTab('discharged');
      } else {
        toast.success('Patient reactivated');
        setMainTab('active');
      }
    },
    onError: (e) => toast.error(`Failed to update patient status: ${e.message}`),
  });

  /** Open the discharge dialog instead of immediately deactivating */
  const handleToggleActive = (patientId: string, newActive: boolean) => {
    if (!newActive) {
      // Deactivating → show discharge form first
      setPendingDischargePatientId(patientId);
      setDischargeDate(new Date().toISOString().split('T')[0]);
      setDischargeReason('');
      setShowDischargeDialog(true);
    } else {
      // Reactivating → do it immediately, clear discharge fields
      setPatientActive.mutate({ id: patientId, isActive: true, dischargeDate: null, dischargeReason: null });
    }
  };

  /** Submit the discharge form */
  const handleDischargeSubmit = () => {
    if (!pendingDischargePatientId) return;
    const dischargeDateMs = dischargeDate
      ? new Date(dischargeDate + 'T00:00:00Z').getTime()
      : Date.now();
    setPatientActive.mutate({
      id: pendingDischargePatientId,
      isActive: false,
      dischargeDate: dischargeDateMs,
      dischargeReason: dischargeReason.trim() || null,
    });
    setShowDischargeDialog(false);
    setPendingDischargePatientId(null);
    setDischargeReason('');
  };

  const deletePatient = trpc.patients.delete.useMutation({
    onSuccess: () => {
      utils.patients.list.invalidate();
      utils.visits.completedPatientIds.invalidate();
      // If we just deleted the active patient, clear the selection
      if (selectedPatientId === deletePatientId) {
        setSelectedPatientId(null);
      }
      toast.success(`${deletePatientName} removed successfully`);
      setDeletePatientId(null);
      setDeletePatientName('');
    },
    onError: (e) => toast.error(`Failed to delete patient: ${e.message}`),
  });

  const bulkCreateVisits = trpc.visits.bulkCreate.useMutation({
    onSuccess: () => {
      utils.patients.list.invalidate();
      utils.visits.listByPatient.invalidate();
      utils.visits.completedPatientIds.invalidate();
      toast.success('Patients imported successfully!');
      setShowUploadDialog(false);
      setUploadProgress(0);
    },
    onError: (e) => toast.error(`Import failed: ${e.message}`),
  });

  const updateClaim = trpc.claims.update.useMutation({
    onSuccess: () => {
      utils.claims.getByPatientAndPeriod.invalidate();
      utils.claims.getFollowUpClaims.invalidate();
      utils.claims.getStatusCounts.invalidate();
      setEditingCell(null);
    },
    onError: (e) => toast.error(`Failed to update claim: ${e.message}`),
  });

  const upsertClaim = trpc.claims.upsert.useMutation();

  const createClaim = trpc.claims.create.useMutation({
    onSuccess: () => {
      // Invalidate all claims queries for the active patient
      utils.claims.getByPatientAndPeriod.invalidate();
      utils.claims.getFollowUpClaims.invalidate();
      utils.claims.getStatusCounts.invalidate();
      toast.success('Claim record saved successfully!');
      setShowAddClaimDialog(false);
      setIsSavingClaim(false);
      // Reset form
      setClaimFormData({
        placeOfService: '', dateOfService: '', visitNumber: '', cptCodes: '',
        unitsBilled: '', diagnosisCodes: '', modifier: '', chargeAmount: '',
        insuranceReimbursement: '', patientAmountPaid: '', patientAmountDue: '',
        insuranceBilled: '', oaClaimNumber: '', claimSubmittedDate: '',
        expireBcbsClaimNumber: '', claimStatus: 'submitted', lmn: '', notesDateSent: '',
        paymentReceived: '', checkDate: '', checkNumberVirtualCard: '', dateReceived: '',
        dateOfAppeal: '', referenceNo: '',
      });
    },
    onError: (e) => {
      toast.error(`Failed to save claim: ${e.message}`);
      setIsSavingClaim(false);
    },
  });

  const bulkImportFromEOB = trpc.claims.bulkImportFromEOB.useMutation({
    onSuccess: (data) => {
      setBulkImportResults(data.results);
      utils.claims.getByPatientAndPeriod.invalidate();
      utils.claims.getFollowUpClaims.invalidate();
      utils.claims.getStatusCounts.invalidate();
    },
    onError: (e) => toast.error(`Bulk import failed: ${e.message}`),
  });

  const logoutMutation = trpc.auth.logout.useMutation();

  // ── Computed metrics ───────────────────────────────────────────────────────

  const getPatientMetrics = (patientVisits: DbVisit[]) => {
    if (patientVisits.length === 0) return { totalAuthorized: 0, completed: 0, remaining: 0, activePeriod: null as number | null };

    // Find all distinct auth periods sorted oldest first
    const allPeriods = Array.from(new Set(patientVisits.map(v => v.authPeriod ?? 1))).sort((a, b) => a - b);

    // Active period = the OLDEST period that still has sessions remaining (> 0).
    // This ensures staff use up Period 1 before Period 2 becomes active.
    // Returns null if all periods are exhausted (no sessions remaining anywhere).
    // IMPORTANT: Use Authorized - Completed (not stored sessionsRemaining) for accuracy.
    let activePeriod: number | null = null;
    for (const period of allPeriods) {
      const periodVisits = patientVisits.filter(v => (v.authPeriod ?? 1) === period);
      const authRow = periodVisits.find(v => v.sessionsAuthorized != null);
      const periodAuthorized = authRow?.sessionsAuthorized ?? 0;
      const periodCompleted = periodVisits.filter(v => v.dateOfService != null).length;
      const periodRemaining = Math.max(0, periodAuthorized - periodCompleted);
      if (periodRemaining > 0) {
        activePeriod = period;
        break; // Found the oldest period with remaining sessions
      }
    }

    if (activePeriod === null) {
      // All periods exhausted — show totals from the latest period for display purposes
      const latestPeriod = allPeriods[allPeriods.length - 1];
      const latestVisits = patientVisits.filter(v => (v.authPeriod ?? 1) === latestPeriod);
      const authRow = latestVisits.find(v => v.sessionsAuthorized != null);
      const totalAuthorized = authRow?.sessionsAuthorized ?? 0;
      const completed = latestVisits.filter(v => v.dateOfService != null).length;
      return { totalAuthorized, completed, remaining: 0, activePeriod: null };
    }

    const currentPeriodVisits = patientVisits.filter(v => (v.authPeriod ?? 1) === activePeriod);

    // Authorized = sessionsAuthorized from any row in the active period
    const authRow = currentPeriodVisits.find(v => v.sessionsAuthorized != null);
    const totalAuthorized = authRow?.sessionsAuthorized ?? 0;

    // Completed = rows in the active period that have a date of service
    const completed = currentPeriodVisits.filter(v => v.dateOfService != null).length;

    // Remaining = Authorized - Completed (always derived, never from stored sessionsRemaining)
    // This is the only mathematically accurate approach — stored sessionsRemaining can be stale.
    const remaining = Math.max(0, totalAuthorized - completed);

    return { totalAuthorized, completed, remaining, activePeriod };
  };

  // For the list view we need metrics per patient — but visits are only loaded for the active patient.
  // We derive a rough remaining from the patient's own visits when available.
  const getAlertStatus = (patient: DbPatient, remaining: number) => {
    if (remaining === 0) {
      return { status: 'exhausted', label: 'Sessions Exhausted', color: 'bg-red-100 text-red-800', message: 'No sessions remaining. Authorization request is urgent.' };
    }
    if (remaining <= 3) {
      return { status: 'warning', label: 'Request Authorization', color: 'bg-orange-100 text-orange-800', message: `Only ${remaining} session(s) remaining. Request new authorization from ${patient.insurance} immediately.` };
    }
    return { status: 'ok', label: 'On Track', color: 'bg-green-100 text-green-800', message: null };
  };

  // Active patient metrics (from loaded visits)
  const activeMetrics = useMemo(() => getPatientMetrics(visits), [visits]);
  const alertStatus = activePatient ? getAlertStatus(activePatient, activeMetrics.remaining) : null;

  // Completed patients — those with 0 remaining and all sessions dated
  const { data: completedIds = [] } = trpc.visits.completedPatientIds.useQuery();
  const completedSet = useMemo(() => new Set(completedIds), [completedIds]);

  // Split patients into active and discharged
  const activePatients = patients.filter(p => p.isActive !== false);
  const dischargedPatients = patients.filter(p => p.isActive === false);

  // Claims Status counts — aggregated server-side directly from claims_records
  // (never from the stale patients.claims_status roll-up), scoped by the same
  // insurance filter as the Patients list and the Follow-Up panel so none of
  // the three can ever disagree on screen.
  const { data: statusCountsData } = trpc.claims.getStatusCounts.useQuery({
    insurance: selectedInsurance || undefined,
  });
  const claimStatusCounts = statusCountsData?.counts ?? {
    all: 0, submitted: 0, approved: 0, pending: 0, denied: 0,
    pended: 0, rejected: 0, resubmitted: 0, none: 0,
  };
  const patientIdsByStatus = statusCountsData?.patientIdsByStatus ?? {};

  // filteredPatients = active patients matching the selected insurance AND claims status filter
  // The sidebar count and the patient list both use the same filter so they always match.
  const filteredPatients = useMemo(() => {
    let result = selectedInsurance
      ? activePatients.filter(p => p.insurance === selectedInsurance)
      : activePatients;
    if (selectedClaimsFilter && selectedClaimsFilter !== 'all') {
      const matchingIds = new Set((patientIdsByStatus as Record<string, string[]>)[selectedClaimsFilter] ?? []);
      result = result.filter(p => matchingIds.has(p.id));
    }
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter(p => p.name.toLowerCase().includes(query));
    }
    return result;
  }, [activePatients, selectedInsurance, selectedClaimsFilter, patientIdsByStatus, searchQuery]);

  const activeFilterCount = (selectedInsurance ? 1 : 0) + (selectedClaimsFilter && selectedClaimsFilter !== 'all' ? 1 : 0);

  const handleClearFilters = () => {
    setSelectedInsurance('');
    setSelectedClaimsFilter('all');
  };

  // Shared between the desktop sidebar and the mobile Filters sheet so the two never drift.
  const renderInsuranceFilterButtons = () => insuranceList.map(insurance => {
    const count = activePatients.filter(p => p.insurance === insurance).length;
    const isSelected = selectedInsurance === insurance;
    return (
      <button
        key={insurance}
        onClick={() => {
          setSelectedInsurance(insurance);
          // Switching insurance while viewing a patient on a
          // different one would leave the detail view showing
          // someone outside the new filter — back out to the list.
          if (selectedPatient && selectedPatient.insurance !== insurance) {
            setShowDetailView(false);
          }
        }}
        className={`w-full flex items-center justify-between px-3 py-2.5 rounded-md cursor-pointer transition font-semibold text-sm ${
          isSelected ? 'bg-brand-gold text-white' : 'text-brand-blue hover:bg-brand-cream'
        }`}
      >
        <span className="truncate">{insurance}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ml-1 shrink-0 ${
          isSelected ? 'bg-white/25 text-white' : 'bg-gray-100 text-gray-700'
        }`}>{count}</span>
      </button>
    );
  });

  const renderClaimsStatusFilterButtons = () => CLAIM_STATUS_FILTERS.map(({ value, label, color }) => {
    const count = claimStatusCounts[value as keyof typeof claimStatusCounts] ?? 0;
    const isSelected = selectedClaimsFilter === value;
    return (
      <button
        key={value}
        onClick={() => setSelectedClaimsFilter(value)}
        className={`w-full flex items-center justify-between px-3 py-2.5 rounded-md cursor-pointer transition text-sm ${
          isSelected ? 'bg-brand-gold text-white font-semibold' : 'text-brand-blue hover:bg-brand-cream'
        }`}
      >
        <span className="truncate">{label}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ml-1 shrink-0 ${
          isSelected ? 'bg-white/25 text-white' : color
        }`}>{count}</span>
      </button>
    );
  });

  const completedPatients = activePatients.filter(p => completedSet.has(p.id));

  // Clinic-wide metrics (approximate — based on active patient visits + patient count)
  const clinicMetrics = useMemo(() => {
    const totalPatients = filteredPatients.length;
    // We only have full visit data for the active patient; show what we can
    return {
      totalPatients,
      totalAuthorized: activeMetrics.totalAuthorized,
      totalRemaining: activeMetrics.remaining,
      totalCompleted: activeMetrics.completed,
      utilizationRate: activeMetrics.totalAuthorized > 0
        ? Math.round((activeMetrics.completed / activeMetrics.totalAuthorized) * 100)
        : 0,
    };
  }, [filteredPatients, activeMetrics]);

  const patientProgressData = useMemo(() =>
    visits
      .filter(v => v.sessionNumber && v.sessionsRemaining != null)
      .map(v => ({ session: v.sessionNumber, remaining: v.sessionsRemaining }))
      .slice(0, 12),
    [visits]
  );

  const clinicStatusData = [
    { name: 'Completed', value: clinicMetrics.totalCompleted, color: '#E8A93C' },
    { name: 'Remaining', value: clinicMetrics.totalRemaining, color: '#1E3A5F' },
  ];

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleAddPatient = async () => {
    if (!newPatientName.trim()) {
      toast.error('Please enter a patient name');
      return;
    }
    const authorized = parseInt(newPatientAuthorized) || 0;
    try {
      // Step 1: create the patient row
      const authValidUntilMs = newPatientAuthValidUntil
        ? new Date(newPatientAuthValidUntil + 'T00:00:00Z').getTime()
        : null;
      const { id: patientId } = await createPatient.mutateAsync({
        name: newPatientName.trim(),
        insurance: newPatientInsurance,
        authDate: newPatientAuthDate || null,
        authValidUntil: authValidUntilMs,
      });

      // Step 2: if authorized sessions were entered, create the initial visit record
      // so that metrics (totalAuthorized, remaining) are immediately correct
      if (authorized > 0) {
        await bulkCreateVisits.mutateAsync({
          patientId,
          records: [{
            sessionsAuthorized: authorized,
            sessionsRemaining: authorized,
            sessionNumber: 1,
            dateOfService: null,
            newAuth: 'NO',
            dateAshSubmitted: null,
            authStatus: 'none',
          }],
        });
      }

      // Step 3: refresh the patient list and select the new patient
      await utils.patients.list.invalidate();
      toast.success('Patient added successfully!');
      setShowAddPatient(false);
      setNewPatientName('');
      setNewPatientAuthorized('');
      setNewPatientAuthDate('');
      setNewPatientAuthValidUntil('');
      setNewPatientInsurance('Aetna');
    } catch (e: any) {
      toast.error(`Failed to add patient: ${e.message}`);
    }
  };

  const handleLogSession = () => {
    if (!activePatient) return;
    if (activeMetrics.remaining <= 0) {
      toast.error('No sessions remaining for this patient');
      return;
    }
    const newRemaining = activeMetrics.remaining - 1;
    // Target the active period (oldest with remaining sessions)
    const targetPeriod = activeMetrics.activePeriod;
    // Find the first undated session row in the active period to fill in
    const activePeriodVisits = visits.filter(v => (v.authPeriod ?? 1) === targetPeriod);
    const firstUndated = activePeriodVisits.find(v => !v.dateOfService);
    if (firstUndated) {
      // Update the existing pre-created row with the date of service
      updateVisit.mutate({
        id: firstUndated.id,
        dateOfService: sessionDate,
        sessionsRemaining: newRemaining,
        authStatus: firstUndated.authStatus === 'none' ? 'none' : firstUndated.authStatus,
      }, {
        onSuccess: () => {
          toast.success('Session logged successfully!');
          setShowLogSessionDialog(false);
          setSessionDate(new Date().toISOString().split('T')[0]);
        },
        onError: (err) => toast.error(`Failed to log session: ${err.message}`),
      });
    } else {
      // Fallback: create a new row if no pre-created rows exist
      const nextSessionNumber = activePeriodVisits.length + 1;
      createVisit.mutate({
        patientId: activePatient.id,
        sessionsRemaining: newRemaining,
        sessionNumber: nextSessionNumber,
        authPeriod: targetPeriod ?? undefined,
        dateOfService: sessionDate,
        newAuth: 'NO',
        authStatus: 'none',
      });
    }
  };

  const handleUpdateAuthStatus = (visitId: string, status: string) => {
    const mapped = status === '' ? 'none' : (status.toLowerCase() as 'none' | 'pending' | 'approved' | 'denied');
    updateVisit.mutate({ id: visitId, authStatus: mapped });
    toast.success(`Auth status updated to ${mapped}`);
  };

  /** Start editing Date ASH Submitted for a visit row */
  const handleStartEditAsh = (visit: DbVisit) => {
    setEditingAshId(visit.id);
    setEditingAshValue(toInputDate(visit.dateAshSubmitted));
  };

  /** Save the edited Date ASH Submitted value */
  const handleSaveAsh = (visitId: string) => {
    updateVisit.mutate(
      { id: visitId, dateAshSubmitted: editingAshValue || null },
      {
        onSuccess: () => {
          toast.success('Date ASH Submitted saved');
          setEditingAshId(null);
        },
      }
    );
  };

  /** Cancel editing without saving */
  const handleCancelAsh = () => {
    setEditingAshId(null);
    setEditingAshValue('');
  };

  // ── PDF/CSV Claim Upload ──────────────────────────────────────────────────

  const handleClaimFileUpload = async (file: File, period: number, uploadType: 'reimbursement' | 'cms1500' = 'reimbursement') => {
    if (!file) return;
    console.log('[EOB Upload] handleClaimFileUpload called with file:', file.name, 'uploadType:', uploadType, 'activePatient:', activePatient?.name);
    setUploadFileName(file.name);
    setClaimUploadType(uploadType);
    setIsExtractingClaims(true);
    setExtractedClaims([]);
    setEditingExtractedClaims([]);
    setEobPatientGroups(null);
    setBulkImportResults(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('uploadType', uploadType);
      const res = await fetch('/api/claims/upload-extract', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const rawBody = await res.text();
      let json: any;
      try {
        json = JSON.parse(rawBody);
      } catch {
        // The server didn't return JSON at all -- typically the hosting
        // platform's own error page (e.g. a serverless function timeout or
        // crash) rather than anything the app itself produced. Surface a
        // clear message instead of the raw JSON.parse SyntaxError.
        console.error('[EOB Upload] Non-JSON response:', rawBody.slice(0, 500));
        throw new Error(
          res.status === 504 || /timed?\s*out/i.test(rawBody)
            ? 'The server took too long processing this file (it may be large or complex). Please try again.'
            : `Server returned an unexpected response (status ${res.status}). Please try again.`
        );
      }
      if (!res.ok) throw new Error(json.error ?? 'Extraction failed');

      setDetectedTemplate(json.templateUsed ?? '');

      // ── Multi-patient mode: server returned patientGroups ──────────────────
      if (json.patientGroups && json.patientGroups.length > 0) {
        console.log('[EOB Upload] patientGroups received:', json.patientGroups);
        console.log('[EOB Upload] showDetailView:', showDetailView, 'activePatient:', activePatient?.name);
        // If we have an active patient (single-patient dialog), try to find their data
        // in the patientGroups and use it for the single-patient review flow.
        if (activePatient) {
          console.log('[EOB Upload] Active patient:', activePatient.name);
          const matchedGroup = findMatchingPatient(
            activePatient.name,
            json.patientGroups.map((g: any) => ({ name: g.patientName }))
          );
          console.log('[EOB Upload] Matched group:', matchedGroup);
          const matchedGroupData = matchedGroup
            ? json.patientGroups.find((g: any) => g.patientName === matchedGroup.name)
            : null;
          console.log('[EOB Upload] Matched group data:', matchedGroupData);
          console.log('[EOB Upload] Matched group data claims length:', matchedGroupData?.claims?.length);
          if (matchedGroupData && matchedGroupData.claims && matchedGroupData.claims.length > 0) {
            console.log('[EOB Upload] Single-patient mode: processing matched patient');
            // Flatten the matched patient's claims into the single-patient review format
            const flatClaims: any[] = [];
            for (const claim of matchedGroupData.claims) {
              const lines: any[] = claim.cptLines?.length > 0 ? claim.cptLines : [claim];
              for (const line of lines) {
                flatClaims.push({
                  ...claim,
                  cptCodes: line.cptCodes ?? claim.cptCodes ?? '',
                  chargeAmount: line.chargeAmount ?? claim.chargeAmount ?? null,
                  insuranceReimbursement: line.insuranceReimbursement ?? claim.insuranceReimbursement ?? null,
                  patientAmountPaid: line.patientAmountPaid ?? claim.patientAmountPaid ?? null,
                  patientAmountDue: line.patientAmountDue ?? claim.patientAmountDue ?? null,
                  unitsBilled: line.unitsBilled ?? claim.unitsBilled ?? null,
                  modifier: line.modifier ?? claim.modifier ?? null,
                  diagnosisCodes: line.diagnosisCodes ?? claim.diagnosisCodes ?? null,
                });
              }
            }
            const rawRows = flatClaims.map((c: any, i: number) => ({
              _key: i,
              placeOfService: c.placeOfService ?? '',
              dateOfService: c.dateOfService ?? '',
              visitNumber: c.visitNumber != null ? String(c.visitNumber) : '',
              cptCodes: c.cptCodes ?? '',
              unitsBilled: c.unitsBilled != null ? String(c.unitsBilled) : '',
              diagnosisCodes: c.diagnosisCodes ?? '',
              modifier: c.modifier ?? '',
              chargeAmount: c.chargeAmount != null ? String(c.chargeAmount) : '',
              insuranceReimbursement: c.insuranceReimbursement != null ? String(c.insuranceReimbursement) : '',
              patientAmountPaid: c.patientAmountPaid != null ? String(c.patientAmountPaid) : '',
              patientAmountDue: c.patientAmountDue != null ? String(c.patientAmountDue) : '',
              insuranceBilled: c.insuranceBilled ?? '',
              oaClaimNumber: c.oaClaimNumber ?? '',
              claimSubmittedDate: c.claimSubmittedDate ?? '',
              expireBcbsClaimNumber: c.expireBcbsClaimNumber ?? '',
              claimStatus: c.claimStatus ?? 'submitted',
              paymentReceived: c.paymentReceived != null ? String(c.paymentReceived) : '',
              checkDate: c.checkDate ?? '',
              checkNumberVirtualCard: c.checkNumberVirtualCard ?? '',
              dateReceived: c.dateReceived ?? '',
              lmn: c.lmn ?? '',
              referenceNo: c.referenceNo ?? '',
              dateOfAppeal: c.dateOfAppeal ?? '',
              notes: c.notes ?? '',
            }));
            // Group by date of service
            const dateGroupMap = new Map<string, any>();
            for (const row of rawRows) {
              const dateKey = row.dateOfService || 'no-date';
              if (!dateGroupMap.has(dateKey)) {
                dateGroupMap.set(dateKey, { ...row, _key: dateGroupMap.size, cptLines: [] });
              }
              const grp = dateGroupMap.get(dateKey)!;
              grp.cptLines.push({
                _key: row._key, cptCodes: row.cptCodes, chargeAmount: row.chargeAmount,
                insuranceReimbursement: row.insuranceReimbursement, patientAmountPaid: row.patientAmountPaid,
                patientAmountDue: row.patientAmountDue, unitsBilled: row.unitsBilled,
                modifier: row.modifier, diagnosisCodes: row.diagnosisCodes, notes: row.notes,
              });
            }
            const normalized = Array.from(dateGroupMap.values());
            setExtractedClaims(normalized);
            setEditingExtractedClaims(normalized);
            toast.success(`Extracted ${normalized.length} claim${normalized.length !== 1 ? 's' : ''} (${rawRows.length} CPT lines) for ${activePatient.name} from ${file.name} (${json.templateUsed})`);
            return;
          } else if (showDetailView && json.claims && json.claims.length > 0) {
            // Recovery path for when matchedGroupData came back empty/unmatched:
            // json.claims is the FLAT multi-patient list (every patient the AI
            // found in the document), so it must be filtered down to only the
            // active patient's claims before use here — using it unfiltered
            // would silently display/save every patient in the file under
            // activePatient's name (real cross-patient contamination bug).
            const targetClaims = json.claims.filter(
              (c: any) => c.patientName && fuzzyNameMatch(c.patientName, activePatient.name)
            );
            if (targetClaims.length === 0) {
              console.log('[EOB Upload] No claims in flat response matched active patient; falling back to bulk review.');
              setEobPatientGroups(json.patientGroups);
              toast.error(
                `No data found for ${activePatient.name} in this file. Detected patients: ${json.patientGroups.map((g: any) => g.patientName).join(', ')} — review below.`
              );
              return;
            }
            console.log(`[EOB Upload] Matched group had no claims; recovered ${targetClaims.length} claim(s) for ${activePatient.name} from flat response.`);
            const rawRows = targetClaims.map((c: any, i: number) => ({
              _key: i,
              placeOfService: c.placeOfService ?? '',
              dateOfService: c.dateOfService ?? '',
              visitNumber: c.visitNumber != null ? String(c.visitNumber) : '',
              cptCodes: c.cptCodes ?? '',
              unitsBilled: c.unitsBilled != null ? String(c.unitsBilled) : '',
              diagnosisCodes: c.diagnosisCodes ?? '',
              modifier: c.modifier ?? '',
              chargeAmount: c.chargeAmount != null ? String(c.chargeAmount) : '',
              insuranceReimbursement: c.insuranceReimbursement != null ? String(c.insuranceReimbursement) : '',
              patientAmountPaid: c.patientAmountPaid != null ? String(c.patientAmountPaid) : '',
              patientAmountDue: c.patientAmountDue != null ? String(c.patientAmountDue) : '',
              insuranceBilled: c.insuranceBilled ?? '',
              oaClaimNumber: c.oaClaimNumber ?? '',
              claimSubmittedDate: c.claimSubmittedDate ?? '',
              expireBcbsClaimNumber: c.expireBcbsClaimNumber ?? '',
              claimStatus: c.claimStatus ?? 'submitted',
              paymentReceived: c.paymentReceived != null ? String(c.paymentReceived) : '',
              checkDate: c.checkDate ?? '',
              checkNumberVirtualCard: c.checkNumberVirtualCard ?? '',
              dateReceived: c.dateReceived ?? '',
              lmn: c.lmn ?? '',
              referenceNo: c.referenceNo ?? '',
              dateOfAppeal: c.dateOfAppeal ?? '',
              notes: c.notes ?? '',
            }));
            const dateGroupMap = new Map<string, any>();
            for (const row of rawRows) {
              const dateKey = row.dateOfService || 'no-date';
              if (!dateGroupMap.has(dateKey)) {
                dateGroupMap.set(dateKey, { ...row, _key: dateGroupMap.size, cptLines: [] });
              }
              const grp = dateGroupMap.get(dateKey)!;
              grp.cptLines.push({
                _key: row._key, cptCodes: row.cptCodes, chargeAmount: row.chargeAmount,
                insuranceReimbursement: row.insuranceReimbursement, patientAmountPaid: row.patientAmountPaid,
                patientAmountDue: row.patientAmountDue, unitsBilled: row.unitsBilled,
                modifier: row.modifier, diagnosisCodes: row.diagnosisCodes, notes: row.notes,
              });
            }
            const normalized = Array.from(dateGroupMap.values());
            setExtractedClaims(normalized);
            setEditingExtractedClaims(normalized);
            toast.success(`Extracted ${normalized.length} claim${normalized.length !== 1 ? 's' : ''} (${rawRows.length} CPT lines) for ${activePatient.name} from ${file.name} (${json.templateUsed})`);
            return;
          }
        }
        // No active patient or no match — fall through to bulk mode
        console.log('[EOB Upload] Falling through to bulk mode. activePatient:', activePatient);
        setEobPatientGroups(json.patientGroups);
        const totalClaims = json.patientGroups.reduce((sum: number, g: any) => sum + g.claims.length, 0);
        toast.success(
          `Detected ${json.patientGroups.length} patient${json.patientGroups.length !== 1 ? 's' : ''} with ${totalClaims} date group${totalClaims !== 1 ? 's' : ''} in ${file.name} — review and import below.`
        );
        return;
      }

      // ── Single-patient mode (AI or single-patient template) ───────────────
      if (!json.claims || json.claims.length === 0) {
        // extractionNotes carries a specific explanation when extraction ran
        // successfully but legitimately found nothing (e.g. the patient's
        // name appears only in a header/subscriber list with no service
        // lines of their own) -- prefer that over the generic message so
        // this doesn't read as a failure when nothing actually went wrong.
        toast.error(json.extractionNotes || 'No claim data could be extracted from this file. Please check the file content.');
        return;
      }
      // This branch is also reached when the AI found MULTIPLE patients but
      // the server didn't build a patientGroups response for them (it only
      // does so when every claim happened to share one exact patientName —
      // see aiClaimExtractor.ts). In that case json.claims is the unfiltered,
      // every-patient-in-the-document list, so it must be scoped down to the
      // active patient here too, the same way the patientGroups fallback
      // above already is — otherwise every patient in a multi-patient EOB
      // gets saved under whichever patient's page the file was uploaded to.
      let claimsForActivePatient = json.claims;
      if (activePatient) {
        const distinctNames = new Set(
          json.claims.map((c: any) => c.patientName).filter(Boolean)
        );
        if (distinctNames.size > 1) {
          const filtered = json.claims.filter(
            (c: any) => c.patientName && fuzzyNameMatch(c.patientName, activePatient.name)
          );
          if (filtered.length === 0) {
            toast.error(
              `No data found for ${activePatient.name} in this file. Detected patients: ${Array.from(distinctNames).join(', ')}.`
            );
            return;
          }
          console.log(`[EOB Upload] json.claims contained ${distinctNames.size} distinct patients with no patientGroups response; filtered to ${filtered.length} claim(s) for ${activePatient.name}.`);
          claimsForActivePatient = filtered;
        }
      }
      // Normalize extracted rows to string form for editing
      const rawRows = claimsForActivePatient.map((c: any, i: number) => ({
        _key: i,
        placeOfService: c.placeOfService ?? '',
        dateOfService: c.dateOfService ?? '',
        visitNumber: c.visitNumber != null ? String(c.visitNumber) : '',
        cptCodes: c.cptCodes ?? '',
        unitsBilled: c.unitsBilled != null ? String(c.unitsBilled) : '',
        diagnosisCodes: c.diagnosisCodes ?? '',
        modifier: c.modifier ?? '',
        chargeAmount: c.chargeAmount != null ? String(c.chargeAmount) : '',
        insuranceReimbursement: c.insuranceReimbursement != null ? String(c.insuranceReimbursement) : '',
        patientAmountPaid: c.patientAmountPaid != null ? String(c.patientAmountPaid) : '',
        patientAmountDue: c.patientAmountDue != null ? String(c.patientAmountDue) : '',
        insuranceBilled: c.insuranceBilled ?? '',
        oaClaimNumber: c.oaClaimNumber ?? '',
        claimSubmittedDate: c.claimSubmittedDate ?? '',
        expireBcbsClaimNumber: c.expireBcbsClaimNumber ?? '',
        claimStatus: c.claimStatus ?? 'submitted',
        paymentReceived: c.paymentReceived != null ? String(c.paymentReceived) : '',
        checkDate: c.checkDate ?? '',
        checkNumberVirtualCard: c.checkNumberVirtualCard ?? '',
        dateReceived: c.dateReceived ?? '',
        lmn: c.lmn ?? '',
        referenceNo: c.referenceNo ?? '',
        dateOfAppeal: c.dateOfAppeal ?? '',
        notes: c.notes ?? '',
      }));

      // Group rows by date — each unique date = 1 claim
      const dateGroupMap = new Map<string, any>();
      for (const row of rawRows) {
        const dateKey = row.dateOfService || 'no-date';
        if (!dateGroupMap.has(dateKey)) {
          dateGroupMap.set(dateKey, {
            ...row,
            _key: dateGroupMap.size,
            cptLines: [],
          });
        }
        const group = dateGroupMap.get(dateKey)!;
        group.cptLines.push({
          _key: row._key,
          cptCodes: row.cptCodes,
          chargeAmount: row.chargeAmount,
          insuranceReimbursement: row.insuranceReimbursement,
          patientAmountPaid: row.patientAmountPaid,
          patientAmountDue: row.patientAmountDue,
          unitsBilled: row.unitsBilled,
          modifier: row.modifier,
          diagnosisCodes: row.diagnosisCodes,
          notes: row.notes,
        });
      }
      const normalized = Array.from(dateGroupMap.values());

      setExtractedClaims(normalized);
      setEditingExtractedClaims(normalized);
      const templateMsg = json.templateUsed && json.templateUsed !== 'AI Extraction'
        ? ` (${json.templateUsed})`
        : ' (AI Extraction)';
      toast.success(`Extracted ${normalized.length} claim${normalized.length !== 1 ? 's' : ''} (${rawRows.length} CPT lines) from ${file.name}${templateMsg}`);
    } catch (err: any) {
      toast.error(`Upload failed: ${err.message}`);
    } finally {
      setIsExtractingClaims(false);
    }
  };

  const handleSaveExtractedClaims = async () => {
    if (!activePatient || claimUploadPeriod === null) return;
    setIsSavingExtractedClaims(true);
    let saved = 0;
    const failedRows: any[] = [];
    for (const row of editingExtractedClaims) {
      // Save one DB row per CPT line (not consolidated)
      const cptLines: any[] = row.cptLines && row.cptLines.length > 0 ? row.cptLines : [row];
      for (const line of cptLines) {
        try {
          const lineReimb = line.insuranceReimbursement !== '' && line.insuranceReimbursement != null ? parseFloat(line.insuranceReimbursement) : null;
          await upsertClaim.mutateAsync({
            patientId: activePatient.id,
            authPeriod: claimUploadPeriod,
            placeOfService: row.placeOfService || line.placeOfService || null,
            dateOfService: row.dateOfService || line.dateOfService || null,
            visitNumber: row.visitNumber !== '' && row.visitNumber != null ? parseInt(row.visitNumber, 10) : null,
            cptCodes: line.cptCodes || null,
            unitsBilled: line.unitsBilled ? parseInt(line.unitsBilled) : (row.unitsBilled ? parseInt(row.unitsBilled) : null),
            diagnosisCodes: line.diagnosisCodes || row.diagnosisCodes || null,
            modifier: line.modifier || row.modifier || null,
            chargeAmount: line.chargeAmount ? parseFloat(line.chargeAmount) : null,
            insuranceReimbursement: lineReimb,
            patientAmountPaid: line.patientAmountPaid !== '' && line.patientAmountPaid != null ? parseFloat(line.patientAmountPaid) : null,
            patientAmountDue: line.patientAmountDue !== '' && line.patientAmountDue != null ? parseFloat(line.patientAmountDue) : null,
            insuranceBilled: row.insuranceBilled || line.insuranceBilled || null,
            oaClaimNumber: row.oaClaimNumber || line.oaClaimNumber || null,
            claimSubmittedDate: row.claimSubmittedDate || line.claimSubmittedDate || null,
            expireBcbsClaimNumber: row.expireBcbsClaimNumber || line.expireBcbsClaimNumber || null,
            claimStatus: (row.claimStatus as any) || (line.claimStatus as any) || 'submitted',
            paymentReceived: row.paymentReceived ? parseFloat(row.paymentReceived) : (lineReimb ?? null),
            checkDate: row.checkDate || line.checkDate || null,
            checkNumberVirtualCard: row.checkNumberVirtualCard || line.checkNumberVirtualCard || null,
            dateReceived: row.dateReceived || line.dateReceived || null,
            dateOfAppeal: row.dateOfAppeal || line.dateOfAppeal || null,
            referenceNo: row.referenceNo || line.referenceNo || null,
            lmn: row.lmn || line.lmn || null,
          });
          saved++;
        } catch (e: any) {
          toast.error(`CPT ${line.cptCodes || '?'} failed: ${e.message}`);
          failedRows.push(row);
        }
      }
    }
    setIsSavingExtractedClaims(false);
    if (saved > 0) {
      toast.success(`${saved} claim${saved !== 1 ? 's' : ''} saved successfully!`);
      utils.claims.getByPatientAndPeriod.invalidate();
      utils.claims.getFollowUpClaims.invalidate();
      utils.claims.getStatusCounts.invalidate();
    }
    if (failedRows.length === 0) {
      setShowClaimUploadDialog(false);
      setExtractedClaims([]);
      setEditingExtractedClaims([]);
    } else {
      // Keep only failed rows in the dialog so staff can retry
      setEditingExtractedClaims(failedRows);
      toast.error(`${failedRows.length} row${failedRows.length !== 1 ? 's' : ''} failed to save. Please review and try again.`);
    }
  };

  // ── CSV Upload ─────────────────────────────────────────────────────────────

  const parseCSV = (text: string): Array<Record<string, string>> => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    return lines.slice(1).map(line => {
      const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = values[i] || ''; });
      return row;
    });
  };

  const handleBulkUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = parseCSV(text);
      if (data.length === 0) { toast.error('No data found in file'); return; }

      let successCount = 0;
      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const name = row['Patient Name'] || row['Name'] || row['Patient'];
        const insurance = row['Insurance'] || row['Insurance Company'] || 'Aetna';
        const authorized = parseInt(row['Authorized Sessions'] || row['Total Authorized'] || '0');
        const authDate = row['Authorization Date'] || null;
        const dateOfService = row['Date of Service'] || null;
        const sessionNumber = parseInt(row['Session Number'] || '1');
        const remaining = parseInt(row['Sessions Remaining'] || authorized.toString());
        const newAuth = row['New Authorization?'] || 'NO';
        const dateAshSubmitted = row['Date ASH Submitted'] || null;

        if (name && authorized > 0) {
          try {
            const { id: patientId } = await createPatient.mutateAsync({
              name: name.trim(),
              insurance: insurance.trim(),
              authDate: authDate || null,
            });
            await bulkCreateVisits.mutateAsync({
              patientId,
              records: [{
                sessionsAuthorized: authorized,
                sessionsRemaining: remaining,
                sessionNumber,
                dateOfService: dateOfService || null,
                newAuth,
                dateAshSubmitted: dateAshSubmitted || null,
                authStatus: 'none',
              }],
            });
            successCount++;
          } catch {}
        }
        setUploadProgress(Math.round(((i + 1) / data.length) * 100));
      }
      toast.success(`Imported ${successCount} patients`);
      setShowUploadDialog(false);
      setUploadProgress(0);
      event.target.value = '';
      utils.patients.list.invalidate();
    } catch {
      toast.error('Error reading file. Please check the format.');
      setUploadProgress(0);
    }
  };

  const handleDownloadTemplate = () => {
    const headers = ['Patient Name', 'Insurance', 'Authorized Sessions', 'Authorization Date', 'Date of Service', 'Session Number', 'Sessions Remaining', 'New Authorization?', 'Date ASH Submitted'];
    const rows = [
      ['John Doe', 'Aetna', '12', '2026-04-21', '2026-04-01', '1', '11', 'NO', ''],
      ['Jane Smith', 'NYCE PPO Plan', '15', '2026-03-10', '2026-03-15', '1', '14', 'NO', ''],
    ];
    const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${c}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'clinic_patient_template.csv';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    toast.success('Template downloaded!');
  };

  // ── Loading state ──────────────────────────────────────────────────────────

  if (patientsLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-brand-cream to-white flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-brand-blue">
          <Loader2 className="w-10 h-10 animate-spin text-brand-gold" />
          <p className="text-lg font-semibold">Loading patient data…</p>
        </div>
      </div>
    );
  }

  // ── Detail View ────────────────────────────────────────────────────────────

  if (showDetailView && activePatient) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-brand-cream to-white">
        {/* Header */}
        <div className="bg-brand-blue text-white py-4">
          <div className="container px-4 sm:px-6 lg:px-8">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDetailView(false)}
              className="mb-3 -ml-2 gap-1.5 text-brand-gold hover:text-white hover:bg-white/10"
            >
              <ChevronLeft className="w-4 h-4" />
              Back to Dashboard
            </Button>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-2xl sm:text-3xl font-bold">{activePatient.name}</h1>
                <p className="text-brand-gold text-sm mt-1">Detailed Visit Records — {activePatient.insurance}</p>
              </div>
              <div className="flex items-center gap-3">
                {/* Active / Inactive toggle */}
                <div className="flex items-center gap-2 bg-white/10 rounded-lg px-3 py-2">
                  {activePatient.isActive !== false ? (
                    <UserCheck className="w-4 h-4 text-green-300" />
                  ) : (
                    <UserX className="w-4 h-4 text-gray-300" />
                  )}
                  <span className={`text-sm font-semibold ${
                    activePatient.isActive !== false ? 'text-green-300' : 'text-gray-300'
                  }`}>
                    {activePatient.isActive !== false ? 'Active' : 'Discharged'}
                  </span>
                  <Switch
                    checked={activePatient.isActive !== false}
                    onCheckedChange={(checked) => handleToggleActive(activePatient.id, checked)}
                    disabled={setPatientActive.isPending}
                    aria-label="Toggle patient active status"
                    className="data-[state=checked]:bg-green-500"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => refetchVisits()}
                  aria-label="Refresh visit data"
                  className="gap-1.5 text-brand-gold hover:text-white hover:bg-white/10"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span className="hidden sm:inline">Refresh</span>
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="container py-8">
          {/* Discharge Info Banner */}
          {activePatient.isActive === false && (
            <div className="mb-6 rounded-xl border-2 border-gray-400 bg-gray-50 p-4 shadow-md flex items-start gap-3">
              <UserX className="w-6 h-6 mt-0.5 shrink-0 text-gray-500" />
              <div className="flex-1">
                <h3 className="font-bold text-base mb-1 text-gray-700">Discharged Patient</h3>
                <div className="flex flex-wrap gap-4 text-sm text-gray-600">
                  {activePatient.dischargeDate && (
                    <span><span className="font-semibold">Date of Discharge:</span> {new Date(activePatient.dischargeDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  )}
                  {activePatient.dischargeReason && (
                    <span><span className="font-semibold">Reason:</span> {activePatient.dischargeReason}</span>
                  )}
                  {!activePatient.dischargeDate && !activePatient.dischargeReason && (
                    <span className="text-gray-400 italic">No discharge details recorded.</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Auth Alert */}
          {alertStatus && (alertStatus.status === 'warning' || alertStatus.status === 'exhausted') && (
            <div className={`mb-6 rounded-xl border-2 p-4 shadow-md flex items-start gap-3 ${
              alertStatus.status === 'exhausted' ? 'border-red-400 bg-red-50' : 'border-orange-400 bg-orange-50'
            }`}>
              <AlertCircle className={`w-6 h-6 mt-0.5 shrink-0 ${alertStatus.status === 'exhausted' ? 'text-red-600' : 'text-orange-600'}`} />
              <div>
                <h3 className={`font-bold text-base mb-1 ${alertStatus.status === 'exhausted' ? 'text-red-800' : 'text-orange-800'}`}>
                  {alertStatus.label}
                </h3>
                <p className={`text-sm ${alertStatus.status === 'exhausted' ? 'text-red-700' : 'text-orange-700'}`}>
                  {alertStatus.message}
                </p>
              </div>
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            {[
              { label: 'Authorized', value: activeMetrics.totalAuthorized, tone: 'navy' as const },
              { label: 'Completed', value: activeMetrics.completed, tone: 'gold' as const },
              { label: 'Remaining', value: activeMetrics.remaining, tone: 'navy' as const },
            ].map(({ label, value, tone }) => (
              <MetricCard key={label} label={label} value={value} tone={tone} />
            ))}
          </div>

          {/* Visit Records — one Card per auth period */}
          {visitsLoading ? (
            <div className="flex items-center justify-center py-12 text-brand-blue">
              <Loader2 className="w-6 h-6 animate-spin mr-2 text-brand-gold" />
              Loading visits…
            </div>
          ) : visits.length === 0 ? (
            <Card className="border-brand-cream-dark shadow-md">
              <CardContent className="py-12 text-center text-muted-foreground">No visit records yet. Log a session to get started.</CardContent>
            </Card>
          ) : (
            <>
              {(() => {
                const periods = Array.from(new Set(visits.map(v => v.authPeriod ?? 1))).sort((a, b) => b - a); // newest first
                // Active period = oldest with remaining sessions (from activeMetrics)
                const activePeriod = activeMetrics.activePeriod;
                return periods.map(period => {
                  // Load claims for this period
                  const periodVisits = visits.filter(v => (v.authPeriod ?? 1) === period);
                  const periodAuth = periodVisits.find(v => v.sessionsAuthorized != null)?.sessionsAuthorized ?? 0;
                  const periodInsurance = periodVisits.find(v => v.insuranceCompany)?.insuranceCompany ?? null;
                  const isActive = period === activePeriod;
                  return (
                    <div key={`period-${period}`}>
                    <Card className={`shadow-sm rounded-xl overflow-hidden py-0 gap-0 mb-6 border ${
                      isActive ? 'border-gray-100 border-t-4 border-t-brand-gold' : 'border-gray-200'
                    }`}>
                      <CardHeader className={`px-6 py-5 flex flex-row items-center justify-between ${
                        isActive ? 'bg-brand-blue text-white' : 'bg-gray-100 text-gray-600'
                      }`}>
                        <div className="flex-1">
                          <CardTitle className={`text-xl font-serif font-bold ${ isActive ? 'text-white' : 'text-gray-700'}`}>
                            Authorization Period {period} — {periodAuth} Sessions
                          </CardTitle>
                          <CardDescription className={`text-sm mt-1 opacity-90 ${isActive ? 'text-brand-gold' : 'text-gray-500'}`}>
                            {periodInsurance && (
                              <span className="font-medium">{periodInsurance} · </span>
                            )}
                            {isActive
                              ? 'Active period · Click the calendar icon in "Date ASH Submitted" to edit'
                              : 'Completed authorization period — read-only history'}
                          </CardDescription>
                        </div>
                        {/* Log Session button only on active period (oldest with remaining sessions) */}
                        {isActive && (
                          <Dialog open={showLogSessionDialog} onOpenChange={setShowLogSessionDialog}>
                            <DialogTrigger asChild>
                              <Button className="bg-brand-gold hover:bg-brand-gold-dark text-brand-blue font-semibold px-5 py-2.5 rounded-lg inline-flex items-center gap-2 transition-all shadow-sm hover:shadow-md">
                                <Plus className="w-4 h-4" strokeWidth={2.5} />
                                Log Session
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="bg-white">
                              <DialogHeader>
                                <DialogTitle className="text-brand-blue">Log New Session</DialogTitle>
                                <DialogDescription>Record a therapy session for {activePatient.name}</DialogDescription>
                              </DialogHeader>
                              <div className="space-y-4">
                                <div>
                                  <Label className="text-brand-blue font-semibold">Date of Service</Label>
                                  <Input
                                    type="date"
                                    value={sessionDate}
                                    onChange={e => setSessionDate(e.target.value)}
                                    className="border-brand-cream-dark mt-2"
                                  />
                                </div>
                                <div className="bg-brand-cream rounded-lg p-4 text-sm text-brand-blue">
                                  <p><strong>Sessions remaining:</strong> {activeMetrics.remaining}</p>
                                  <p><strong>After this session:</strong> {Math.max(0, activeMetrics.remaining - 1)}</p>
                                </div>
                                <div className="flex gap-3">
                                  <Button
                                    onClick={handleLogSession}
                                    disabled={createVisit.isPending}
                                    className="flex-1 bg-brand-blue hover:bg-brand-blue-dark text-white font-semibold"
                                  >
                                    {createVisit.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                                    Confirm Session
                                  </Button>
                                  <Button onClick={() => setShowLogSessionDialog(false)} variant="outline" className="flex-1">
                                    Cancel
                                  </Button>
                                </div>
                              </div>
                            </DialogContent>
                          </Dialog>
                        )}
                      </CardHeader>
                      <CardContent className="p-0">
                        {/* Desktop table */}
                        <div className="overflow-x-auto hidden md:block">
                          <table className="w-full text-sm min-w-full">
                            <thead className="bg-brand-blue/95">
                              <tr>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Auth Date</th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider"># Authorized</th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider"># Remaining</th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Session #</th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Date of Service</th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">
                                  Date ASH Submitted
                                  <span className="text-brand-gold font-normal normal-case ml-1">(editable)</span>
                                </th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Auth Status</th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-100">
                      {periodVisits.map((visit) => (
                        <tr key={visit.id} className="hover:bg-brand-cream/30 transition-colors">
                          {/* Auth Date */}
                          <td className="px-4 py-2.5 text-sm text-brand-blue whitespace-nowrap">
                            {visit.dateOfService ? formatDate(visit.dateOfService) : <span className="text-gray-300 text-lg">—</span>}
                          </td>
                          {/* # Authorized */}
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            {visit.sessionsAuthorized != null ? (
                              <span className="font-semibold text-brand-blue text-base">{visit.sessionsAuthorized}</span>
                            ) : <span className="text-gray-300 text-lg">—</span>}
                          </td>
                          {/* # Remaining */}
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            {visit.sessionsRemaining != null ? (
                              <span className="font-bold text-brand-gold text-base">{visit.sessionsRemaining}</span>
                            ) : <span className="text-gray-300 text-lg">—</span>}
                          </td>
                          {/* Session # */}
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            {visit.sessionNumber != null ? (
                              <span className="font-medium text-gray-700 text-base">{visit.sessionNumber}</span>
                            ) : <span className="text-gray-300 text-lg">—</span>}
                          </td>
                          {/* Date of Service */}
                          <td className="px-4 py-2.5 text-sm text-muted-foreground whitespace-nowrap">
                            {visit.dateOfService ? formatDate(visit.dateOfService) : <span className="text-gray-300 text-lg">—</span>}
                          </td>
                          {/* Date ASH Submitted — EDITABLE */}
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            {editingAshId === visit.id ? (
                              <div className="flex items-center gap-2">
                                <input
                                  type="date"
                                  value={editingAshValue}
                                  onChange={e => setEditingAshValue(e.target.value)}
                                  className="border border-brand-gold rounded-md px-2 py-1.5 text-sm text-brand-blue focus:outline-none focus:ring-2 focus:ring-brand-gold/30"
                                  autoFocus
                                />
                                <Button
                                  size="sm"
                                  onClick={() => handleSaveAsh(visit.id)}
                                  disabled={updateVisit.isPending}
                                  className="h-auto text-green-600 hover:text-green-800 font-bold text-xs px-2 py-1 bg-green-50 hover:bg-green-100"
                                >
                                  {updateVisit.isPending ? '…' : 'Save'}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={handleCancelAsh}
                                  className="h-auto text-gray-500 hover:text-gray-700 font-bold text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200"
                                >
                                  Cancel
                                </Button>
                              </div>
                            ) : (
                              <button
                                onClick={() => handleStartEditAsh(visit)}
                                className="flex items-center gap-2 group text-gray-400 hover:text-brand-blue cursor-pointer transition-colors"
                                title="Click to edit Date ASH Submitted"
                                aria-label={visit.dateAshSubmitted ? `Edit Date ASH Submitted, currently ${formatDate(visit.dateAshSubmitted)}` : 'Set Date ASH Submitted'}
                              >
                                <Calendar className="w-4 h-4 text-brand-gold group-hover:scale-110 transition-transform shrink-0" />
                                <span className={visit.dateAshSubmitted ? 'text-brand-blue text-sm' : 'text-sm italic'}>
                                  {visit.dateAshSubmitted ? formatDate(visit.dateAshSubmitted) : 'Click to set date'}
                                </span>
                              </button>
                            )}
                          </td>
                          {/* Auth Status */}
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            <VisitAuthStatusSelect visit={visit} onChange={handleUpdateAuthStatus} />
                          </td>
                        </tr>
                      ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Mobile stacked cards */}
                        <div className="md:hidden divide-y divide-gray-100">
                          {periodVisits.map((visit) => (
                            <div key={visit.id} className="p-4 space-y-2.5">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-semibold text-brand-blue">
                                  {visit.sessionNumber != null ? `Session #${visit.sessionNumber}` : 'Session'}
                                </span>
                                <VisitAuthStatusSelect visit={visit} onChange={handleUpdateAuthStatus} />
                              </div>
                              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                                <div>
                                  <p className="text-xs text-muted-foreground">Auth Date</p>
                                  <p className="text-brand-blue">{visit.dateOfService ? formatDate(visit.dateOfService) : '—'}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground"># Authorized / Remaining</p>
                                  <p>
                                    <span className="font-semibold text-brand-blue">{visit.sessionsAuthorized ?? '—'}</span>
                                    {' / '}
                                    <span className="font-bold text-brand-gold">{visit.sessionsRemaining ?? '—'}</span>
                                  </p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground">Date of Service</p>
                                  <p className="text-muted-foreground">{visit.dateOfService ? formatDate(visit.dateOfService) : '—'}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground">Date ASH Submitted</p>
                                  {editingAshId === visit.id ? (
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                      <input
                                        type="date"
                                        value={editingAshValue}
                                        onChange={e => setEditingAshValue(e.target.value)}
                                        className="border border-brand-gold rounded-md px-1.5 py-1 text-xs text-brand-blue focus:outline-none focus:ring-2 focus:ring-brand-gold/30"
                                        autoFocus
                                      />
                                      <Button size="sm" onClick={() => handleSaveAsh(visit.id)} disabled={updateVisit.isPending} className="h-auto text-xs px-2 py-1 bg-green-50 text-green-700 hover:bg-green-100">
                                        {updateVisit.isPending ? '…' : 'Save'}
                                      </Button>
                                      <Button size="sm" variant="secondary" onClick={handleCancelAsh} className="h-auto text-xs px-2 py-1">
                                        Cancel
                                      </Button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => handleStartEditAsh(visit)}
                                      className="flex items-center gap-1.5 text-gray-400 hover:text-brand-blue"
                                      aria-label={visit.dateAshSubmitted ? `Edit Date ASH Submitted, currently ${formatDate(visit.dateAshSubmitted)}` : 'Set Date ASH Submitted'}
                                    >
                                      <Calendar className="w-3.5 h-3.5 text-brand-gold shrink-0" />
                                      <span className={visit.dateAshSubmitted ? 'text-brand-blue' : 'italic'}>
                                        {visit.dateAshSubmitted ? formatDate(visit.dateAshSubmitted) : 'Set date'}
                                      </span>
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>

                    {/* Claims Tracking Card — Below Authorization Period */}
                    <Card key={`claims-${period}`} className="border border-border border-t-4 border-t-brand-gold shadow-brand rounded-xl mb-6 ml-0">
                      <CardHeader className="bg-white rounded-t-xl">
                        <div className="flex items-start justify-between gap-4 mb-4">
                          <div className="space-y-1">
                            <CardTitle className="text-xl font-serif font-semibold tracking-tight text-brand-blue">
                              Claims Tracker — Period {period}
                            </CardTitle>
                            <CardDescription className="text-sm text-muted-foreground">
                              Comprehensive claim details and payment tracking
                            </CardDescription>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap justify-end">
                            {/* Column visibility toggle */}
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button variant="outline" size="sm" className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap">
                                  <Columns3 className="h-4 w-4" />
                                  Columns
                                  {hiddenClaimsColumns.size > 0 && (
                                    <span className="ml-1 bg-brand-gold text-brand-blue text-[10px] rounded-full w-4 h-4 flex items-center justify-center font-bold">
                                      {hiddenClaimsColumns.size}
                                    </span>
                                  )}
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-64 p-3" align="end">
                                <div className="mb-2 flex items-center justify-between">
                                  <p className="text-sm font-semibold text-gray-700">Toggle Columns</p>
                                  {hiddenClaimsColumns.size > 0 && (
                                    <button
                                      onClick={() => {
                                        setHiddenClaimsColumns(new Set());
                                        localStorage.removeItem('claims-hidden-columns');
                                      }}
                                      className="text-xs text-brand-blue hover:underline"
                                    >
                                      Show all
                                    </button>
                                  )}
                                </div>
                                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                                  {[
                                    { key: 'placeOfService', label: 'Place of Service' },
                                    { key: 'dateOfService', label: 'Date of Service' },
                                    { key: 'visitNumber', label: 'Visit #' },
                                    { key: 'cptCodes', label: 'CPT Codes' },
                                    { key: 'unitsBilled', label: 'Units Billed' },
                                    { key: 'diagnosisCodes', label: 'Diagnosis Codes' },
                                    { key: 'modifier', label: 'Modifier' },
                                    { key: 'chargeAmount', label: 'Charge Amount' },
                                    { key: 'insuranceReimbursement', label: 'Ins. Reimbursement' },
                                    { key: 'patientAmountPaid', label: 'Patient Amount Paid' },
                                    { key: 'patientAmountDue', label: 'Patient Amount Due' },
                                    { key: 'insuranceBilled', label: 'Insurance Billed' },
                                    { key: 'claimSubmittedDate', label: 'Date Submitted' },
                                    { key: 'expireBcbsClaimNumber', label: 'Claim #' },
                                    { key: 'claimStatus', label: 'Claim Status' },
                                    { key: 'lmn', label: 'LMN Documents Date Sent' },
                                    { key: 'checkDate', label: 'Check/Payment Date' },
                                    { key: 'checkNumberVirtualCard', label: 'Check/EFT #' },
                                    { key: 'dateOfAppeal', label: 'Date of Appeal' },
                                    { key: 'referenceNo', label: 'Appeal Ref #' },
                                  ].map(col => (
                                    <div key={col.key} className="flex items-center gap-2 py-0.5">
                                      <Checkbox
                                        id={`col-${col.key}`}
                                        checked={!hiddenClaimsColumns.has(col.key)}
                                        onCheckedChange={() => toggleClaimsColumn(col.key)}
                                      />
                                      <label htmlFor={`col-${col.key}`} className="text-xs text-gray-700 cursor-pointer select-none">
                                        {col.label}
                                      </label>
                                    </div>
                                  ))}
                                </div>
                              </PopoverContent>
                            </Popover>
                            {/* CSV export — currently visible/filtered rows for this period */}
                            <Button
                              variant="outline"
                              size="sm"
                              className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap"
                              disabled={(claimsDataMap[period] ?? []).length === 0}
                              onClick={() => {
                                const csv = claimsToCSV(claimsDataMap[period] ?? []);
                                const filename = `${patientNameForFilename(activePatient?.name ?? 'patient')}-claims-${todayForFilename()}.csv`;
                                downloadCSV(filename, csv);
                              }}
                            >
                              <Download className="h-4 w-4" />
                              Export
                            </Button>
                            {/* Reimbursement Insurance Upload button */}
                            <label
                              htmlFor={`claim-upload-reimb-${period}`}
                              className="cursor-pointer inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap"
                              title="Upload Reimbursement Insurance EOB (PDF/CSV) to auto-fill insurance reimbursement, CPT codes, charge amounts"
                            >
                              {isExtractingClaims && claimUploadPeriod === period && claimUploadType === 'reimbursement'
                                ? <><Loader2 className="h-4 w-4 animate-spin" /> Extracting…</>
                                : <><Upload className="h-4 w-4" /> Reimbursement Insurance Upload</>
                              }
                            </label>
                            <input
                              id={`claim-upload-reimb-${period}`}
                              type="file"
                              accept=".pdf,.csv,.xlsx,.xls,.xlsm"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                console.log('[EOB Upload] File selected:', file.name);
                                setClaimUploadPeriod(period);
                                setShowClaimUploadDialog(true);
                                console.log('[EOB Upload] Dialog opened, calling handleClaimFileUpload');
                                handleClaimFileUpload(file, period, 'reimbursement');
                                e.target.value = '';
                              }}
                            />
                            {/* CMS1500 Upload button */}
                            <label
                              htmlFor={`claim-upload-cms-${period}`}
                              className="cursor-pointer inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap"
                              title="Upload CMS1500 claim form (PDF) to auto-fill dates, place of service, CPT codes, modifiers, diagnosis codes, units"
                            >
                              {isExtractingClaims && claimUploadPeriod === period && claimUploadType === 'cms1500'
                                ? <><Loader2 className="h-4 w-4 animate-spin" /> Extracting…</>
                                : <><Upload className="h-4 w-4" /> CMS1500 Upload</>
                              }
                            </label>
                            <input
                              id={`claim-upload-cms-${period}`}
                              type="file"
                              accept=".pdf"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                setClaimUploadPeriod(period);
                                setShowClaimUploadDialog(true);
                                handleClaimFileUpload(file, period, 'cms1500');
                                e.target.value = '';
                              }}
                            />
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="p-0">
                        {(() => {
                          const claims = claimsDataMap[period] ?? [];
                          
                          if (!claims || claims.length === 0) {
                            return (
                              <div className="p-6 text-center text-sm text-muted-foreground bg-brand-cream/40">
                                No claim records yet. Click "Add Claim" to create the first record.
                              </div>
                            );
                          }
                          
                          return (
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs border-collapse">
                                <thead>
                                  <tr className="bg-brand-cream border-b border-brand-cream-dark">
                                    {[{key:'placeOfService',label:'Place of Service',align:'left'},{key:'dateOfService',label:'Date of Service',align:'left'},{key:'visitNumber',label:'Visit #',align:'left'},{key:'cptCodes',label:'CPT Codes',align:'left'},{key:'unitsBilled',label:'Units',align:'center'},{key:'diagnosisCodes',label:'Diagnosis',align:'left'},{key:'modifier',label:'Modifier',align:'left'},{key:'chargeAmount',label:'Charge',align:'right'},{key:'insuranceReimbursement',label:'Ins. Reimb.',align:'right'},{key:'patientAmountPaid',label:'Pt. Paid',align:'right'},{key:'patientAmountDue',label:'Pt. Due',align:'right'},{key:'insuranceBilled',label:'Ins. Billed',align:'left'},{key:'claimSubmittedDate',label:'Date Submitted',align:'left'},{key:'expireBcbsClaimNumber',label:'Claim #',align:'left'},{key:'claimStatus',label:'Status',align:'center'},{key:'lmn',label:'LMN Documents Date Sent',align:'left'},{key:'checkDate',label:'Check/Payment Date',align:'left'},{key:'checkNumberVirtualCard',label:'Check/EFT #',align:'left'},{key:'dateOfAppeal',label:'Appeal Date',align:'left'},{key:'referenceNo',label:'Appeal Ref #',align:'left'}].filter(c => !hiddenClaimsColumns.has(c.key)).map(c => (
                                      <th key={c.key} className={`border border-brand-cream-dark px-2 py-2 text-${c.align} font-semibold text-brand-blue uppercase text-[10px] tracking-wider whitespace-nowrap`}>{c.label}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {claims.map((claim: any, claimIdx: number) => {
                                    // Show the date once per group of consecutive rows that share it,
                                    // instead of repeating it on every CPT line for the same visit.
                                    const prevClaim = claimIdx > 0 ? claims[claimIdx - 1] : null;
                                    const isSameDateAsPrev = prevClaim && prevClaim.date_of_service === claim.date_of_service;
                                    const isEditing = (field: string) =>
                                      editingCell?.claimId === claim.id && editingCell?.field === field;

                                    const startEdit = (field: string, rawValue: string) => {
                                      setEditingCell({ claimId: claim.id, field });
                                      setEditingValue(rawValue);
                                    };

                                    const commitEdit = (field: string, isNumeric = false, isDate = false) => {
                                      if (!editingCell) return;
                                      const payload: Record<string, any> = { id: claim.id };
                                      if (isNumeric) {
                                        payload[field] = editingValue.trim() ? parseFloat(editingValue) : null;
                                      } else if (isDate) {
                                        payload[field] = editingValue.trim() || null;
                                      } else {
                                        payload[field] = editingValue.trim() || null;
                                      }
                                      updateClaim.mutate(payload as any);
                                    };

                                    const cellClass = "border border-gray-200 px-1 py-1 cursor-pointer hover:bg-yellow-50 group/cell relative";
                                    const inputClass = "w-full min-w-[80px] text-xs border border-blue-400 rounded px-1 py-0.5 outline-none bg-white";

                                    const EditableText = ({ field, value, align = '' }: { field: string; value: string | null; align?: string }) => (
                                      <td className={`${cellClass} ${align}`} onClick={() => !isEditing(field) && startEdit(field, value ?? '')}>
                                        {isEditing(field) ? (
                                          <input
                                            autoFocus
                                            className={inputClass}
                                            value={editingValue}
                                            onChange={e => setEditingValue(e.target.value)}
                                            onBlur={() => commitEdit(field)}
                                            onKeyDown={e => { if (e.key === 'Enter') commitEdit(field); if (e.key === 'Escape') setEditingCell(null); }}
                                          />
                                        ) : (
                                          <span className="block truncate max-w-[100px]">{value || <span className="text-gray-300">—</span>}</span>
                                        )}
                                      </td>
                                    );

                                    const EditableNumber = ({ field, value, prefix = '', decimals = 2 }: { field: string; value: number | string | null; prefix?: string; decimals?: number }) => {
                                      const numVal = value != null ? parseFloat(value as string) : null;
                                      return (
                                        <td className={`${cellClass} text-right`} onClick={() => !isEditing(field) && startEdit(field, numVal?.toString() ?? '')}>
                                          {isEditing(field) ? (
                                            <input
                                              autoFocus
                                              type="number"
                                              step={decimals === 0 ? '1' : '0.01'}
                                              className={inputClass}
                                              value={editingValue}
                                              onChange={e => setEditingValue(e.target.value)}
                                              onBlur={() => commitEdit(field, true)}
                                              onKeyDown={e => { if (e.key === 'Enter') commitEdit(field, true); if (e.key === 'Escape') setEditingCell(null); }}
                                            />
                                          ) : (
                                            <span>{numVal != null && !isNaN(numVal) ? `${prefix}${numVal.toFixed(decimals)}` : <span className="text-gray-300">—</span>}</span>
                                          )}
                                        </td>
                                      );
                                    };

                                    const EditableDate = ({ field, value }: { field: string; value: string | null }) => {
                                      const displayDate = value ? new Date(value).toLocaleDateString() : null;
                                      const rawDate = value ? new Date(value).toISOString().split('T')[0] : '';
                                      return (
                                        <td className={cellClass} onClick={() => !isEditing(field) && startEdit(field, rawDate)}>
                                          {isEditing(field) ? (
                                            <input
                                              autoFocus
                                              type="date"
                                              className={inputClass}
                                              value={editingValue}
                                              onChange={e => setEditingValue(e.target.value)}
                                              onBlur={() => commitEdit(field, false, true)}
                                              onKeyDown={e => { if (e.key === 'Enter') commitEdit(field, false, true); if (e.key === 'Escape') setEditingCell(null); }}
                                            />
                                          ) : (
                                            <span>{displayDate || <span className="text-gray-300">—</span>}</span>
                                          )}
                                        </td>
                                      );
                                    };

                                    const statusColors: Record<string, string> = {
                                      approved: 'bg-green-100 text-green-800',
                                      denied: 'bg-red-100 text-red-800',
                                      pending: 'bg-yellow-100 text-yellow-800',
                                      submitted: 'bg-blue-100 text-blue-800',
                                      pended: 'bg-orange-100 text-orange-800',
                                      rejected: 'bg-gray-900 text-white',
                                      resubmitted: 'bg-violet-100 text-violet-800',
                                    };

                                    const hide = (key: string) => hiddenClaimsColumns.has(key);
                                    return (
                                      <tr key={claim.id} className="hover:bg-brand-cream/50 border-b border-gray-200 text-xs">
                                        {!hide('placeOfService') && <EditableText field="placeOfService" value={claim.place_of_service} />}
                                        {!hide('dateOfService') && (
                                          isSameDateAsPrev ? (
                                            <td className={cellClass}></td>
                                          ) : (
                                            <EditableDate field="dateOfService" value={claim.date_of_service} />
                                          )
                                        )}
                                        {!hide('visitNumber') && <EditableNumber field="visitNumber" value={claim.visit_number ?? null} decimals={0} />}
                                        {!hide('cptCodes') && <EditableText field="cptCodes" value={claim.cpt_codes} />}
                                        {!hide('unitsBilled') && <EditableNumber field="unitsBilled" value={claim.units_billed} />}
                                        {!hide('diagnosisCodes') && <EditableText field="diagnosisCodes" value={claim.diagnosis_codes} />}
                                        {!hide('modifier') && <EditableText field="modifier" value={claim.modifier} />}
                                        {!hide('chargeAmount') && <EditableNumber field="chargeAmount" value={claim.charge_amount} prefix="$" />}
                                        {!hide('insuranceReimbursement') && <EditableNumber field="insuranceReimbursement" value={claim.insurance_reimbursement} prefix="$" />}
                                        {!hide('patientAmountPaid') && <EditableNumber field="patientAmountPaid" value={claim.patient_amount_paid} prefix="$" />}
                                        {!hide('patientAmountDue') && <EditableNumber field="patientAmountDue" value={claim.patient_amount_due} prefix="$" />}
                                        {!hide('insuranceBilled') && <EditableText field="insuranceBilled" value={claim.insurance_billed} />}
                                        {!hide('claimSubmittedDate') && <EditableDate field="claimSubmittedDate" value={claim.claim_submitted_date} />}
                                        {!hide('expireBcbsClaimNumber') && (
                                          <td className={cellClass} onClick={() => !isEditing('expireBcbsClaimNumber') && startEdit('expireBcbsClaimNumber', claim.expire_bcbs_claim_number ?? '')}>
                                            {isEditing('expireBcbsClaimNumber') ? (
                                              <input
                                                autoFocus
                                                className="w-full min-w-[80px] text-xs border border-blue-400 rounded px-1 py-0.5 outline-none bg-white"
                                                value={editingValue}
                                                onChange={e => setEditingValue(e.target.value)}
                                                onBlur={() => commitEdit('expireBcbsClaimNumber')}
                                                onKeyDown={e => { if (e.key === 'Enter') commitEdit('expireBcbsClaimNumber'); if (e.key === 'Escape') setEditingCell(null); }}
                                              />
                                            ) : (
                                              <span className="block truncate max-w-[100px]">
                                                {claim.expire_bcbs_claim_number || claim.oa_claim_number || <span className="text-gray-300">—</span>}
                                              </span>
                                            )}
                                          </td>
                                        )}
                                        {/* Status — dropdown select */}
                                        {!hide('claimStatus') && (
                                          <td
                                            className={`${cellClass} text-center`}
                                            onClick={() => !isEditing('claimStatus') && startEdit('claimStatus', claim.claim_status ?? 'submitted')}
                                          >
                                            {isEditing('claimStatus') ? (
                                              <select
                                                autoFocus
                                                className="text-xs border border-blue-400 rounded px-1 py-0.5 bg-white"
                                                value={editingValue}
                                                onChange={e => {
                                                  setEditingValue(e.target.value);
                                                  updateClaim.mutate({ id: claim.id, claimStatus: e.target.value as any });
                                                }}
                                                onBlur={() => setEditingCell(null)}
                                                onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setEditingCell(null); }}
                                              >
                                                <option value="submitted">Submitted</option>
                                                <option value="approved">Approved</option>
                                                <option value="pending">Pending</option>
                                                <option value="denied">Denied</option>
                                                <option value="pended">Pended</option>
                                                <option value="rejected">Rejected</option>
                                                <option value="resubmitted">Resubmitted</option>
                                              </select>
                                            ) : (
                                              <Badge className={statusColors[claim.claim_status] ?? 'bg-blue-100 text-blue-800'}>
                                                {claim.claim_status ?? 'submitted'}
                                              </Badge>
                                            )}
                                          </td>
                                        )}
                                        {!hide('lmn') && <EditableText field="lmn" value={claim.lmn} />}
                                        {!hide('checkDate') && <EditableDate field="checkDate" value={claim.check_date} />}
                                        {!hide('checkNumberVirtualCard') && <EditableText field="checkNumberVirtualCard" value={claim.check_number_virtual_card} />}
                                        {!hide('dateOfAppeal') && <EditableDate field="dateOfAppeal" value={claim.date_of_appeal} />}
                                        {!hide('referenceNo') && <EditableText field="referenceNo" value={claim.reference_no} />}
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          );
                        })()}
                      </CardContent>
                    </Card>
                    </div>
                  );
                });
              })()}
            </>
          )}
        </div>
        {/* Add Claim Dialog */}
        <Dialog open={showAddClaimDialog} onOpenChange={setShowAddClaimDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add New Claim Record</DialogTitle>
            <DialogDescription>
              Period {addClaimPeriod} for {activePatient?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Place of Service</Label>
              <Input value={claimFormData.placeOfService} onChange={(e) => setClaimFormData({...claimFormData, placeOfService: e.target.value})} />
            </div>
            <div>
              <Label>Date of Service</Label>
              <Input type="date" value={claimFormData.dateOfService} onChange={(e) => setClaimFormData({...claimFormData, dateOfService: e.target.value})} />
            </div>
            <div>
              <Label>Visit #</Label>
              <Input value={claimFormData.visitNumber} onChange={(e) => setClaimFormData({...claimFormData, visitNumber: e.target.value})} />
            </div>
            <div>
              <Label>CPT Codes</Label>
              <Input value={claimFormData.cptCodes} onChange={(e) => setClaimFormData({...claimFormData, cptCodes: e.target.value})} />
            </div>
            <div>
              <Label>Units Billed</Label>
              <Input type="number" value={claimFormData.unitsBilled} onChange={(e) => setClaimFormData({...claimFormData, unitsBilled: e.target.value})} />
            </div>
            <div>
              <Label>Diagnosis Codes</Label>
              <Input value={claimFormData.diagnosisCodes} onChange={(e) => setClaimFormData({...claimFormData, diagnosisCodes: e.target.value})} />
            </div>
            <div>
              <Label>Modifier</Label>
              <Input value={claimFormData.modifier} onChange={(e) => setClaimFormData({...claimFormData, modifier: e.target.value})} />
            </div>
            <div>
              <Label>Charge Amount</Label>
              <Input type="number" step="0.01" value={claimFormData.chargeAmount} onChange={(e) => setClaimFormData({...claimFormData, chargeAmount: e.target.value})} />
            </div>
            <div>
              <Label>Insurance Reimbursement</Label>
              <Input type="number" step="0.01" value={claimFormData.insuranceReimbursement} onChange={(e) => setClaimFormData({...claimFormData, insuranceReimbursement: e.target.value})} />
            </div>
            <div>
              <Label>Patient Amount Paid</Label>
              <Input type="number" step="0.01" value={claimFormData.patientAmountPaid} onChange={(e) => setClaimFormData({...claimFormData, patientAmountPaid: e.target.value})} />
            </div>
            <div>
              <Label>Patient Amount Due</Label>
              <Input type="number" step="0.01" value={claimFormData.patientAmountDue} onChange={(e) => setClaimFormData({...claimFormData, patientAmountDue: e.target.value})} />
            </div>
            <div>
              <Label>Insurance Billed</Label>
              <Input value={claimFormData.insuranceBilled} onChange={(e) => setClaimFormData({...claimFormData, insuranceBilled: e.target.value})} />
            </div>
            <div>
              <Label>Date Submitted</Label>
              <Input type="date" value={claimFormData.claimSubmittedDate} onChange={(e) => setClaimFormData({...claimFormData, claimSubmittedDate: e.target.value})} />
            </div>
            <div>
              <Label>Claim #</Label>
              <Input value={claimFormData.expireBcbsClaimNumber} onChange={(e) => setClaimFormData({...claimFormData, expireBcbsClaimNumber: e.target.value})} />
            </div>
            <div>
              <Label>Claim Status</Label>
              <Select value={claimFormData.claimStatus} onValueChange={(val) => setClaimFormData({...claimFormData, claimStatus: val})}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="submitted">Submitted</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="denied">Denied</SelectItem>
                  <SelectItem value="pended">Pended</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="resubmitted">Resubmitted</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>LMN Documents Date Sent</Label>
              <Input value={claimFormData.lmn ?? ''} onChange={(e) => setClaimFormData({...claimFormData, lmn: e.target.value})} placeholder="LMN documents date sent" />
            </div>
            <div>
              <Label>Check/Payment Date</Label>
              <Input type="date" value={claimFormData.checkDate} onChange={(e) => setClaimFormData({...claimFormData, checkDate: e.target.value})} />
            </div>
            <div>
              <Label>Check/EFT #</Label>
              <Input value={claimFormData.checkNumberVirtualCard} onChange={(e) => setClaimFormData({...claimFormData, checkNumberVirtualCard: e.target.value})} />
            </div>
            <div>
              <Label>Appeal Date</Label>
              <Input type="date" value={claimFormData.dateOfAppeal} onChange={(e) => setClaimFormData({...claimFormData, dateOfAppeal: e.target.value})} />
            </div>
            <div>
              <Label>Appeal Ref #</Label>
              <Input value={claimFormData.referenceNo} onChange={(e) => setClaimFormData({...claimFormData, referenceNo: e.target.value})} />
            </div>
          </div>
          <div className="flex gap-3 justify-end mt-6">
            <Button variant="outline" onClick={() => setShowAddClaimDialog(false)}>Cancel</Button>
            <Button
              disabled={isSavingClaim || !activePatient}
              onClick={() => {
                if (!activePatient || addClaimPeriod === null) return;
                setIsSavingClaim(true);
                createClaim.mutate({
                  patientId: activePatient.id,
                  authPeriod: addClaimPeriod,
                  placeOfService: claimFormData.placeOfService || null,
                  dateOfService: claimFormData.dateOfService || null,
                  visitNumber: claimFormData.visitNumber !== '' ? parseInt(claimFormData.visitNumber, 10) : null,
                  cptCodes: claimFormData.cptCodes || null,
                  unitsBilled: claimFormData.unitsBilled ? parseInt(claimFormData.unitsBilled) : null,
                  diagnosisCodes: claimFormData.diagnosisCodes || null,
                  modifier: claimFormData.modifier || null,
                  chargeAmount: claimFormData.chargeAmount ? parseFloat(claimFormData.chargeAmount) : null,
                  insuranceReimbursement: claimFormData.insuranceReimbursement ? parseFloat(claimFormData.insuranceReimbursement) : null,
                  patientAmountPaid: claimFormData.patientAmountPaid !== '' ? parseFloat(claimFormData.patientAmountPaid) : null,
                  patientAmountDue: claimFormData.patientAmountDue !== '' ? parseFloat(claimFormData.patientAmountDue) : null,
                  insuranceBilled: claimFormData.insuranceBilled || null,
                  oaClaimNumber: claimFormData.oaClaimNumber || null,
                  claimSubmittedDate: claimFormData.claimSubmittedDate || null,
                  expireBcbsClaimNumber: claimFormData.expireBcbsClaimNumber || null,
                  claimStatus: (claimFormData.claimStatus as 'submitted' | 'approved' | 'pending' | 'denied') || 'submitted',
                  paymentReceived: claimFormData.paymentReceived ? parseFloat(claimFormData.paymentReceived) : null,
                  checkDate: claimFormData.checkDate || null,
                  checkNumberVirtualCard: claimFormData.checkNumberVirtualCard || null,
                  dateReceived: claimFormData.dateReceived || null,
                  dateOfAppeal: claimFormData.dateOfAppeal || null,
                  referenceNo: claimFormData.referenceNo || null,
                });
              }}
              className="bg-brand-blue hover:bg-brand-blue-dark text-white"
            >
              {isSavingClaim ? 'Saving...' : 'Save Claim Record'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── PDF/CSV Upload Preview Dialog ── */}
      <Dialog
        open={showClaimUploadDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowClaimUploadDialog(false);
            setExtractedClaims([]);
            setEditingExtractedClaims([]);
            setEobPatientGroups(null);
            setBulkImportResults(null);
          }
        }}
      >
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-serif text-brand-blue">
              <Upload className="w-5 h-5 text-brand-gold" />
              {eobPatientGroups
                ? 'Bulk EOB Import — Multiple Patients'
                : claimUploadType === 'cms1500'
                  ? 'CMS1500 Upload — Review Extracted Claims'
                  : 'Reimbursement Insurance Upload — Review Extracted Claims'
              }
            </DialogTitle>
            <DialogDescription>
              {uploadFileName && <span className="font-medium text-gray-700">{uploadFileName}</span>}
              {eobPatientGroups ? (
                <span className="ml-1 text-gray-600">
                  {' — '}{eobPatientGroups.length} patient{eobPatientGroups.length !== 1 ? 's' : ''} detected.
                  Matched patients will be auto-imported.
                </span>
              ) : (
                <span className="ml-1 text-gray-600">
                  {' — '}
                  Period {claimUploadPeriod} for <span className="font-medium">{activePatient?.name}</span>.
                  Review and edit each row before saving.
                </span>
              )}
              {detectedTemplate && (
                <span className={`ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                  detectedTemplate !== 'AI Extraction'
                    ? 'bg-green-100 text-green-800'
                    : 'bg-blue-100 text-blue-800'
                }`}>
                  {detectedTemplate !== 'AI Extraction' ? '✓ ' : '🤖 '}{detectedTemplate}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {isExtractingClaims ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4 text-gray-500">
              <Loader2 className="w-10 h-10 animate-spin text-brand-gold" />
              <p className="text-sm font-medium">Reading file and extracting claim data…</p>
              <p className="text-xs text-gray-400">Checking for known insurance templates, then using AI if needed.</p>
            </div>

          ) : eobPatientGroups ? (
            /* ── Multi-patient EOB preview ── */
            <div className="space-y-4">
              {bulkImportResults ? (
                /* Results view after import */
                <div className="space-y-3">
                  <p className="text-sm font-semibold text-gray-700">Import Results:</p>
                  {bulkImportResults.map((r, i) => (
                    <div key={i} className={`flex items-center justify-between px-4 py-3 rounded-lg border ${
                      r.matched && !r.error ? 'bg-green-50 border-green-200' :
                      r.error ? 'bg-red-50 border-red-200' :
                      'bg-yellow-50 border-yellow-200'
                    }`}>
                      <div>
                        <p className="font-semibold text-sm text-gray-800">{r.patientName}</p>
                        {r.matched && r.dashboardName && (
                          <p className="text-xs text-gray-500">Matched: {r.dashboardName} · Auth Period {r.authPeriod}</p>
                        )}
                        {!r.matched && (
                          <p className="text-xs text-yellow-700">Not found in dashboard — skipped</p>
                        )}
                        {r.error && (
                          <p className="text-xs text-red-600">Error: {r.error}</p>
                        )}
                      </div>
                      <div className="text-right">
                        {r.matched && !r.error && (
                          <span className="text-green-700 font-semibold text-sm">✓ {r.claimsImported} claim{r.claimsImported !== 1 ? 's' : ''} imported</span>
                        )}
                        {!r.matched && (
                          <span className="text-yellow-600 font-semibold text-sm">Skipped</span>
                        )}
                        {r.error && (
                          <span className="text-red-600 font-semibold text-sm">{r.claimsImported} saved before error</span>
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="flex justify-end pt-2 border-t">
                    <Button
                      onClick={() => {
                        // Auto-select first imported patient so they can see their claims immediately
                        const firstImported = bulkImportResults?.find(r => r.matched && !r.error);
                        if (firstImported?.patientId) {
                          setSelectedPatientId(firstImported.patientId);
                        }
                        setShowClaimUploadDialog(false);
                        setEobPatientGroups(null);
                        setBulkImportResults(null);
                      }}
                      className="bg-brand-blue hover:bg-brand-blue-dark text-white"
                    >
                      Done
                    </Button>
                  </div>
                </div>
              ) : (
                /* Preview before import */
                <>
                  <p className="text-sm text-gray-600">
                    <span className="font-semibold text-green-700">{eobPatientGroups.length}</span> patient{eobPatientGroups.length !== 1 ? 's' : ''} detected in this file.
                    Patients matching your dashboard will have their claims auto-imported.
                  </p>
                  <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-1">
                    {eobPatientGroups.map((group, gIdx) => {
                      const matchedPatient = findMatchingPatient(group.patientName, patients);
                      return (
                        <div key={gIdx} className={`rounded-lg border ${
                          matchedPatient ? 'border-green-300 bg-green-50' : 'border-yellow-300 bg-yellow-50'
                        }`}>
                          <div className="flex items-center justify-between px-4 py-2 border-b border-inherit">
                            <div className="flex items-center gap-2">
                              {matchedPatient ? (
                                <span className="text-green-700 font-bold text-sm">✓ {group.patientName}</span>
                              ) : (
                                <span className="text-yellow-700 font-bold text-sm">⚠ {group.patientName}</span>
                              )}
                              {matchedPatient ? (
                                <span className="text-xs text-green-600 bg-green-100 px-2 py-0.5 rounded">Matched in dashboard</span>
                              ) : (
                                <span className="text-xs text-yellow-600 bg-yellow-100 px-2 py-0.5 rounded">Not found — will be skipped</span>
                              )}
                            </div>
                            <span className="text-xs text-gray-500">{group.claims.length} date group{group.claims.length !== 1 ? 's' : ''}</span>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs border-collapse">
                              <thead>
                                <tr className="bg-white/60">
                                  <th className="px-3 py-1.5 text-left font-semibold text-gray-600 border-b border-inherit">Date</th>
                                  <th className="px-3 py-1.5 text-left font-semibold text-gray-600 border-b border-inherit">CPT Codes</th>
                                  <th className="px-3 py-1.5 text-right font-semibold text-gray-600 border-b border-inherit">Charge</th>
                                  <th className="px-3 py-1.5 text-right font-semibold text-gray-600 border-b border-inherit">Reimb.</th>
                                  <th className="px-3 py-1.5 text-right font-semibold text-gray-600 border-b border-inherit">Copay</th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.claims.map((claim: any, cIdx: number) => {
                                  const lines: any[] = claim.cptLines?.length > 0 ? claim.cptLines : [{ cptCodes: claim.cptCodes, chargeAmount: claim.chargeAmount, insuranceReimbursement: claim.insuranceReimbursement, patientAmountPaid: claim.patientAmountPaid }];
                                  return lines.map((line: any, lIdx: number) => (
                                    <tr key={`${cIdx}-${lIdx}`} className="border-b border-gray-100 hover:bg-white/50">
                                      <td className="px-3 py-1 whitespace-nowrap text-gray-700">
                                        {lIdx === 0 ? (
                                          claim.dateOfService
                                            ? new Date(claim.dateOfService).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
                                            : '—'
                                        ) : null}
                                      </td>
                                      <td className="px-3 py-1 font-mono text-gray-800">{line.cptCodes || '—'}</td>
                                      <td className="px-3 py-1 text-right text-gray-700">{line.chargeAmount != null && line.chargeAmount !== '' ? `$${parseFloat(line.chargeAmount).toFixed(2)}` : '—'}</td>
                                      <td className="px-3 py-1 text-right text-gray-700">{line.insuranceReimbursement != null && line.insuranceReimbursement !== '' ? `$${parseFloat(line.insuranceReimbursement).toFixed(2)}` : '—'}</td>
                                      <td className="px-3 py-1 text-right text-gray-700">{line.patientAmountPaid != null && line.patientAmountPaid !== '' ? `$${parseFloat(line.patientAmountPaid).toFixed(2)}` : '—'}</td>
                                    </tr>
                                  ));
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex gap-3 justify-end pt-2 border-t">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowClaimUploadDialog(false);
                        setEobPatientGroups(null);
                        setBulkImportResults(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      disabled={isBulkImporting || bulkImportFromEOB.isPending}
                      onClick={async () => {
                        setIsBulkImporting(true);
                        try {
                          await bulkImportFromEOB.mutateAsync({ patientGroups: eobPatientGroups, uploadType: claimUploadType });
                        } finally {
                          setIsBulkImporting(false);
                        }
                      }}
                      className="bg-brand-blue hover:bg-brand-blue-dark text-white"
                    >
                      {isBulkImporting || bulkImportFromEOB.isPending
                        ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Importing…</>
                        : <><CheckCircle2 className="w-4 h-4 mr-2" />Import All Matched Patients</>}
                    </Button>
                  </div>
                </>
              )}
            </div>

          ) : editingExtractedClaims.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-400">
              <AlertCircle className="w-10 h-10" />
              <p className="text-sm">No claims extracted yet. Upload a PDF or CSV file to begin.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-600">
                  <span className="font-semibold text-green-700">{editingExtractedClaims.length}</span> claim{editingExtractedClaims.length !== 1 ? 's' : ''} extracted
                  {editingExtractedClaims.reduce((n: number, g: any) => n + (g.cptLines?.length || 1), 0) !== editingExtractedClaims.length && (
                    <span className="text-gray-400 ml-1">({editingExtractedClaims.reduce((n: number, g: any) => n + (g.cptLines?.length || 1), 0)} CPT lines)</span>
                  )}. Review before saving.
                </p>
              </div>

              {/* Grouped preview table */}
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-brand-cream border-b border-brand-cream-dark">
                      <th className="px-3 py-2 text-left font-semibold text-brand-blue uppercase text-[10px] tracking-wider whitespace-nowrap border-r border-brand-cream-dark">Date of Service</th>
                      <th className="px-3 py-2 text-left font-semibold text-brand-blue uppercase text-[10px] tracking-wider whitespace-nowrap border-r border-brand-cream-dark">CPT Code</th>
                      <th className="px-3 py-2 text-right font-semibold text-brand-blue uppercase text-[10px] tracking-wider whitespace-nowrap border-r border-brand-cream-dark">Charge</th>
                      <th className="px-3 py-2 text-right font-semibold text-brand-blue uppercase text-[10px] tracking-wider whitespace-nowrap border-r border-brand-cream-dark">Ins. Reimb.</th>
                      <th className="px-3 py-2 text-right font-semibold text-brand-blue uppercase text-[10px] tracking-wider whitespace-nowrap border-r border-brand-cream-dark">Pt. Paid</th>
                      <th className="px-3 py-2 text-left font-semibold text-brand-blue uppercase text-[10px] tracking-wider whitespace-nowrap border-r border-brand-cream-dark">Status</th>
                      <th className="px-3 py-2 text-left font-semibold text-brand-blue uppercase text-[10px] tracking-wider whitespace-nowrap border-r border-brand-cream-dark">Payment Date</th>
                      <th className="px-3 py-2 text-left font-semibold text-brand-blue uppercase text-[10px] tracking-wider whitespace-nowrap">Ins. Billed / Claim #</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editingExtractedClaims.map((group: any, gIdx: number) => {
                      const lines: any[] = group.cptLines?.length > 0 ? group.cptLines : [{ _key: group._key, cptCodes: group.cptCodes, chargeAmount: group.chargeAmount, insuranceReimbursement: group.insuranceReimbursement, patientAmountPaid: group.patientAmountPaid }];
                      return lines.map((line: any, lIdx: number) => (
                        <tr key={`${gIdx}-${lIdx}`} className={`border-b ${lIdx === lines.length - 1 ? 'border-gray-300' : 'border-gray-100'} hover:bg-brand-cream/50`}>
                          {/* Date — show only on first CPT line of each group */}
                          <td className="px-3 py-1.5 border-r border-gray-200 whitespace-nowrap font-medium text-gray-800">
                            {lIdx === 0 ? (
                              group.dateOfService
                                ? new Date(group.dateOfService).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
                                : <span className="text-gray-300">—</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-1.5 border-r border-gray-200 font-mono text-blue-700">
                            <span className="inline-flex items-center gap-1">
                              {line.cptCodes || <span className="text-gray-300">—</span>}
                              {line.notes ? (
                                <span title={line.notes}>
                                  <AlertTriangle
                                    className={`w-3 h-3 flex-shrink-0 ${line.notes.includes('⚠️') ? 'text-amber-500' : 'text-gray-400'}`}
                                  />
                                </span>
                              ) : null}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 border-r border-gray-200 text-right">{line.chargeAmount != null && line.chargeAmount !== '' ? `$${parseFloat(line.chargeAmount).toFixed(2)}` : <span className="text-gray-300">—</span>}</td>
                          <td className="px-3 py-1.5 border-r border-gray-200 text-right">{line.insuranceReimbursement != null && line.insuranceReimbursement !== '' ? `$${parseFloat(line.insuranceReimbursement).toFixed(2)}` : <span className="text-gray-300">—</span>}</td>
                          <td className="px-3 py-1.5 border-r border-gray-200 text-right">{line.patientAmountPaid != null && line.patientAmountPaid !== '' ? `$${parseFloat(line.patientAmountPaid).toFixed(2)}` : <span className="text-gray-300">—</span>}</td>
                          {/* Status — show only on first line */}
                          <td className="px-3 py-1.5 border-r border-gray-200">
                            {lIdx === 0 && (
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                group.claimStatus === 'approved' ? 'bg-green-100 text-green-800' :
                                group.claimStatus === 'denied' ? 'bg-red-100 text-red-800' :
                                'bg-blue-100 text-blue-800'
                              }`}>{group.claimStatus || 'submitted'}</span>
                            )}
                          </td>
                          {/* Payment Date — show only on first line */}
                          <td className="px-3 py-1.5 border-r border-gray-200 text-gray-700 whitespace-nowrap">
                            {lIdx === 0 && (
                              group.checkDate
                                ? new Date(group.checkDate).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
                                : <span className="text-gray-300">—</span>
                            )}
                          </td>
                          {/* Ins. Billed / Claim # — show only on first line */}
                          <td className="px-3 py-1.5 text-gray-600">
                            {lIdx === 0 && (
                              <span>{group.insuranceBilled || group.oaClaimNumber || <span className="text-gray-300">—</span>}</span>
                            )}
                          </td>
                        </tr>
                      ));
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex gap-3 justify-end pt-2 border-t">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowClaimUploadDialog(false);
                    setExtractedClaims([]);
                    setEditingExtractedClaims([]);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={isSavingExtractedClaims || editingExtractedClaims.length === 0}
                  onClick={handleSaveExtractedClaims}
                  className="bg-brand-blue hover:bg-brand-blue-dark text-white"
                >
                  {isSavingExtractedClaims
                    ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Saving…</>
                    : <><CheckCircle2 className="w-4 h-4 mr-2" />Save {editingExtractedClaims.length} Claim{editingExtractedClaims.length !== 1 ? 's' : ''}</>
                  }
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      </div>
    );
  }

  // ── Main Dashboard View ────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-brand-cream/30">
      {/* Header */}
      <div className="relative overflow-hidden">
        <div
          className="absolute inset-0 bg-cover bg-center opacity-15"
          style={{ backgroundImage: 'url(https://d2xsxph8kpxj0f.cloudfront.net/310519663716642646/GCFkA8sgJY8LWBm3u5Mirt/healthcare-header-7MYjnBJpyfHpSEz86Wupgd.webp)' }}
        />
        <div className="absolute inset-0 bg-gradient-to-r from-brand-blue to-brand-blue/90" />
        <div className="relative py-4 px-4 sm:px-6 lg:px-8">
          <div className="container flex flex-wrap items-center justify-between gap-3 w-full">
            <div className="flex items-center gap-3">
              <img
                src={LOGO_URL}
                alt="NYC Home Rehab Logo"
                className="w-11 h-11 object-contain drop-shadow-md hidden sm:block"
              />
              <div>
                <h1 className="text-white text-lg sm:text-xl font-serif font-bold leading-tight">NYC HOME REHAB AUTHORIZATION AND CLAIMS TRACKER</h1>
              </div>
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              {/* Sign Out */}
              <Button
                variant="outline"
                size="sm"
                className="bg-transparent border-white/50 text-white hover:bg-white/10 hover:text-white font-semibold"
                onClick={() => {
                  logoutMutation.mutate(undefined, {
                    onSuccess: () => { window.location.href = '/login'; },
                    onError: () => { window.location.href = '/login'; },
                  });
                }}
                disabled={logoutMutation.isPending}
              >
                {logoutMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <LogOut className="w-4 h-4" />
                )}
                <span className="hidden sm:inline">Sign Out</span>
              </Button>
              {/* Bulk Upload */}
              <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
                <DialogTrigger asChild>
                  <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white font-semibold">
                    <Upload className="w-4 h-4" />
                    Bulk Upload
                  </Button>
                </DialogTrigger>
                <DialogContent className="bg-white max-w-md">
                  <DialogHeader>
                    <DialogTitle className="text-brand-blue">Bulk Upload Patient Data</DialogTitle>
                    <DialogDescription>Upload a CSV file. Required columns: Patient Name, Insurance, Authorized Sessions</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="border-2 border-dashed border-brand-cream-dark rounded-lg p-6 text-center hover:border-brand-gold transition-colors">
                      <input type="file" accept=".csv" onChange={handleBulkUpload} className="hidden" id="file-upload" />
                      <label htmlFor="file-upload" className="cursor-pointer block">
                        <Upload className="w-8 h-8 text-brand-gold mx-auto mb-2" />
                        <p className="text-brand-blue font-semibold">Click to upload CSV</p>
                      </label>
                    </div>
                    {uploadProgress > 0 && uploadProgress < 100 && (
                      <div className="w-full bg-brand-cream-dark rounded-full h-2">
                        <div className="bg-brand-gold h-2 rounded-full transition-all" style={{ width: `${uploadProgress}%` }} />
                      </div>
                    )}
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
                      <div className="flex items-center justify-between mb-2">
                        <p className="font-semibold">CSV Format:</p>
                        <Button
                          size="sm"
                          onClick={handleDownloadTemplate}
                          className="h-auto gap-1.5 bg-brand-blue hover:bg-brand-blue-dark text-white text-xs font-semibold px-3 py-1.5"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download Template
                        </Button>
                      </div>
                      <p className="font-mono">Patient Name, Insurance, Authorized Sessions, …</p>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>

              {/* Add Patient */}
              <Dialog open={showAddPatient} onOpenChange={setShowAddPatient}>
                <DialogTrigger asChild>
                  <Button size="sm" className="bg-brand-gold hover:bg-brand-gold-dark text-brand-blue font-semibold">
                    <Plus className="w-4 h-4" />
                    Add Patient
                  </Button>
                </DialogTrigger>
                <DialogContent className="bg-white">
                  <DialogHeader>
                    <DialogTitle className="text-brand-blue">Add New Patient</DialogTitle>
                    <DialogDescription>Enter patient details to add them to the clinic dashboard</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="patient-name" className="text-brand-blue font-semibold">Patient Name</Label>
                      <Input id="patient-name" placeholder="Enter patient name" value={newPatientName} onChange={e => setNewPatientName(e.target.value)} className="border-brand-cream-dark" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="insurance" className="text-brand-blue font-semibold">Insurance Company</Label>
                      <Select value={newPatientInsurance} onValueChange={setNewPatientInsurance}>
                        <SelectTrigger id="insurance" className="border-brand-cream-dark w-full">
                          <SelectValue placeholder="Select insurance company" />
                        </SelectTrigger>
                        <SelectContent>
                          {insuranceList.map(ins => <SelectItem key={ins} value={ins}>{ins}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="authorized-sessions" className="text-brand-blue font-semibold">Authorized Sessions (optional)</Label>
                      <Input id="authorized-sessions" placeholder="e.g. 12" type="number" value={newPatientAuthorized} onChange={e => setNewPatientAuthorized(e.target.value)} className="border-brand-cream-dark" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="auth-date" className="text-brand-blue font-semibold">Authorization Date (optional)</Label>
                      <Input id="auth-date" type="date" value={newPatientAuthDate} onChange={e => setNewPatientAuthDate(e.target.value)} className="border-brand-cream-dark" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="auth-valid-until" className="text-brand-blue font-semibold">Authorization Valid Until (optional)</Label>
                      <p className="text-xs text-gray-500">Staff will be alerted 1 week before this date to request a new authorization.</p>
                      <Input id="auth-valid-until" type="date" value={newPatientAuthValidUntil} onChange={e => setNewPatientAuthValidUntil(e.target.value)} className="border-brand-cream-dark" />
                    </div>
                    <Button onClick={handleAddPatient} disabled={createPatient.isPending || bulkCreateVisits.isPending} className="w-full bg-brand-blue hover:bg-brand-blue-dark text-white font-semibold">
                      {(createPatient.isPending || bulkCreateVisits.isPending) ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                      Add Patient
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-[1600px] mx-auto px-6 lg:px-8 py-6">

        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
          {[
            { icon: <Users className="w-4 h-4 text-brand-blue" />, label: 'Total Patients', value: clinicMetrics.totalPatients, sub: 'Active patients', tone: 'navy' as const },
            { icon: <CheckCircle2 className="w-4 h-4 text-brand-gold-dark" />, label: 'Authorized Sessions', value: clinicMetrics.totalAuthorized, sub: 'Total authorized', tone: 'gold' as const },
            { icon: <Clock className="w-4 h-4 text-brand-blue" />, label: 'Sessions Remaining', value: clinicMetrics.totalRemaining, sub: 'Active patient', tone: 'navy' as const },
            { icon: <AlertCircle className="w-4 h-4 text-destructive" />, label: 'Utilization Rate', value: `${clinicMetrics.utilizationRate}%`, sub: 'Sessions completed', tone: 'destructive' as const },
          ].map(({ icon, label, value, sub, tone }) => (
            <MetricCard key={label} icon={icon} label={label} value={value} sub={sub} tone={tone} />
          ))}
        </div>

        {/* ─── Authorization Alert Panel ─────────────────────────────────────── */}
        <AuthAlertPanel onSelectPatient={(id) => { setSelectedPatientId(id); setShowDetailView(true); }} />

        {/* ─── Claims Follow-Up Alert Panel ─────────────────────────────────── */}
        <ClaimsFollowUpPanel
          insurance={selectedInsurance}
          onSelectPatient={(id) => { setSelectedPatientId(id); setShowDetailView(true); }}
        />

        {/* ─── Active filter chips ───────────────────────────────────────────── */}
        <FilterChips
          chips={[
            ...(selectedInsurance
              ? [{ key: 'insurance', label: `Filtered by: ${selectedInsurance}`, onRemove: () => setSelectedInsurance('') }]
              : []),
            ...(selectedClaimsFilter && selectedClaimsFilter !== 'all'
              ? [{
                  key: 'claims-status',
                  label: `Status: ${CLAIM_STATUS_FILTERS.find(f => f.value === selectedClaimsFilter)?.label ?? selectedClaimsFilter}`,
                  onRemove: () => setSelectedClaimsFilter('all'),
                }]
              : []),
          ]}
          onClearAll={handleClearFilters}
        />

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-6 gap-6">
          {/* Insurance Filter Sidebar — desktop only; mobile uses the compact Filters sheet below */}
          <div className="hidden lg:block lg:col-span-1">
            <div className="bg-white rounded-xl shadow-sm p-4 max-h-[600px] overflow-y-auto">
              <h3 className="text-lg font-serif font-bold text-brand-blue mb-4 pb-3 border-b border-brand-cream-dark">Insurance</h3>
              <div className="space-y-1">
                {renderInsuranceFilterButtons()}
              </div>
            </div>
          </div>

          {/* Claims Status Filter — desktop only; mobile uses the compact Filters sheet below */}
          <div className="hidden lg:block lg:col-span-1">
            <div className="bg-white rounded-xl shadow-sm p-4 max-h-[600px] overflow-y-auto">
              <h3 className="text-lg font-serif font-bold text-brand-blue mb-4 pb-3 border-b border-brand-cream-dark">Claims Status</h3>
              <div className="space-y-1">
                {renderClaimsStatusFilterButtons()}
              </div>
            </div>
          </div>

          {/* Patient List */}
          <div className="lg:col-span-1 space-y-4">
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h3 className="text-lg font-serif font-bold text-brand-blue mb-1">Patients</h3>
              <p className="text-xs text-muted-foreground mb-4">{filteredPatients.length} in {selectedInsurance || 'all insurances'}</p>

              {/* Search + mobile filters control */}
              <div className="mb-4 space-y-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" aria-hidden="true" />
                  <Input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search patients..."
                    aria-label="Search patients by name"
                    className="pl-9 pr-9"
                  />
                  {searchQuery !== '' && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label="Clear search"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <div className="lg:hidden">
                  <Sheet open={showMobileFilters} onOpenChange={setShowMobileFilters}>
                    <SheetTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1.5">
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                        Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                      </Button>
                    </SheetTrigger>
                    <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
                      <SheetHeader>
                        <SheetTitle>Filters</SheetTitle>
                      </SheetHeader>
                      <div className="px-4 pb-4 space-y-6">
                        <div>
                          <h4 className="text-sm font-semibold text-brand-blue mb-2">Insurance</h4>
                          <div className="space-y-1">{renderInsuranceFilterButtons()}</div>
                        </div>
                        <div>
                          <h4 className="text-sm font-semibold text-brand-blue mb-2">Claims Status</h4>
                          <div className="space-y-1">{renderClaimsStatusFilterButtons()}</div>
                        </div>
                      </div>
                      <SheetFooter>
                        <Button variant="outline" onClick={handleClearFilters} disabled={activeFilterCount === 0}>
                          Clear Filters
                        </Button>
                      </SheetFooter>
                    </SheetContent>
                  </Sheet>
                </div>
              </div>

              <div className="space-y-1 max-h-96 overflow-y-auto">
                {filteredPatients.length > 0 ? filteredPatients.map(patient => (
                    <PatientListItem
                      key={patient.id}
                      name={patient.name}
                      insurance={patient.insurance}
                      isActive={activePatient?.id === patient.id}
                      claimsStatus={patient.claimsStatus}
                      onSelect={() => { setSelectedPatientId(patient.id); setShowDetailView(false); }}
                      onDelete={() => { setDeletePatientId(patient.id); setDeletePatientName(patient.name); }}
                    />
                  )) : (
                    <div className="p-4 text-center text-muted-foreground text-sm">
                      {searchQuery.trim() ? 'No patients match your search.' : 'No patients for this insurance'}
                    </div>
                  )}
              </div>
            </div>

            {/* ─── Completed Sessions Folder ─────────────────────────────────── */}
            {completedPatients.length > 0 && (
              <Card className="border-green-200 shadow-md">
                <CardHeader className="bg-green-700 text-white rounded-t-lg py-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" />
                    Completed Sessions
                    <Badge className="bg-white text-green-700 text-xs ml-auto">{completedPatients.length}</Badge>
                  </CardTitle>
                  <CardDescription className="text-green-100 text-xs">All sessions fully completed</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="space-y-1 max-h-60 overflow-y-auto">
                    {completedPatients.map(patient => (
                      <PatientListItem
                        key={patient.id}
                        name={patient.name}
                        insurance={patient.insurance}
                        isActive={activePatient?.id === patient.id}
                        tone="success"
                        trailing={<CheckCircle2 className="w-4 h-4 text-green-500" />}
                        onSelect={() => { setSelectedPatientId(patient.id); setShowDetailView(false); }}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Discharged Patients Folder — inside the patients column */}
            {dischargedPatients.length > 0 && (
            <Card className="border-gray-300 shadow-md">
              <CardHeader className="bg-gray-600 text-white rounded-t-lg py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <UserX className="w-4 h-4" />
                  Discharged Patients
                  <Badge className="bg-white text-gray-700 text-xs ml-auto">{dischargedPatients.length}</Badge>
                </CardTitle>
                <CardDescription className="text-gray-200 text-xs">Click a patient to view their records &amp; discharge details</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {dischargedPatients.map(patient => (
                    <PatientListItem
                      key={patient.id}
                      name={patient.name}
                      insurance={patient.insurance}
                      isActive={activePatient?.id === patient.id}
                      tone="muted"
                      trailing={<UserX className="w-4 h-4 text-gray-400" />}
                      onSelect={() => { setSelectedPatientId(patient.id); setShowDetailView(true); }}
                      meta={
                        <>
                          {patient.dischargeDate && (
                            <p className="text-xs text-gray-400 mt-0.5">
                              Discharged: {new Date(patient.dischargeDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </p>
                          )}
                          {patient.dischargeReason && (
                            <p className="text-xs text-gray-400 truncate">Reason: {patient.dischargeReason}</p>
                          )}
                        </>
                      }
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
            )}
          </div>

          {/* Right Content */}
          <div className="lg:col-span-3 space-y-6">
            {activePatient && (
              <>
                <Card className="border-brand-cream-dark shadow-sm rounded-xl">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <button onClick={() => setShowDetailView(true)} className="group">
                          <CardTitle className="text-2xl font-serif font-bold text-brand-blue group-hover:text-brand-gold transition-colors cursor-pointer">
                            {activePatient.name}
                          </CardTitle>
                        </button>
                        <CardDescription className="mt-2 flex items-center gap-3 flex-wrap">
                          <span>Insurance: {activePatient.insurance}</span>
                          <span className="flex items-center gap-2">
                            <span className={activePatient.isActive !== false ? 'text-green-700 font-semibold' : 'text-gray-500 font-semibold'}>
                              {activePatient.isActive !== false ? 'Active' : 'Discharged'}
                            </span>
                            <Switch
                              checked={activePatient.isActive !== false}
                              onCheckedChange={(checked) => handleToggleActive(activePatient.id, checked)}
                              disabled={setPatientActive.isPending}
                              aria-label="Toggle patient active status"
                            />
                          </span>
                        </CardDescription>
                      </div>
                      {alertStatus && (
                        <Badge className={`text-sm px-3 py-1 rounded-full font-medium ${alertStatus.color}`}>{alertStatus.label}</Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-2">
                      <div className="p-4 bg-brand-cream/40 rounded-lg text-center">
                        <p className="text-xs text-gray-600 uppercase tracking-wide mb-1">Authorized Sessions</p>
                        <p className="text-3xl font-bold text-brand-gold">{activeMetrics.totalAuthorized}</p>
                      </div>
                      <div className="p-4 bg-brand-cream/40 rounded-lg text-center">
                        <p className="text-xs text-gray-600 uppercase tracking-wide mb-1">Completed</p>
                        <p className="text-3xl font-bold text-green-600">{activeMetrics.completed}</p>
                      </div>
                      <div className="p-4 bg-brand-cream/40 rounded-lg text-center">
                        <p className="text-xs text-gray-600 uppercase tracking-wide mb-1">Remaining</p>
                        <p className="text-3xl font-bold text-brand-blue">{activeMetrics.remaining}</p>
                      </div>
                    </div>
                  </CardContent>
                  <CardFooter className="border-t pt-6">
                    <Button
                      onClick={() => setShowDetailView(true)}
                      className="w-full bg-brand-blue hover:bg-brand-blue-dark text-white font-semibold"
                    >
                      View Full Records &amp; Edit Date ASH Submitted
                    </Button>
                  </CardFooter>
                </Card>

                {/* Progress Chart */}
                {patientProgressData.length > 0 && (
                  <Card className="border-brand-cream-dark shadow-sm rounded-xl">
                    <CardHeader>
                      <CardTitle className="text-lg font-serif font-bold text-brand-blue">Session Progress</CardTitle>
                      <CardDescription className="text-sm text-gray-600 mt-1">Sessions remaining over time</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={patientProgressData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#F0E9DC" />
                            <XAxis dataKey="session" stroke="#6B7280" />
                            <YAxis stroke="#6B7280" />
                            <Tooltip contentStyle={{ backgroundColor: '#FAF5EE', border: '1px solid #F0E9DC', borderRadius: '8px' }} />
                            <Line type="monotone" dataKey="remaining" stroke="#1E3A5F" strokeWidth={2} dot={{ fill: '#E8A93C', r: 4 }} activeDot={{ r: 6 }} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            )}

            {/* Clinic Overview */}
            <Card className="border-brand-cream-dark shadow-sm rounded-xl">
              <CardHeader>
                <CardTitle className="text-lg font-serif font-bold text-brand-blue">Clinic Overview</CardTitle>
                <CardDescription className="text-sm text-gray-600 mt-1">Sessions for active patient</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-center gap-6">
                  <div className="max-w-[240px] w-full mx-auto">
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie data={clinicStatusData} cx="50%" cy="50%" labelLine={false} label={({ name, value }) => `${name}: ${value}`} outerRadius={70} dataKey="value">
                          {clinicStatusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Pie>
                        <Tooltip contentStyle={{ backgroundColor: '#FAF5EE', border: '1px solid #F0E9DC', borderRadius: '8px' }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* ── Discharge Patient Dialog ─────────────────────────────── */}
      <Dialog open={showDischargeDialog} onOpenChange={(open) => { if (!open) { setShowDischargeDialog(false); setPendingDischargePatientId(null); } }}>
        <DialogContent className="bg-white max-w-md">
          <DialogHeader>
            <DialogTitle className="text-brand-blue text-xl flex items-center gap-2">
              <UserX className="w-5 h-5 text-gray-500" />
              Discharge Patient
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Please fill in the discharge details. The patient will be moved to the Discharged Patients folder.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="discharge-date" className="text-brand-blue font-semibold">Date of Discharge</Label>
              <Input
                id="discharge-date"
                type="date"
                value={dischargeDate}
                onChange={e => setDischargeDate(e.target.value)}
                className="mt-1 border-brand-cream-dark focus:border-brand-blue"
              />
            </div>
            <div>
              <Label htmlFor="discharge-reason" className="text-brand-blue font-semibold">Reason of Discharge</Label>
              <Input
                id="discharge-reason"
                placeholder="e.g. Goals met, Moved, Insurance ended…"
                value={dischargeReason}
                onChange={e => setDischargeReason(e.target.value)}
                className="mt-1 border-brand-cream-dark focus:border-brand-blue"
              />
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => { setShowDischargeDialog(false); setPendingDischargePatientId(null); }}
            >
              Cancel
            </Button>
            <Button
              className="flex-1 bg-gray-600 hover:bg-gray-700 text-white font-semibold"
              onClick={handleDischargeSubmit}
              disabled={setPatientActive.isPending}
            >
              {setPatientActive.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <UserX className="w-4 h-4 mr-2" />}
              Confirm Discharge
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete Patient Confirmation Dialog ─────────────────────────────── */}
      <AlertDialog open={deletePatientId !== null} onOpenChange={(open) => { if (!open) { setDeletePatientId(null); setDeletePatientName(''); } }}>
        <AlertDialogContent className="bg-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-brand-blue text-xl">Delete Patient?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              You are about to permanently delete <strong>{deletePatientName}</strong> and all of their visit records.
              This action <strong>cannot be undone</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-brand-cream-dark text-brand-blue hover:bg-brand-cream">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deletePatientId !== null) {
                  deletePatient.mutate({ id: deletePatientId });
                }
              }}
              disabled={deletePatient.isPending}
              className="bg-red-600 hover:bg-red-700 text-white font-semibold"
            >
              {deletePatient.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
              Yes, Delete Patient
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
