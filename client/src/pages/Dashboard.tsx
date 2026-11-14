import { useState, useMemo, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertCircle, CheckCircle2, Users, Plus, ChevronLeft, Calendar, Upload, Download, Loader2, RefreshCw, Trash2, UserX, UserCheck, Columns3, AlertTriangle, Pencil, FileText, MoreVertical, Settings, History, EyeOff, FileStack } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { insurerMatchValues } from '@shared/insuranceCatalog';
import { historicalInsurerNames, isStaleInsurerSelection, matchesPatientFilters } from '@/lib/patientFilters';
import { routeToNavSection, navSectionToRoute } from '@/lib/navSection';
import { canAccessClaims as canAccessClaimsAuthGate, canManageStaff as canManageStaffAuthGate } from '@/lib/authGate';
import { purgeIdentityScopedQueries } from '@/lib/claimsCache';
import { useQueryClient } from '@tanstack/react-query';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { FilterChips } from '@/components/dashboard/FilterChips';
import { AuthAlertPanel } from '@/components/dashboard/AuthAlertPanel';
import { AuthorizationOverview } from '@/components/dashboard/AuthorizationOverview';
import { AuthorizationRecordsWorkspace } from '@/components/dashboard/AuthorizationRecordsWorkspace';
import { ClaimsFollowUpPanel } from '@/components/dashboard/ClaimsFollowUpPanel';
import { RecordHistoryDialog } from '@/components/dashboard/RecordHistoryDialog';
import { AssignmentOfBenefitsSelect, SubmissionStatusSelect, RemarksCell } from '@/components/dashboard/SessionWorkflowCells';
import { ClaimsAccessDenied } from '@/components/dashboard/ClaimsAccessDenied';
import { PatientOverview } from '@/components/dashboard/PatientOverview';
import { PatientRecordsWorkspace } from '@/components/dashboard/PatientRecordsWorkspace';
import { DischargedPatientsWorkspace } from '@/components/dashboard/DischargedPatientsWorkspace';
import { DashboardShell } from '@/components/dashboard/DashboardShell';
import type { NavSection } from '@/components/dashboard/DashboardSidebar';
import { getPatientMetrics } from '@/lib/patientMetrics';
import { getPatientOverviewMetrics } from '@/lib/patientOverviewMetrics';
import { derivePatientAlertPresentation } from '@/lib/patientAuthUrgency';
import { ApproveAuthorizationDialog, AuthorizationActionButtons, PeriodExpiryControl, useMarkAuthorizationRequested, type ApproveTarget } from '@/components/dashboard/AuthorizationActions';
import { getPeriodMetrics } from '@shared/authPeriodMetrics';
import { deriveDashboardKpis } from '@/lib/dashboardOverview';
import { createSingleFlightGuard } from '@/lib/concurrencyGuards';
import { ClaimImportDialog } from '@/components/claims/ClaimImportDialog';
import { ClaimBulkUploadPanel } from '@/components/claims/ClaimBulkUploadPanel';
import { PatientBulkUploadDialog } from '@/components/dashboard/PatientBulkUploadDialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { sumKnownMoney } from '@shared/claimImport';
import { formatCalendarDate } from '@/lib/date';
import type { AuthUrgency } from '@shared/authUrgency';

/**
 * Dashboard Component — Database-backed
 * All data persists in MySQL via tRPC procedures.
 * "Date Authorization Submitted" column is editable inline with a native date picker.
 */

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
  /** Claim data — only present in responses for Claims-access roles (P4-P25). */
  claimsStatus?: string;
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
  /** P4-P31: period-level expiry mark (null = not expired). */
  periodExpiredAt: Date | string | null;
  assignmentOfBenefits: 'yes' | 'no' | null;
  submissionStatus: 'ready_to_file' | 'hold' | 'do_not_file' | null;
  remarks: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CLAIM_STATUS_FILTERS = [
  { value: 'all', label: 'All Claims', color: 'bg-gray-100 text-gray-800' },
  { value: 'submitted', label: 'Submitted', color: 'bg-blue-100 text-blue-800' },
  { value: 'approved', label: 'Approved', color: 'bg-green-100 text-green-800' },
  { value: 'pending', label: 'Pending', color: 'bg-yellow-100 text-yellow-800' },
  { value: 'denied', label: 'Denied', color: 'bg-red-100 text-red-800' },
  { value: 'pended', label: 'Pended', color: 'bg-orange-100 text-orange-800' },
  { value: 'rejected', label: 'Rejected', color: 'bg-gray-900 text-white' },
  { value: 'resubmitted', label: 'Resubmitted', color: 'bg-violet-100 text-violet-800' },
  { value: 'needs_review', label: 'Needs Review', color: 'bg-amber-100 text-amber-800' },
  { value: 'none', label: 'No Status', color: 'bg-gray-50 text-gray-500' },
];

/** Format a Date or date-string for display */
const formatDate = (d: Date | string | null | undefined): string => {
  if (!d) return '—';
  try {
    return formatCalendarDate(d);
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

/** Convert epoch ms (how authValidUntil is stored) to "YYYY-MM-DD" for <input type="date"> value */
const msToInputDate = (ms: number | null | undefined): string => {
  if (ms == null) return '';
  try {
    const dt = new Date(ms);
    if (isNaN(dt.getTime())) return '';
    return dt.toISOString().split('T')[0];
  } catch {
    return '';
  }
};

/** Full-width auth-urgency banner styling per shared urgency state, kept
 *  distinct from the small snapshot badge's colors (which come straight from
 *  patientAuthUrgency.ts). Not shown for 'ok' — nothing to alert about,
 *  same convention AuthAlertPanel uses to decide which patients are "urgent". */
const AUTH_BANNER_STYLE: Record<Exclude<AuthUrgency, 'ok'>, { border: string; bg: string; icon: string; heading: string; body: string }> = {
  denied: { border: 'border-red-600', bg: 'bg-red-50', icon: 'text-red-700', heading: 'text-red-800', body: 'text-red-700' },
  expired: { border: 'border-slate-500', bg: 'bg-slate-50', icon: 'text-slate-600', heading: 'text-slate-800', body: 'text-slate-700' },
  exhausted: { border: 'border-red-400', bg: 'bg-red-50', icon: 'text-red-600', heading: 'text-red-800', body: 'text-red-700' },
  critical: { border: 'border-orange-400', bg: 'bg-orange-50', icon: 'text-orange-600', heading: 'text-orange-800', body: 'text-orange-700' },
  warning: { border: 'border-yellow-400', bg: 'bg-yellow-50', icon: 'text-yellow-600', heading: 'text-yellow-800', body: 'text-yellow-700' },
  pending: { border: 'border-blue-400', bg: 'bg-blue-50', icon: 'text-blue-600', heading: 'text-blue-800', body: 'text-blue-700' },
};

/** Body copy for the active-patient auth banner. Presentational text only —
 *  the urgency itself is already decided by deriveAuthorizationUrgency; this
 *  just picks the sentence for a state that was already determined. */
function authBannerMessage(
  urgency: Exclude<AuthUrgency, 'ok'>,
  remaining: number,
  insurance: string,
  authExpiryWarning: boolean,
  unusedExpired = 0,
): string {
  if (authExpiryWarning) return `Authorization is expiring soon. Contact ${insurance} to renew.`;
  switch (urgency) {
    case 'denied': return `Authorization was denied. ${remaining} session(s) remaining.`;
    case 'expired': return unusedExpired > 0
      ? `This authorization expired with ${unusedExpired} unused session(s). They are no longer available. Request a new authorization from ${insurance}.`
      : `This authorization expired. Request a new authorization from ${insurance}.`;
    case 'exhausted': return `${remaining} session(s) remaining. Authorization request is urgent.`;
    case 'critical': return `Only ${remaining} session(s) remaining. Request new authorization from ${insurance} immediately.`;
    case 'warning': return `Only ${remaining} session(s) remaining. Request new authorization from ${insurance} soon.`;
    case 'pending': return `Authorization request is pending with ${insurance}. Follow up if not resolved soon.`;
  }
}

/** Compact colored dropdown for a visit's auth status. `onChange` receives the
 *  same '' | 'Pending' | 'Approved' | 'Denied' shape handleUpdateAuthStatus expects.
 *  P4-P31: Expired is NOT a row status — it is set per period from the period
 *  header (Mark Expired / Restore) and never changes this dropdown's value. */
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

/** Generic click-to-edit cell for a single date/number field on a visit row.
 *  Manages its own open/closed state so every correctable field (session #,
 *  date of service, # authorized, # remaining, date auth submitted) can share
 *  one implementation instead of a bespoke editingXId/editingXValue pair each.
 *  `onSave` returns `false` to keep the field open (e.g. failed validation or
 *  a rejected mutation) — anything else closes it back to display mode. */
function EditableCell({
  type,
  value,
  display,
  onSave,
  isSaving,
  min,
  step,
  emptyLabel = 'Click to set',
}: {
  type: 'date' | 'number';
  value: string;
  display: React.ReactNode;
  onSave: (value: string) => Promise<boolean | void> | boolean | void;
  isSaving: boolean;
  min?: number;
  step?: number;
  emptyLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (editing) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type={type}
          min={min}
          step={step}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          autoFocus
          className="border border-brand-gold rounded-md px-2 py-1.5 text-sm text-brand-blue focus:outline-none focus:ring-2 focus:ring-brand-gold/30 min-h-[36px] w-full sm:w-auto"
        />
        <Button
          size="sm"
          disabled={isSaving}
          onClick={async () => {
            const result = await onSave(draft);
            if (result !== false) setEditing(false);
          }}
          className="h-auto min-h-[32px] text-green-600 hover:text-green-800 font-bold text-xs px-2 py-1 bg-green-50 hover:bg-green-100"
        >
          {isSaving ? '…' : 'Save'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setEditing(false)}
          className="h-auto min-h-[32px] text-gray-500 hover:text-gray-700 font-bold text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200"
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <button
      onClick={() => { setDraft(value); setEditing(true); }}
      className="hover:underline cursor-pointer text-left"
    >
      {display ?? <span className="text-gray-300 italic font-normal">{emptyLabel}</span>}
    </button>
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

  // ── Route-derived nav state ────────────────────────────────────────────────
  // The URL is the single source of truth for which section is active — no
  // parallel activeNavSection state to drift out of sync with it.
  const [location, navigate] = useLocation();
  const activeSection: NavSection = useMemo(() => routeToNavSection(location), [location]);
  // Derived (not stateful): true only on the per-patient detail routes.
  const showDetailView = activeSection === 'visits' || activeSection === 'claims';

  // ── State ──────────────────────────────────────────────────────────────────
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [showAddPatient, setShowAddPatient] = useState(false);
  const [showAddInsurance, setShowAddInsurance] = useState(false);
  const [newInsuranceName, setNewInsuranceName] = useState('');
  const [showManageInsurance, setShowManageInsurance] = useState(false);
  const [insurerPendingDelete, setInsurerPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [insurerPendingPermanentDelete, setInsurerPendingPermanentDelete] = useState<{ id: string; name: string } | null>(null);
  const [permanentDeleteError, setPermanentDeleteError] = useState<string | null>(null);
  const [historyInsurerId, setHistoryInsurerId] = useState<string | null>(null);
  const [selectedInsurance, setSelectedInsurance] = useState<string>('Aetna');
  const [newPatientName, setNewPatientName] = useState('');
  // No hard-coded default insurer: a fixed name could have been permanently
  // deleted from the catalog (P4-P21). Staff pick from the active list.
  const [newPatientInsurance, setNewPatientInsurance] = useState('');
  const [newPatientAuthorized, setNewPatientAuthorized] = useState('');
  const [newPatientAuthDate, setNewPatientAuthDate] = useState('');
  const [newPatientAuthValidUntil, setNewPatientAuthValidUntil] = useState('');
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [showLogSessionDialog, setShowLogSessionDialog] = useState(false);
  const [sessionDate, setSessionDate] = useState(new Date().toISOString().split('T')[0]);
  /** Delete confirmation dialog */
  const [deletePatientId, setDeletePatientId] = useState<string | null>(null);
  const [deletePatientName, setDeletePatientName] = useState<string>('');
  /** Delete claim confirmation dialog */
  const [deleteClaimTarget, setDeleteClaimTarget] = useState<{
    id: string; patientId: string; dateOfService: string | null; cptCodes: string | null;
  } | null>(null);
  /** View History dialog for a single claim row (claims table "actions" menu) */
  const [historyClaimId, setHistoryClaimId] = useState<string | null>(null);
  // Patient selected within the Patient Records workspace's own snapshot
  // pane — deliberately separate from selectedPatientId (which still backs
  // the Dashboard KPI/Analytics fallback and the Visits/Claims detail
  // routes) so entering /patients/records never inherits a patients[0]
  // fallback from elsewhere and never leaks into /patients/discharged.
  const [selectedRecordsPatientId, setSelectedRecordsPatientId] = useState<string | null>(null);
  // Same idea for /patients/discharged — its own selection, never shared
  // with the active-patient list.
  const [selectedDischargedPatientId, setSelectedDischargedPatientId] = useState<string | null>(null);
  const [dischargedSearchQuery, setDischargedSearchQuery] = useState('');
  const [showDischargedFilters, setShowDischargedFilters] = useState(false);
  // Discharge confirmation dialog state
  const [showDischargeDialog, setShowDischargeDialog] = useState(false);
  const [pendingDischargePatientId, setPendingDischargePatientId] = useState<string | null>(null);
  const [dischargeDate, setDischargeDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [dischargeReason, setDischargeReason] = useState('');
  // Edit Patient dialog state
  const [isEditPatientOpen, setIsEditPatientOpen] = useState(false);
  const [editPatientName, setEditPatientName] = useState('');
  const [editPatientInsurance, setEditPatientInsurance] = useState('');
  const [editPatientAuthDate, setEditPatientAuthDate] = useState('');
  const [editPatientAuthValidUntil, setEditPatientAuthValidUntil] = useState('');
  const [editPatientClaimsStatus, setEditPatientClaimsStatus] = useState('');
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
  // P4-P24: the CMS1500 / EOB import dialog — opened by a patient period's
  // upload buttons (single-patient) or by the two bulk uploads.
  const [claimImport, setClaimImport] = useState<{
    kind: 'cms1500' | 'eob';
    mode: 'single' | 'bulk';
    patient: { id: string; name: string } | null;
    authPeriod: number | null;
    files: File[];
    /** P4-P26: 'csv' = Bulk Upload → CMS1500 / Insurance Reimbursement CSV templates. */
    source?: 'document' | 'csv';
  } | null>(null);
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
  // P4-P25: Claims are Owner/Super Admin + Clinic Admin only. Resolved before any claims query so
  // every claims.* query below can be gated on it (`enabled`). ProtectedRoute
  // only renders Dashboard once auth.me has resolved, and canAccessClaims
  // treats an unresolved user as no access, so no claims request is made and
  // no cached claims data is rendered while identity is still loading.
  const queryClient = useQueryClient();
  const { data: authUser } = trpc.auth.me.useQuery();
  const canManageStaff = canManageStaffAuthGate(authUser);
  const canAccessClaims = canAccessClaimsAuthGate(authUser);

  const { data: patients = [], isLoading: patientsLoading, refetch: refetchPatients } =
    trpc.patients.list.useQuery();

  // Single shared insurer catalog — patient forms, the Insurance filter
  // panel, and AuthAlertPanel's "New Authorization" dialog all read from
  // this same list so none of them can drift out of sync with another.
  const { data: insurerCatalog = [], isSuccess: insurerCatalogLoaded } = trpc.insurance.list.useQuery();
  // Filters/counts use the FULL catalog (active + inactive) — a deactivated
  // insurer's existing patients must stay filterable/countable (P4-P13).
  const insuranceList = useMemo(() => insurerCatalog.map(entry => entry.name), [insurerCatalog]);
  // Insurers patients still record that aren't in the catalog — notably a
  // permanently deleted one (P4-P22), whose records keep their insurer text.
  // Filter-only "Historical insurers" group; never offered for new selection.
  const historicalInsuranceList = useMemo(
    () => historicalInsurerNames(insurerCatalog, patients),
    [insurerCatalog, patients]
  );
  // New-selection dropdowns (Add/Edit Patient) show active insurers only —
  // see activeInsuranceNamesFor below for the Edit dialog's extra rule that
  // preserves a patient's current (possibly now-inactive) insurer.
  const activeInsuranceNames = useMemo(
    () => insurerCatalog.filter(entry => entry.isActive).map(entry => entry.name),
    [insurerCatalog]
  );
  /** Active insurer names, plus `currentValue` itself if it's set and not
   *  already active — so opening Edit Patient on a patient whose insurer was
   *  since deactivated still shows/preserves that value instead of silently
   *  blanking it out when the form is saved. */
  const activeInsuranceNamesFor = (currentValue: string) =>
    currentValue && !activeInsuranceNames.includes(currentValue)
      ? [...activeInsuranceNames, currentValue]
      : activeInsuranceNames;

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

  // Patient Records' own selection — never falls back to patients[0] (see
  // selectedRecordsPatientId above). Looked up from activePatients (not
  // `patients`) so a discharged patient's id can never resolve here.
  const selectedRecordsPatient: DbPatient | null =
    patients.find(p => p.id === selectedRecordsPatientId && p.isActive !== false) ?? null;
  const { data: recordsVisits = [] } = trpc.visits.listByPatient.useQuery(
    { patientId: selectedRecordsPatientId ?? '' },
    { enabled: !!selectedRecordsPatient }
  );

  // Discharged Patients' own selection — same idea, looked up only among
  // discharged patients so an active patient's id can never resolve here.
  const selectedDischargedPatient: DbPatient | null =
    patients.find(p => p.id === selectedDischargedPatientId && p.isActive === false) ?? null;
  const { data: dischargedVisits = [] } = trpc.visits.listByPatient.useQuery(
    { patientId: selectedDischargedPatientId ?? '' },
    { enabled: !!selectedDischargedPatient }
  );

  // Pre-compute periods for claims queries
  // P4-P28: a patient created by an import can have claim lines and no visits
  // yet, so the Claims view also lists the periods those lines are in.
  const { data: claimPeriods = [] } = trpc.claims.periodsForPatient.useQuery(
    { patientId: activePatient?.id ?? '' },
    { enabled: canAccessClaims && !!activePatient }
  );
  const periods = useMemo(() => {
    return Array.from(new Set([...visits.map(v => v.authPeriod ?? 1), ...claimPeriods])).sort((a, b) => b - a);
  }, [visits, claimPeriods]);
  const claimViewPeriods = periods;

  // Pre-fetch claims for up to 5 periods
  const claimsQuery1 = trpc.claims.getByPatientAndPeriod.useQuery(
    { patientId: activePatient?.id ?? '', authPeriod: periods[0] ?? 1 },
    { enabled: canAccessClaims && !!activePatient && periods.length > 0 }
  );
  const claimsQuery2 = trpc.claims.getByPatientAndPeriod.useQuery(
    { patientId: activePatient?.id ?? '', authPeriod: periods[1] ?? 1 },
    { enabled: canAccessClaims && !!activePatient && periods.length > 1 }
  );
  const claimsQuery3 = trpc.claims.getByPatientAndPeriod.useQuery(
    { patientId: activePatient?.id ?? '', authPeriod: periods[2] ?? 1 },
    { enabled: canAccessClaims && !!activePatient && periods.length > 2 }
  );
  const claimsQuery4 = trpc.claims.getByPatientAndPeriod.useQuery(
    { patientId: activePatient?.id ?? '', authPeriod: periods[3] ?? 1 },
    { enabled: canAccessClaims && !!activePatient && periods.length > 3 }
  );
  const claimsQuery5 = trpc.claims.getByPatientAndPeriod.useQuery(
    { patientId: activePatient?.id ?? '', authPeriod: periods[4] ?? 1 },
    { enabled: canAccessClaims && !!activePatient && periods.length > 4 }
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

  // When a filter change clears the selection below (patient no longer in
  // scope), we want the detail pane to land on its normal empty state — not
  // have this auto-select effect immediately re-populate it with whatever
  // patient happens to be first. Set only by the filter-validity effect
  // below; cleared as soon as a patient is explicitly selected again.
  const skipAutoSelectRef = useRef(false);

  // Auto-select first patient — skipped on /visits and /claims so those
  // routes never silently show patients[0]; a patient must be explicitly
  // selected (from Patients, an alert card, etc.) to see visit/claims data.
  useEffect(() => {
    if (showDetailView) return;
    if (!selectedPatientId && patients.length > 0 && !skipAutoSelectRef.current) {
      setSelectedPatientId(patients[0].id);
    }
  }, [patients, selectedPatientId, showDetailView]);

  useEffect(() => {
    if (selectedPatientId) {
      skipAutoSelectRef.current = false;
    }
  }, [selectedPatientId]);

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

  const createInsurer = trpc.insurance.create.useMutation({
    onSuccess: () => {
      utils.insurance.list.invalidate();
      toast.success('Insurance company added');
      setNewInsuranceName('');
      setShowAddInsurance(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const handleAddInsurance = () => {
    if (!newInsuranceName.trim()) {
      toast.error('Insurance company name is required');
      return;
    }
    createInsurer.mutate({ name: newInsuranceName });
  };

  // Soft delete ("Deactivate") — see insurance.delete in server/routers.ts.
  // Never touches patient/visit/claim rows; just hides this entry from
  // future new-selection dropdowns.
  const deleteInsurer = trpc.insurance.delete.useMutation({
    onSuccess: () => {
      utils.insurance.list.invalidate();
      toast.success('Insurance company deactivated');
      setInsurerPendingDelete(null);
    },
    onError: (e) => toast.error(e.message),
  });

  // Permanent delete (P4-P21, P4-P22) — see insurance.permanentDelete.
  // Removes the catalog entry only; records keep their insurer text and it
  // reappears solely under the filter's "Historical insurers" group. The
  // success toast runs only after the server has the DB's confirmation; on
  // any failure the confirmation stays open with the reason and the entry
  // stays in the list. The single-flight guard (not just `disabled`) blocks
  // a second click landing before the pending state re-renders — see
  // client/src/lib/concurrencyGuards.ts.
  const permanentDeleteGuardRef = useRef(createSingleFlightGuard());
  const permanentlyDeleteInsurer = trpc.insurance.permanentDelete.useMutation({
    onSettled: () => permanentDeleteGuardRef.current.exit(),
    onSuccess: () => {
      // insurance.* covers the catalog list (management dialog, filters,
      // patient forms, AuthAlertPanel) and the deleted entry's history.
      utils.insurance.invalidate();
      utils.activityLog.invalidate();
      toast.success('Insurance company permanently deleted');
      setPermanentDeleteError(null);
      setInsurerPendingPermanentDelete(null);
    },
    onError: (e) => {
      setPermanentDeleteError(e.message);
      // A concurrent delete already removed it — refresh so it disappears.
      if (e.data?.code === 'NOT_FOUND') utils.insurance.list.invalidate();
    },
  });

  const reactivateInsurer = trpc.insurance.reactivate.useMutation({
    onSuccess: () => {
      utils.insurance.list.invalidate();
      toast.success('Insurance company reactivated');
    },
    onError: (e) => toast.error(e.message),
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
      // P4-P31: an auth status / date edit can change the alerts.
      utils.visits.authAlerts.invalidate();
    },
    onError: (e) => toast.error(`Failed to update: ${e.message}`),
  });

  const updatePatient = trpc.patients.update.useMutation({
    onSuccess: () => {
      utils.patients.list.invalidate();
      // A patient's insurance (or claims_status) may have changed — both the
      // Claims Status counts and the Follow-Up panel are scoped by insurance.
      if (canAccessClaims) {
        utils.claims.getStatusCounts.invalidate();
        utils.claims.getFollowUpClaims.invalidate();
      }
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
      } else {
        toast.success('Patient reactivated');
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

  const handleRecordsToggleActive = (checked: boolean) => {
    if (selectedRecordsPatient) handleToggleActive(selectedRecordsPatient.id, checked);
  };

  const handleDischargedToggleActive = (checked: boolean) => {
    if (selectedDischargedPatient) handleToggleActive(selectedDischargedPatient.id, checked);
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

  const deleteClaim = trpc.claims.delete.useMutation({
    onSuccess: () => {
      utils.claims.getByPatientAndPeriod.invalidate();
      utils.claims.getFollowUpClaims.invalidate();
      utils.claims.getStatusCounts.invalidate();
      toast.success('Claim record deleted');
      setDeleteClaimTarget(null);
    },
    onError: (e) => toast.error(`Failed to delete claim: ${e.message}`),
  });

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

  const logoutMutation = trpc.auth.logout.useMutation();

  const handleSignOut = () => {
    // P4-P23: drop every cached response (Claims included) before leaving,
    // so nothing fetched under this identity survives into the next one.
    purgeIdentityScopedQueries(queryClient);
    logoutMutation.mutate(undefined, {
      onSuccess: () => { window.location.href = '/login'; },
      onError: () => { window.location.href = '/login'; },
    });
  };

  /** Sidebar nav — real routes for every destination except Bulk Upload,
   *  which stays a same-page action (opens the existing dialog, no URL
   *  change) rather than becoming a fake page. */
  const handleNavigate = (section: NavSection) => {
    if (section === 'bulk-upload') {
      if (canAccessClaims) setShowUploadDialog(true);
      return;
    }
    const route = navSectionToRoute(section);
    if (route) navigate(route);
  };

  /** Centralized "select this patient, optionally jump to a detail route"
   *  helper for every patient-selection entry point that should also
   *  navigate (alert cards, follow-up cards, "View Full Records"). Plain
   *  list-row selection — which should only update a workspace's own
   *  preview, not navigate — calls the relevant setSelected*PatientId
   *  directly instead. Navigating to Patient Records also seeds that
   *  workspace's own selection, since it doesn't share selectedPatientId. */
  const selectPatient = (patientId: string, destination?: '/visits' | '/claims' | '/patients/records') => {
    setSelectedPatientId(patientId);
    if (destination === '/patients/records') {
      setSelectedRecordsPatientId(patientId);
    }
    if (destination) navigate(destination);
  };

  // ── Computed metrics ───────────────────────────────────────────────────────
  // getPatientMetrics itself now lives in @/lib/patientMetrics, delegating
  // period math to shared/authPeriodMetrics.ts (kept in sync with server/db.ts).

  // Active patient metrics (from loaded visits)
  const activeMetrics = useMemo(() => getPatientMetrics(visits), [visits]);
  // P4-P30: authorization actions on the patient details alert (shared with AuthAlertPanel).
  const { requestingId: authRequestingId, markRequested: markAuthorizationRequested } = useMarkAuthorizationRequested();
  const [approveAuthPatient, setApproveAuthPatient] = useState<ApproveTarget | null>(null);
  const alertStatus = activePatient
    ? derivePatientAlertPresentation(visits, activeMetrics.remaining, activePatient.authValidUntil)
    : null;

  // Metrics for whichever patient is selected in the Patient Records / Discharged snapshot panes
  const recordsMetrics = useMemo(() => getPatientMetrics(recordsVisits), [recordsVisits]);
  const recordsAlertStatus = selectedRecordsPatient
    ? derivePatientAlertPresentation(recordsVisits, recordsMetrics.remaining, selectedRecordsPatient.authValidUntil)
    : null;
  const dischargedMetrics = useMemo(() => getPatientMetrics(dischargedVisits), [dischargedVisits]);
  const dischargedAlertStatus = selectedDischargedPatient
    ? derivePatientAlertPresentation(dischargedVisits, dischargedMetrics.remaining, selectedDischargedPatient.authValidUntil)
    : null;

  // Completed patients — those with 0 remaining and all sessions dated
  const { data: completedIds = [] } = trpc.visits.completedPatientIds.useQuery();
  const completedSet = useMemo(() => new Set(completedIds), [completedIds]);

  // Split patients into active and discharged
  const activePatients = patients.filter(p => p.isActive !== false);
  const dischargedPatientsRaw = patients.filter(p => p.isActive === false);

  // Claims Status counts — aggregated server-side directly from claims_records
  // (never from the stale patients.claims_status roll-up), scoped by the same
  // insurance filter as the Patients list and the Follow-Up panel so none of
  // the three can ever disagree on screen.
  const { data: statusCountsData } = trpc.claims.getStatusCounts.useQuery({
    insurance: selectedInsurance || undefined,
  }, { enabled: canAccessClaims });
  const claimStatusCounts = statusCountsData?.counts ?? {
    all: 0, submitted: 0, approved: 0, pending: 0, denied: 0,
    pended: 0, rejected: 0, resubmitted: 0, none: 0,
  };
  const patientIdsByStatus = statusCountsData?.patientIdsByStatus ?? {};

  // Single shared Insurance + Claims Status scope — used by the active
  // patient list, the Completed Sessions folder, the Discharged Patients
  // folder, and the selected-patient validity check below, so none of them
  // can ever disagree about which patients are "in scope". Intentionally
  // excludes search: search only hides rows, it isn't part of filter scope.
  const selectedInsuranceAliases = useMemo(
    () => insurerCatalog.find(entry => entry.name === selectedInsurance)?.aliases ?? [],
    [insurerCatalog, selectedInsurance]
  );
  const filterScope = { selectedInsurance, selectedClaimsFilter, patientIdsByStatus, selectedInsuranceAliases };

  // If the currently selected patient no longer matches the active filter
  // scope (the user changed Insurance or Claims Status directly, not by
  // picking a patient), clear the selection instead of leaving the Patient
  // Detail pane showing someone outside the current filter.
  useEffect(() => {
    if (selectedPatient && !matchesPatientFilters(selectedPatient, filterScope)) {
      skipAutoSelectRef.current = true;
      setSelectedPatientId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInsurance, selectedClaimsFilter, patientIdsByStatus]);

  // Same accuracy behavior (PR #25) for the Patient Records workspace's own
  // selection — no auto-select ref needed here, since Records never
  // auto-selects a patient in the first place.
  useEffect(() => {
    if (selectedRecordsPatient && !matchesPatientFilters(selectedRecordsPatient, filterScope)) {
      setSelectedRecordsPatientId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInsurance, selectedClaimsFilter, patientIdsByStatus]);

  // Same accuracy behavior for the Discharged Patients workspace's own selection.
  useEffect(() => {
    if (selectedDischargedPatient && !matchesPatientFilters(selectedDischargedPatient, filterScope)) {
      setSelectedDischargedPatientId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInsurance, selectedClaimsFilter, patientIdsByStatus]);

  // filteredPatients = active patients matching the selected insurance AND claims status filter
  // The sidebar count and the patient list both use the same filter so they always match.
  const filteredPatients = useMemo(() => {
    let result = activePatients.filter(p => matchesPatientFilters(p, filterScope));
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter(p => p.name.toLowerCase().includes(query));
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePatients, selectedInsurance, selectedClaimsFilter, patientIdsByStatus, searchQuery]);

  // Discharged Patients folder, scoped to the same Insurance / Claims Status
  // filter as the active list (previously ignored the filter entirely).
  const dischargedPatients = dischargedPatientsRaw.filter(p => matchesPatientFilters(p, filterScope));

  const activeFilterCount = (selectedInsurance ? 1 : 0) + (selectedClaimsFilter && selectedClaimsFilter !== 'all' ? 1 : 0);

  const handleClearFilters = () => {
    setSelectedInsurance('');
    setSelectedClaimsFilter('all');
  };

  // After a permanent insurer delete (P4-P21) — or on load, if the initial
  // default insurer no longer exists — drop selections that point at nothing.
  // Waits for the catalog and patient queries so an empty in-flight list is
  // never mistaken for "everything was deleted".
  useEffect(() => {
    if (!insurerCatalogLoaded || patientsLoading) return;
    if (isStaleInsurerSelection(selectedInsurance, insurerCatalog, patients)) {
      setSelectedInsurance('');
    }
    if (newPatientInsurance && !activeInsuranceNames.includes(newPatientInsurance)) {
      setNewPatientInsurance('');
    }
    // Edit Patient: a value picked from the list before it was deleted is
    // dropped back to what the patient actually has recorded (kept even if
    // that is the deleted insurer — records keep their insurer, P4-P22).
    if (
      editPatientInsurance &&
      !activeInsuranceNames.includes(editPatientInsurance) &&
      editPatientInsurance !== selectedPatient?.insurance
    ) {
      setEditPatientInsurance(selectedPatient?.insurance ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insurerCatalogLoaded, insurerCatalog, patientsLoading, patients]);

  // Shared between the desktop Patient Workspace filters panel and the mobile
  // Filters sheet so the two never drift.
  const insuranceCounts = useMemo(
    () => Object.fromEntries([
      ...insurerCatalog.map(entry => {
        const matchValues = insurerMatchValues(entry);
        return [entry.name, activePatients.filter(p => matchValues.includes(p.insurance)).length];
      }),
      ...historicalInsuranceList.map(name => [name, activePatients.filter(p => p.insurance === name).length]),
    ]),
    [insurerCatalog, historicalInsuranceList, activePatients]
  );

  const handleSelectInsurance = (insurance: string) => {
    setSelectedInsurance(insurance);
  };

  const handleSelectClaimsStatus = (status: string) => {
    setSelectedClaimsFilter(status);
  };

  // Completed Sessions folder, scoped to the same Insurance / Claims Status
  // filter as the active list (previously ignored the filter entirely).
  const completedPatients = activePatients.filter(p => completedSet.has(p.id) && matchesPatientFilters(p, filterScope));

  // ── Patients Overview (unfiltered — population-wide, not scoped to the
  // Insurance/Claims Status filters used by Records/Discharged) ────────────
  const overviewCompletedPatients = useMemo(
    () => activePatients.filter(p => completedSet.has(p.id)),
    [activePatients, completedSet]
  );

  // Patient Overview KPI row only: mutually-exclusive Total/Active/Completed/
  // Discharged categories (Active here excludes Completed, unlike the shared
  // `activePatients` variable above, which the Dashboard's C6F KPI and other
  // workflows still rely on meaning "isActive !== false").
  const patientOverviewMetrics = useMemo(
    () => getPatientOverviewMetrics(patients, completedSet),
    [patients, completedSet]
  );
  const recentPatients = useMemo(
    () => [...patients].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8),
    [patients]
  );

  // Dashboard KPI row — clinic-wide only, independent of selectedPatientId /
  // activePatient / the Insurance & Claims Status UI filters. authAlerts and
  // getFollowUpClaims are the same tRPC procedures Needs Attention already
  // uses (queried here unfiltered, i.e. no insurance scope, for a true
  // clinic-wide count); react-query dedupes the authAlerts call against
  // AuthAlertPanel's own identical query below.
  const { data: dashboardAuthAlerts = [] } = trpc.visits.authAlerts.useQuery();
  const { data: dashboardFollowUpClaims = [] } = trpc.claims.getFollowUpClaims.useQuery({}, { enabled: canAccessClaims });
  const dashboardKpis = useMemo(() => deriveDashboardKpis({
    activePatientCount: activePatients.length,
    authAlerts: dashboardAuthAlerts,
    followUpClaimCount: dashboardFollowUpClaims.length,
    completedPatientCount: overviewCompletedPatients.length,
  }), [activePatients, dashboardAuthAlerts, dashboardFollowUpClaims, overviewCompletedPatients]);

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
      setNewPatientInsurance('');
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

  /** Shared save path for every correctable visit field (backs each EditableCell
   *  in the visit table). Returns false to keep the cell open on failure so the
   *  user's edit isn't silently discarded. */
  const saveVisitField = async (
    visitId: string,
    patch: Partial<{
      dateOfService: string | null;
      dateAshSubmitted: string | null;
      sessionsAuthorized: number | null;
      sessionsRemaining: number | null;
      sessionNumber: number | null;
    }>,
    successMessage: string
  ): Promise<boolean> => {
    try {
      await updateVisit.mutateAsync({ id: visitId, ...patch });
      toast.success(successMessage);
      return true;
    } catch {
      return false; // onError on the mutation already surfaces a toast
    }
  };

  /** Parse an EditableCell's raw number-input string into a nullable non-negative
   *  integer. Returns `undefined` (distinct from `null`) when the input is invalid. */
  const parseOptionalCount = (raw: string): number | null | undefined => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0) return undefined;
    return n;
  };

  // ── CMS1500 / EOB import (P4-P24) ─────────────────────────────────────────
  // Both upload kinds, single-patient and bulk, go through ClaimImportDialog
  // (preview → explicit review → claims.importCommit). See
  // client/src/components/claims/ClaimImportDialog.tsx.
  const invalidateClaims = () => {
    utils.claims.getByPatientAndPeriod.invalidate();
    utils.claims.getFollowUpClaims.invalidate();
    utils.claims.getStatusCounts.invalidate();
    // P4-P28: a save can add patients and pending reimbursement lines.
    utils.claims.periodsForPatient.invalidate();
    utils.claims.pendingEobList.invalidate();
    utils.patients.list.invalidate();
  };

  const claimImportDialog = claimImport && canAccessClaims ? (
    <ClaimImportDialog
      open
      onOpenChange={(open) => { if (!open) setClaimImport(null); }}
      kind={claimImport.kind}
      mode={claimImport.mode}
      contextPatient={claimImport.patient}
      contextAuthPeriod={claimImport.authPeriod}
      initialFiles={claimImport.files}
      source={claimImport.source ?? 'document'}
      onSaved={invalidateClaims}
    />
  ) : null;

  // Claims-access roles only — the bulk uploads span every patient.
  const claimsBulkUploadActions = canAccessClaims ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5" data-testid="claims-bulk-upload-menu">
          <FileStack className="w-4 h-4" />
          <span className="hidden sm:inline">Bulk Claims Upload</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setClaimImport({ kind: 'cms1500', mode: 'bulk', patient: null, authPeriod: null, files: [] })}>
          Bulk CMS1500 Upload
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setClaimImport({ kind: 'eob', mode: 'bulk', patient: null, authPeriod: null, files: [] })}>
          Bulk Insurance Reimbursement Upload
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  // ── Shared dialogs ─────────────────────────────────────────────────────────
  // Rendered on every route branch below (not just the branch that shows
  // their trigger button) so an action reachable from the sidebar — or from
  // a control on a different route branch, like the Active/Discharged
  // switch — always has somewhere to actually appear.

  // P4-P26 / P4-P28: Bulk Upload is CMS1500 and Insurance Reimbursement only, for
  // Clinic Admin / Owner. Staff have neither the dialog nor a way to open it, and
  // the server gates every procedure behind it independently. P4-P29: patient
  // lists are imported separately, from Patient Records → Bulk Upload Patients
  // (PatientBulkUploadDialog), which every role that can add a patient sees.
  const bulkUploadDialog = canAccessClaims ? (
    <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
      <DialogContent className="w-[calc(100vw-1rem)] max-h-[90vh] overflow-y-auto overflow-x-hidden bg-white sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-brand-blue">Bulk Upload</DialogTitle>
          <DialogDescription>
            Upload PDFs or import a CSV. You review every line and patient before anything is saved. Patients who are not on the dashboard yet are added when you save.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="cms1500" className="w-full">
          <TabsList className="grid h-auto w-full grid-cols-2">
            <TabsTrigger value="cms1500" className="whitespace-normal text-xs sm:text-sm" data-testid="bulk-upload-tab-cms1500">CMS1500</TabsTrigger>
            <TabsTrigger value="eob" className="whitespace-normal text-xs sm:text-sm" data-testid="bulk-upload-tab-eob">Insurance Reimbursement</TabsTrigger>
          </TabsList>
          {(['cms1500', 'eob'] as const).map(kind => (
            <TabsContent key={kind} value={kind} className="mt-4">
              <ClaimBulkUploadPanel
                kind={kind}
                onPdfs={files => {
                  setShowUploadDialog(false);
                  setClaimImport({ kind, mode: 'bulk', source: 'document', patient: null, authPeriod: null, files });
                }}
                onCsv={file => {
                  setShowUploadDialog(false);
                  setClaimImport({ kind, mode: 'bulk', source: 'csv', patient: null, authPeriod: null, files: [file] });
                }}
                onAppliedPending={invalidateClaims}
              />
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  ) : null;


  const patientActionDialogs = (
    <>
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

      {/* ── Edit Patient Dialog ─────────────────────────────── */}
      <Dialog open={isEditPatientOpen} onOpenChange={setIsEditPatientOpen}>
        <DialogContent className="bg-white max-w-md">
          <DialogHeader>
            <DialogTitle className="text-brand-blue text-xl flex items-center gap-2">
              <Pencil className="w-5 h-5" />
              Edit Patient Details
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Correct any patient detail — every field here can be fixed if a mistake was made.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto pr-1">
            <div>
              <Label htmlFor="edit-patient-name" className="text-brand-blue font-semibold">Patient Name</Label>
              <Input
                id="edit-patient-name"
                value={editPatientName}
                onChange={e => setEditPatientName(e.target.value)}
                className="mt-1 border-brand-cream-dark focus:border-brand-blue"
              />
            </div>
            <div>
              <Label htmlFor="edit-patient-insurance" className="text-brand-blue font-semibold">Insurance Company</Label>
              <Select value={editPatientInsurance} onValueChange={setEditPatientInsurance}>
                <SelectTrigger id="edit-patient-insurance" className="mt-1 border-brand-cream-dark w-full">
                  <SelectValue placeholder="Select insurance company" />
                </SelectTrigger>
                <SelectContent>
                  {activeInsuranceNamesFor(editPatientInsurance).map(ins => <SelectItem key={ins} value={ins}>{ins}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="edit-patient-auth-date" className="text-brand-blue font-semibold">Authorization Date</Label>
              <Input
                id="edit-patient-auth-date"
                type="date"
                value={editPatientAuthDate}
                onChange={e => setEditPatientAuthDate(e.target.value)}
                className="mt-1 border-brand-cream-dark focus:border-brand-blue"
              />
            </div>
            <div>
              <Label htmlFor="edit-patient-auth-valid-until" className="text-brand-blue font-semibold">Authorization Valid Until</Label>
              <Input
                id="edit-patient-auth-valid-until"
                type="date"
                value={editPatientAuthValidUntil}
                onChange={e => setEditPatientAuthValidUntil(e.target.value)}
                className="mt-1 border-brand-cream-dark focus:border-brand-blue"
              />
            </div>
            {/* Claims status is claim data — Claims access only (P4-P25). */}
            {canAccessClaims && (
            <div>
              <Label htmlFor="edit-patient-claims-status" className="text-brand-blue font-semibold">Claims Status</Label>
              <Select value={editPatientClaimsStatus} onValueChange={setEditPatientClaimsStatus}>
                <SelectTrigger id="edit-patient-claims-status" className="mt-1 border-brand-cream-dark w-full">
                  <SelectValue placeholder="Select claims status" />
                </SelectTrigger>
                <SelectContent>
                  {CLAIM_STATUS_FILTERS.filter(f => f.value !== 'all').map(f => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            )}
          </div>
          <DialogFooter className="flex gap-3 pt-2 sm:justify-start">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setIsEditPatientOpen(false)}
            >
              Cancel
            </Button>
            <Button
              className="flex-1 bg-brand-blue hover:bg-brand-blue/90 text-white font-semibold"
              disabled={updatePatient.isPending || !editPatientName.trim()}
              onClick={async () => {
                if (!selectedPatient) return;
                try {
                  await updatePatient.mutateAsync({
                    id: selectedPatient.id,
                    name: editPatientName.trim(),
                    insurance: editPatientInsurance,
                    authDate: editPatientAuthDate || null,
                    authValidUntil: editPatientAuthValidUntil
                      ? new Date(editPatientAuthValidUntil + 'T00:00:00Z').getTime()
                      : null,
                    ...(canAccessClaims
                      ? { claimsStatus: (editPatientClaimsStatus || 'none') as 'submitted' | 'approved' | 'pending' | 'denied' | 'pended' | 'rejected' | 'resubmitted' | 'none' }
                      : {}),
                  });
                  setIsEditPatientOpen(false);
                } catch {
                  // onError on the mutation already surfaces a toast
                }
              }}
            >
              {updatePatient.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save Changes
            </Button>
          </DialogFooter>
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

      <RecordHistoryDialog
        open={historyClaimId !== null}
        onOpenChange={(open) => { if (!open) setHistoryClaimId(null); }}
        entityType="claim_record"
        entityId={historyClaimId ?? ''}
      />

      <AlertDialog open={deleteClaimTarget !== null} onOpenChange={(open) => { if (!open) setDeleteClaimTarget(null); }}>
        <AlertDialogContent className="bg-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-brand-blue text-xl">Delete Claim?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              Service date: <strong>{deleteClaimTarget?.dateOfService ? formatCalendarDate(deleteClaimTarget.dateOfService) : '—'}</strong>
              {' · '}
              CPT codes: <strong>{deleteClaimTarget?.cptCodes || '—'}</strong>
              <br /><br />
              This will permanently delete this claim record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-brand-cream-dark text-brand-blue hover:bg-brand-cream">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteClaimTarget !== null) {
                  deleteClaim.mutate({ id: deleteClaimTarget.id, patientId: deleteClaimTarget.patientId });
                }
              }}
              disabled={deleteClaim.isPending}
              className="bg-red-600 hover:bg-red-700 text-white font-semibold"
            >
              {deleteClaim.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
              Delete Claim
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

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

  if (showDetailView) {
    // P4-P23: a direct /claims URL from a non-Super-Admin gets an access
    // denied page — checked before anything patient- or claim-specific is
    // rendered (the claims queries above are already disabled for them).
    if (activeSection === 'claims' && !canAccessClaims) {
      return (
        <DashboardShell
          activeSection={activeSection}
          onNavigate={handleNavigate}
          onSignOut={handleSignOut}
          signingOut={logoutMutation.isPending}
          canManageStaff={canManageStaff}
          canAccessClaims={canAccessClaims}
          topbarTitle="Claims"
        >
          <ClaimsAccessDenied onGoToPatientRecords={() => navigate('/patients/records')} />
          {bulkUploadDialog}
          {claimImportDialog}
        </DashboardShell>
      );
    }
    // Explicit — no patients[0] fallback. A patient must actually have been
    // selected (Patients list, an alert card, "View Full Records", …) for
    // /visits or /claims to show anything.
    if (!selectedPatient) {
      return (
        <DashboardShell
          activeSection={activeSection}
          onNavigate={handleNavigate}
          onSignOut={handleSignOut}
          signingOut={logoutMutation.isPending}
          canManageStaff={canManageStaff}
          canAccessClaims={canAccessClaims}
          topbarTitle={activeSection === 'visits' ? 'Visits' : 'Claims'}
          topbarSubtitle="No patient selected"
          topbarActions={activeSection === 'claims' ? claimsBulkUploadActions : undefined}
        >
          <div className="max-w-[1600px] mx-auto px-4 sm:px-6 xl:px-8 py-20 text-center">
            <p className="text-muted-foreground mb-4">
              {activeSection === 'visits'
                ? 'Select a patient to view visit records.'
                : 'Select a patient to view claims records.'}
            </p>
            <Button onClick={() => navigate('/patients/records')} className="bg-brand-blue hover:bg-brand-blue-dark text-white font-semibold">
              Go to Patient Records
            </Button>
          </div>
          {bulkUploadDialog}
          {claimImportDialog}
        </DashboardShell>
      );
    }
    // Shadow the fallback-including `activePatient` with the just-verified
    // non-null selection so TypeScript narrows it for the rest of this branch.
    const activePatient = selectedPatient;

    return (
      <DashboardShell
        activeSection={activeSection}
        onNavigate={handleNavigate}
        onSignOut={handleSignOut}
        signingOut={logoutMutation.isPending}
        canManageStaff={canManageStaff}
        canAccessClaims={canAccessClaims}
        topbarTitle={activePatient.name}
        topbarSubtitle={`Insurance: ${activePatient.insurance}`}
        topbarActions={
          <>
            <div className="hidden sm:flex items-center gap-2 rounded-lg border border-border px-3 py-1.5">
              {activePatient.isActive !== false ? (
                <UserCheck className="w-4 h-4 text-green-600" />
              ) : (
                <UserX className="w-4 h-4 text-gray-400" />
              )}
              <span className={`text-xs font-semibold ${activePatient.isActive !== false ? 'text-green-700' : 'text-gray-500'}`}>
                {activePatient.isActive !== false ? 'Active' : 'Discharged'}
              </span>
              <Switch
                checked={activePatient.isActive !== false}
                onCheckedChange={(checked) => handleToggleActive(activePatient.id, checked)}
                disabled={setPatientActive.isPending}
                aria-label="Toggle patient active status"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditPatientName(activePatient.name);
                setEditPatientInsurance(activePatient.insurance);
                setEditPatientAuthDate(toInputDate(activePatient.authDate));
                setEditPatientAuthValidUntil(msToInputDate(activePatient.authValidUntil));
                setEditPatientClaimsStatus(activePatient.claimsStatus || 'none');
                setIsEditPatientOpen(true);
              }}
              aria-label="Edit patient"
              className="gap-1.5"
            >
              <Pencil className="w-4 h-4" />
              <span className="hidden sm:inline">Edit Patient</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => refetchVisits()} aria-label="Refresh visit data" className="gap-1.5">
              <RefreshCw className="w-4 h-4" />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </>
        }
      >
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 xl:px-8 py-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/dashboard')}
            className="mb-4 -ml-2 gap-1.5 text-brand-blue hover:text-brand-blue hover:bg-brand-cream"
          >
            <ChevronLeft className="w-4 h-4" />
            Back to Dashboard
          </Button>
          {/* Discharge Info Banner */}
          {activePatient.isActive === false && (
            <div className="mb-6 rounded-xl border-2 border-gray-400 bg-gray-50 p-4 shadow-md flex items-start gap-3">
              <UserX className="w-6 h-6 mt-0.5 shrink-0 text-gray-500" />
              <div className="flex-1">
                <h3 className="font-bold text-base mb-1 text-gray-700">Discharged Patient</h3>
                <div className="flex flex-wrap gap-4 text-sm text-gray-600">
                  {activePatient.dischargeDate && (
                    <span><span className="font-semibold">Date of Discharge:</span> {formatCalendarDate(activePatient.dischargeDate)}</span>
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
          {alertStatus && alertStatus.urgency !== 'ok' && (() => {
            const style = AUTH_BANNER_STYLE[alertStatus.urgency];
            const message = authBannerMessage(alertStatus.urgency, activeMetrics.remaining, activePatient.insurance, alertStatus.authExpiryWarning, activeMetrics.unusedExpired);
            return (
              <div role="status" className={`mb-6 rounded-xl border-2 p-4 shadow-md flex items-start gap-3 ${style.border} ${style.bg}`}>
                <AlertCircle className={`w-6 h-6 mt-0.5 shrink-0 ${style.icon}`} />
                <div className="flex-1 min-w-0 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className={`font-bold text-base mb-1 ${style.heading}`}>
                      {alertStatus.label}
                    </h3>
                    <p className={`text-sm ${style.body}`}>
                      {message}
                    </p>
                  </div>
                  {/* P4-P30: the same actions as this patient's Dashboard alert. */}
                  <AuthorizationActionButtons
                    className="flex gap-2 shrink-0"
                    buttonClassName="h-8 text-xs flex-1 sm:flex-none"
                    authPending={alertStatus.authStatus === 'pending'}
                    requesting={authRequestingId === activePatient.id}
                    onMarkRequested={() => markAuthorizationRequested(activePatient.id)}
                    onApprove={() => setApproveAuthPatient({ id: activePatient.id, name: activePatient.name, insurance: activePatient.insurance ?? '' })}
                  />
                </div>
              </div>
            );
          })()}
          <ApproveAuthorizationDialog target={approveAuthPatient} onClose={() => setApproveAuthPatient(null)} />

          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            {[
              { label: 'Authorized', value: activeMetrics.totalAuthorized, tone: 'navy' as const },
              { label: 'Completed', value: activeMetrics.completed, tone: 'gold' as const },
              { label: 'Remaining', value: activeMetrics.remaining, tone: 'navy' as const,
                // P4-P31: unused sessions of an expired period are history, not availability.
                sub: activeMetrics.expired
                  ? (activeMetrics.unusedExpired > 0 ? `Authorization expired · ${activeMetrics.unusedExpired} unused` : 'Authorization expired')
                  : undefined },
            ].map(({ label, value, tone, sub }) => (
              <MetricCard key={label} label={label} value={value} tone={tone} sub={sub} />
            ))}
          </div>

          {/* Visit Records — one Card per auth period */}
          {visitsLoading ? (
            <div className="flex items-center justify-center py-12 text-brand-blue">
              <Loader2 className="w-6 h-6 animate-spin mr-2 text-brand-gold" />
              Loading visits…
            </div>
          ) : visits.length === 0 && (activeSection !== 'claims' || periods.length === 0) ? (
            <Card className="border-brand-cream-dark shadow-md">
              <CardContent className="py-12 text-center text-muted-foreground">No visit records yet. Log a session to get started.</CardContent>
            </Card>
          ) : (
            <>
              {(() => {
                // newest first; the visit cards list visit periods only, the Claims view any period with claim lines
                const periods = activeSection === 'claims'
                  ? claimViewPeriods
                  : Array.from(new Set(visits.map(v => v.authPeriod ?? 1))).sort((a, b) => b - a);
                // Active period = oldest with remaining sessions (from activeMetrics)
                const activePeriod = activeMetrics.activePeriod;
                return periods.map((period, periodIndex) => {
                  // Load claims for this period
                  const periodVisits = visits.filter(v => (v.authPeriod ?? 1) === period);
                  const periodAuth = periodVisits.find(v => v.sessionsAuthorized != null)?.sessionsAuthorized ?? 0;
                  const periodInsurance = periodVisits.find(v => v.insuranceCompany)?.insuranceCompany ?? null;
                  const isActive = period === activePeriod;
                  const periodMetrics = getPeriodMetrics(periodVisits, period);
                  // P4-P23: the session table no longer shows the three
                  // financial totals (or their Claims-derived auto-fill and
                  // period Totals footer) for any role — those values stay
                  // stored and are Claims-access data. Its last three
                  // columns are the per-session workflow fields instead.
                  return (
                    <div key={`period-${period}`}>
                    {activeSection !== 'claims' && (
                    <Card
                      className={`shadow-sm rounded-xl overflow-hidden py-0 gap-0 mb-6 border ${
                      isActive ? 'border-gray-100 border-t-4 border-t-brand-gold' : 'border-gray-200'
                    }`}>
                      <CardHeader className={`px-6 py-5 flex flex-row items-center justify-between ${
                        isActive ? 'bg-brand-blue text-white' : 'bg-gray-100 text-gray-600'
                      }`}>
                        <div className="flex-1">
                          <CardTitle className={`text-xl font-semibold ${ isActive ? 'text-white' : 'text-gray-700'}`}>
                            Authorization Period {period} — {periodAuth} Sessions
                          </CardTitle>
                          <CardDescription className={`text-sm mt-1 opacity-90 ${isActive ? 'text-brand-gold' : 'text-gray-500'}`}>
                            {periodInsurance && (
                              <span className="font-medium">{periodInsurance} · </span>
                            )}
                            {periodMetrics.expired
                              ? `Authorization expired · ${periodMetrics.completed} of ${periodMetrics.authorized} used${periodMetrics.unusedExpired > 0 ? ` · ${periodMetrics.unusedExpired} unused (not available)` : ''}`
                              : isActive
                              ? 'Active period · click any (editable) field below to correct it'
                              : 'Completed authorization period · fields marked (editable) can still be corrected'}
                          </CardDescription>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {/* P4-P31: expiry is set per period, by hand. */}
                          {periodVisits.length > 0 && (
                          <PeriodExpiryControl
                            patientId={activePatient.id}
                            patientName={activePatient.name}
                            period={period}
                            expired={periodMetrics.expired}
                            authorized={periodMetrics.authorized}
                            completed={periodMetrics.completed}
                            hasLaterPeriod={visits.some(v => (v.authPeriod ?? 1) > period)}
                          />
                          )}
                          {/* Claims access only (P4-P25) */}
                          {canAccessClaims && (
                          <Button
                            className="bg-brand-gold hover:bg-brand-gold-dark text-brand-blue font-semibold px-5 py-2.5 rounded-lg inline-flex items-center gap-2 transition-all shadow-sm hover:shadow-md"
                            onClick={() => navigate('/claims')}
                          >
                            <FileText className="w-4 h-4" strokeWidth={2.5} />
                            View Claims
                          </Button>
                          )}
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
                        </div>
                      </CardHeader>
                      <CardContent className="p-0">
                        {/* Mobile Visit Cards — below md */}
                        <div className="md:hidden divide-y divide-gray-100 bg-white">
                          {periodVisits.map((visit) => {
                            return (
                            <div key={visit.id} className="p-4 space-y-3">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-baseline gap-1.5">
                                  <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Session</span>
                                  <span className="font-semibold text-gray-700 text-base">
                                    <EditableCell
                                      type="number"
                                      min={1}
                                      value={visit.sessionNumber != null ? String(visit.sessionNumber) : ''}
                                      display={visit.sessionNumber}
                                      isSaving={updateVisit.isPending}
                                      onSave={async (raw) => {
                                        const parsed = parseOptionalCount(raw);
                                        if (parsed === undefined) { toast.error('Enter a valid session number'); return false; }
                                        return saveVisitField(visit.id, { sessionNumber: parsed }, 'Session # saved');
                                      }}
                                    />
                                  </span>
                                </div>
                                <VisitAuthStatusSelect visit={visit} onChange={handleUpdateAuthStatus} />
                              </div>

                              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                                <div>
                                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Date of Service</p>
                                  <p className="text-brand-blue">
                                    <EditableCell
                                      type="date"
                                      value={toInputDate(visit.dateOfService)}
                                      display={visit.dateOfService ? formatDate(visit.dateOfService) : null}
                                      isSaving={updateVisit.isPending}
                                      onSave={(raw) => saveVisitField(visit.id, { dateOfService: raw || null }, 'Date of Service saved')}
                                    />
                                  </p>
                                </div>
                                <div>
                                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Authorize Session Date</p>
                                  <p className="text-brand-blue">{visit.dateOfService ? formatDate(visit.dateOfService) : <span className="text-gray-300">—</span>}</p>
                                </div>
                                <div>
                                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide"># Authorized</p>
                                  <div className="font-semibold text-brand-blue text-base">
                                    <EditableCell
                                      type="number"
                                      min={0}
                                      value={visit.sessionsAuthorized != null ? String(visit.sessionsAuthorized) : ''}
                                      display={visit.sessionsAuthorized}
                                      isSaving={updateVisit.isPending}
                                      onSave={async (raw) => {
                                        const parsed = parseOptionalCount(raw);
                                        if (parsed === undefined) { toast.error('Enter a valid number of authorized sessions'); return false; }
                                        return saveVisitField(visit.id, { sessionsAuthorized: parsed }, '# Authorized saved');
                                      }}
                                    />
                                  </div>
                                </div>
                                <div>
                                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide"># Remaining</p>
                                  <div className="font-bold text-brand-gold text-base">
                                    <EditableCell
                                      type="number"
                                      min={0}
                                      value={visit.sessionsRemaining != null ? String(visit.sessionsRemaining) : ''}
                                      display={visit.sessionsRemaining}
                                      isSaving={updateVisit.isPending}
                                      onSave={async (raw) => {
                                        const parsed = parseOptionalCount(raw);
                                        if (parsed === undefined) { toast.error('Enter a valid number of remaining sessions'); return false; }
                                        return saveVisitField(visit.id, { sessionsRemaining: parsed }, '# Remaining saved');
                                      }}
                                    />
                                  </div>
                                </div>
                              </div>

                              <div>
                                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">
                                  Date Authorization Submitted
                                </p>
                                <div className="flex items-center gap-2 group text-gray-400 hover:text-brand-blue transition-colors min-h-[40px]">
                                  <Calendar className="w-4 h-4 text-brand-gold group-hover:scale-110 transition-transform shrink-0" />
                                  <EditableCell
                                    type="date"
                                    value={toInputDate(visit.dateAshSubmitted)}
                                    display={visit.dateAshSubmitted ? <span className="text-brand-blue text-sm">{formatDate(visit.dateAshSubmitted)}</span> : null}
                                    emptyLabel="Click to set date"
                                    isSaving={updateVisit.isPending}
                                    onSave={(raw) => saveVisitField(visit.id, { dateAshSubmitted: raw || null }, 'Date Authorization Submitted saved')}
                                  />
                                </div>
                              </div>

                              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                                <div>
                                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Assignment of Benefits</p>
                                  <AssignmentOfBenefitsSelect patientId={activePatient.id} visit={visit} />
                                </div>
                                <div>
                                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Submission Status</p>
                                  <SubmissionStatusSelect patientId={activePatient.id} visit={visit} />
                                </div>
                                <div className="col-span-2">
                                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Remarks</p>
                                  <RemarksCell patientId={activePatient.id} visit={visit} />
                                </div>
                              </div>
                            </div>
                            );
                          })}
                        </div>
                        {/* Desktop Visit Table — md and up */}
                        <div className="hidden md:block overflow-x-auto">
                          <table className="w-full text-sm min-w-full">
                            <thead className="bg-brand-blue/95">
                              <tr>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Authorize Session Date</th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">
                                  # Authorized
                                  <span className="text-brand-gold font-normal normal-case ml-1">(editable)</span>
                                </th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">
                                  # Remaining
                                  <span className="text-brand-gold font-normal normal-case ml-1">(editable)</span>
                                </th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">
                                  Session #
                                  <span className="text-brand-gold font-normal normal-case ml-1">(editable)</span>
                                </th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">
                                  Date of Service
                                  <span className="text-brand-gold font-normal normal-case ml-1">(editable)</span>
                                </th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">
                                  Date Authorization Submitted
                                  <span className="text-brand-gold font-normal normal-case ml-1">(editable)</span>
                                </th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Auth Status</th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">
                                  Assignment of Benefits
                                  <span className="text-brand-gold font-normal normal-case ml-1">(editable)</span>
                                </th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">
                                  Submission Status
                                  <span className="text-brand-gold font-normal normal-case ml-1">(editable)</span>
                                </th>
                                <th className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">
                                  Remarks
                                  <span className="text-brand-gold font-normal normal-case ml-1">(editable)</span>
                                </th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-100">
                      {periodVisits.map((visit) => {
                        return (
                        <tr key={visit.id} className="hover:bg-brand-cream/30 transition-colors">
                          {/* Authorize Session Date (label only renamed, P4-P23 — same underlying date) */}
                          <td className="px-4 py-2.5 text-sm text-brand-blue whitespace-nowrap">
                            {visit.dateOfService ? formatDate(visit.dateOfService) : <span className="text-gray-300 text-lg">—</span>}
                          </td>
                          {/* # Authorized — EDITABLE */}
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            <div className="font-semibold text-brand-blue text-base">
                              <EditableCell
                                type="number"
                                min={0}
                                value={visit.sessionsAuthorized != null ? String(visit.sessionsAuthorized) : ''}
                                display={visit.sessionsAuthorized}
                                isSaving={updateVisit.isPending}
                                onSave={async (raw) => {
                                  const parsed = parseOptionalCount(raw);
                                  if (parsed === undefined) { toast.error('Enter a valid number of authorized sessions'); return false; }
                                  return saveVisitField(visit.id, { sessionsAuthorized: parsed }, '# Authorized saved');
                                }}
                              />
                            </div>
                          </td>
                          {/* # Remaining — EDITABLE */}
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            <div className="font-bold text-brand-gold text-base">
                              <EditableCell
                                type="number"
                                min={0}
                                value={visit.sessionsRemaining != null ? String(visit.sessionsRemaining) : ''}
                                display={visit.sessionsRemaining}
                                isSaving={updateVisit.isPending}
                                onSave={async (raw) => {
                                  const parsed = parseOptionalCount(raw);
                                  if (parsed === undefined) { toast.error('Enter a valid number of remaining sessions'); return false; }
                                  return saveVisitField(visit.id, { sessionsRemaining: parsed }, '# Remaining saved');
                                }}
                              />
                            </div>
                          </td>
                          {/* Session # — EDITABLE */}
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            <div className="font-medium text-gray-700 text-base">
                              <EditableCell
                                type="number"
                                min={1}
                                value={visit.sessionNumber != null ? String(visit.sessionNumber) : ''}
                                display={visit.sessionNumber}
                                isSaving={updateVisit.isPending}
                                onSave={async (raw) => {
                                  const parsed = parseOptionalCount(raw);
                                  if (parsed === undefined) { toast.error('Enter a valid session number'); return false; }
                                  return saveVisitField(visit.id, { sessionNumber: parsed }, 'Session # saved');
                                }}
                              />
                            </div>
                          </td>
                          {/* Date of Service — EDITABLE */}
                          <td className="px-4 py-2.5 text-sm text-muted-foreground whitespace-nowrap">
                            <EditableCell
                              type="date"
                              value={toInputDate(visit.dateOfService)}
                              display={visit.dateOfService ? formatDate(visit.dateOfService) : null}
                              isSaving={updateVisit.isPending}
                              onSave={(raw) => saveVisitField(visit.id, { dateOfService: raw || null }, 'Date of Service saved')}
                            />
                          </td>
                          {/* Date Authorization Submitted — EDITABLE */}
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            <div className="flex items-center gap-2 group text-gray-400 hover:text-brand-blue transition-colors">
                              <Calendar className="w-4 h-4 text-brand-gold group-hover:scale-110 transition-transform shrink-0" />
                              <EditableCell
                                type="date"
                                value={toInputDate(visit.dateAshSubmitted)}
                                display={visit.dateAshSubmitted ? <span className="text-brand-blue text-sm">{formatDate(visit.dateAshSubmitted)}</span> : null}
                                emptyLabel="Click to set date"
                                isSaving={updateVisit.isPending}
                                onSave={(raw) => saveVisitField(visit.id, { dateAshSubmitted: raw || null }, 'Date Authorization Submitted saved')}
                              />
                            </div>
                          </td>
                          {/* Auth Status */}
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            <VisitAuthStatusSelect visit={visit} onChange={handleUpdateAuthStatus} />
                          </td>
                          {/* Assignment of Benefits — EDITABLE (P4-P23) */}
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            <AssignmentOfBenefitsSelect patientId={activePatient.id} visit={visit} />
                          </td>
                          {/* Submission Status — EDITABLE (P4-P23) */}
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            <SubmissionStatusSelect patientId={activePatient.id} visit={visit} />
                          </td>
                          {/* Remarks — EDITABLE multiline (P4-P23) */}
                          <td className="px-4 py-2.5 text-sm align-top">
                            <RemarksCell patientId={activePatient.id} visit={visit} />
                          </td>
                        </tr>
                        );
                      })}
                            </tbody>
                          </table>
                        </div>
                      </CardContent>
                    </Card>
                    )}

                    {/* Claims Tracking Card — Below Authorization Period */}
                    {activeSection !== 'visits' && (
                    <Card
                      key={`claims-${period}`}
                      className="border border-border border-t-4 border-t-brand-gold shadow-brand rounded-xl mb-6 ml-0"
                    >
                      <CardHeader className="bg-white rounded-t-xl">
                        <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
                          <div className="space-y-1 shrink-0">
                            <CardTitle className="text-xl font-semibold tracking-tight text-brand-blue whitespace-nowrap">
                              Claims Tracker — Period {period}
                            </CardTitle>
                            <CardDescription className="text-sm text-muted-foreground">
                              Comprehensive claim details and payment tracking
                            </CardDescription>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap justify-end">
                            {/* Add Claim — opens the existing Add Claim dialog scoped to this period */}
                            <Button
                              size="sm"
                              className="inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-brand-blue hover:bg-brand-blue-dark text-white text-sm font-medium whitespace-nowrap"
                              onClick={() => {
                                setAddClaimPeriod(period);
                                setShowAddClaimDialog(true);
                              }}
                            >
                              <Plus className="h-4 w-4" />
                              Add Claim
                            </Button>
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
                                    <Button
                                      variant="link"
                                      size="sm"
                                      onClick={() => {
                                        setHiddenClaimsColumns(new Set());
                                        localStorage.removeItem('claims-hidden-columns');
                                      }}
                                      className="h-auto p-0 text-xs text-brand-blue"
                                    >
                                      Show all
                                    </Button>
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
                                        id={`col-${period}-${col.key}`}
                                        checked={!hiddenClaimsColumns.has(col.key)}
                                        onCheckedChange={() => toggleClaimsColumn(col.key)}
                                      />
                                      <label htmlFor={`col-${period}-${col.key}`} className="text-xs text-gray-700 cursor-pointer select-none">
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
                            {/* P4-P24: CMS1500 first (creates the service lines), then the
                                EOB (adds amounts to those lines). Both open the review
                                dialog for this patient and period; nothing saves before
                                an explicit Save there. */}
                            <label
                              htmlFor={`claim-upload-cms-${period}`}
                              className="cursor-pointer inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap"
                              title="Step 1 — upload the CMS1500 to create this claim's service lines (date, CPT, modifiers, units, diagnosis). Amounts stay blank until the EOB is uploaded."
                            >
                              <Upload className="h-4 w-4" /> CMS1500 Upload
                            </label>
                            <input
                              id={`claim-upload-cms-${period}`}
                              type="file"
                              accept=".pdf"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = '';
                                if (!file) return;
                                setClaimImport({ kind: 'cms1500', mode: 'single', patient: { id: activePatient.id, name: activePatient.name }, authPeriod: period, files: [file] });
                              }}
                            />
                            <label
                              htmlFor={`claim-upload-reimb-${period}`}
                              className="cursor-pointer inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap"
                              title="Step 2 — upload the EOB to add billed, paid and patient-responsibility amounts to lines that came from a CMS1500. Upload the CMS1500 first."
                            >
                              <Upload className="h-4 w-4" /> Insurance Reimbursement Upload
                            </label>
                            <input
                              id={`claim-upload-reimb-${period}`}
                              type="file"
                              accept=".pdf,.csv,.xlsx,.xls,.xlsm"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = '';
                                if (!file) return;
                                setClaimImport({ kind: 'eob', mode: 'single', patient: { id: activePatient.id, name: activePatient.name }, authPeriod: period, files: [file] });
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

                          // Shared edit-state helpers — used by both the desktop table cells
                          // and the mobile cards below, so edit/mutation behavior stays identical.
                          const isEditingField = (claimId: string, field: string) =>
                            editingCell?.claimId === claimId && editingCell?.field === field;

                          const startEditField = (claimId: string, field: string, rawValue: string) => {
                            setEditingCell({ claimId, field });
                            setEditingValue(rawValue);
                          };

                          const commitEditField = (claimId: string, field: string, isNumeric = false, isDate = false) => {
                            if (!editingCell) return;
                            const payload: Record<string, any> = { id: claimId };
                            payload[field] = isNumeric
                              ? (editingValue.trim() ? parseFloat(editingValue) : null)
                              : (editingValue.trim() || null);
                            updateClaim.mutate(payload as any);
                          };

                          const statusColors: Record<string, string> = {
                            approved: 'bg-green-100 text-green-800',
                            denied: 'bg-red-100 text-red-800',
                            pending: 'bg-yellow-100 text-yellow-800',
                            submitted: 'bg-blue-100 text-blue-800',
                            pended: 'bg-orange-100 text-orange-800',
                            rejected: 'bg-gray-900 text-white',
                            resubmitted: 'bg-violet-100 text-violet-800',
                            needs_review: 'bg-amber-100 text-amber-800',
                          };

                          const hide = (key: string) => hiddenClaimsColumns.has(key);

                          // Shared column source of truth for the desktop table's header AND
                          // its per-date "Totals" row (bottom of each date-of-service group,
                          // mirroring the source EOB's own layout) — keeps both in sync so a
                          // hidden column disappears from the totals row too.
                          const claimsTableColumns = [
                            { key: 'placeOfService', label: 'Place of Service', align: 'left' },
                            { key: 'dateOfService', label: 'Date of Service', align: 'left' },
                            { key: 'visitNumber', label: 'Visit #', align: 'left' },
                            { key: 'cptCodes', label: 'CPT Codes', align: 'left' },
                            { key: 'unitsBilled', label: 'Units', align: 'center' },
                            { key: 'diagnosisCodes', label: 'Diagnosis', align: 'left' },
                            { key: 'modifier', label: 'Modifier', align: 'left' },
                            { key: 'chargeAmount', label: 'Charge', align: 'right' },
                            { key: 'insuranceReimbursement', label: 'Ins. Reimb.', align: 'right' },
                            { key: 'patientAmountPaid', label: 'Pt. Paid', align: 'right' },
                            { key: 'patientAmountDue', label: 'Pt. Due', align: 'right' },
                            { key: 'insuranceBilled', label: 'Ins. Billed', align: 'left' },
                            { key: 'claimSubmittedDate', label: 'Date Submitted', align: 'left' },
                            { key: 'expireBcbsClaimNumber', label: 'Claim #', align: 'left' },
                            { key: 'claimStatus', label: 'Status', align: 'center' },
                            { key: 'lmn', label: 'LMN Documents Date Sent', align: 'left' },
                            { key: 'checkDate', label: 'Check/Payment Date', align: 'left' },
                            { key: 'checkNumberVirtualCard', label: 'Check/EFT #', align: 'left' },
                            { key: 'dateOfAppeal', label: 'Appeal Date', align: 'left' },
                            { key: 'referenceNo', label: 'Appeal Ref #', align: 'left' },
                            // Not a data field — never hideable, never part of CSV export or
                            // totals math. Always rendered (View History is available to any
                            // authenticated staff member, matching claims.historyForClaim's
                            // normalProtectedProcedure gate); Delete Claim inside it stays
                            // canManageStaff-only, mirroring claims.delete's adminOrOwnerProcedure.
                            { key: 'actions', label: '', align: 'center' as const },
                          ];
                          const visibleClaimsColumns = claimsTableColumns.filter(c => c.key === 'actions' || !hide(c.key));

                          // Per-date-of-service sums for the bottom "Totals" row — mirrors the
                          // source EOB's own layout (a Totals row under each date's line items).
                          const MONEY_TOTAL_FIELDS: Record<string, string> = {
                            chargeAmount: 'charge_amount',
                            insuranceReimbursement: 'insurance_reimbursement',
                            patientAmountPaid: 'patient_amount_paid',
                            patientAmountDue: 'patient_amount_due',
                          };
                          // P4-P24: a line with no amount yet (e.g. a CMS1500 line whose EOB
                          // hasn't arrived) is unknown, not $0.00 — totals only sum known
                          // amounts, show "—" when none are known, and mark a partial total.
                          const groupsByDate = new Map<string, any[]>();
                          for (const c of claims) {
                            const key = c.date_of_service ?? '';
                            groupsByDate.set(key, [...(groupsByDate.get(key) ?? []), c]);
                          }
                          const dateGroupTotals = new Map<string, Record<string, { total: number | null; unknownCount: number }>>();
                          groupsByDate.forEach((rows, key) => {
                            const totals: Record<string, { total: number | null; unknownCount: number }> = {};
                            for (const [outKey, rawKey] of Object.entries(MONEY_TOTAL_FIELDS)) {
                              totals[outKey] = sumKnownMoney(rows.map((r: any) => r[rawKey]));
                            }
                            dateGroupTotals.set(key, totals);
                          });
                          const formatTotal = (t: { total: number | null; unknownCount: number }) =>
                            t.total == null ? '—' : `$${t.total.toFixed(2)}${t.unknownCount > 0 ? '*' : ''}`;
                          const totalTitle = (t: { total: number | null; unknownCount: number }) =>
                            t.unknownCount > 0 ? `${t.unknownCount} line(s) on this date have no amount yet` : undefined;
                          const renderClaimsTotalsRow = (dateKey: string, keyPrefix: string) => {
                            const g = dateGroupTotals.get(dateKey);
                            if (!g) return null;
                            return (
                              <tr key={`${keyPrefix}-totals-${dateKey}`} className="bg-gray-50/80 font-semibold border-b border-gray-300 text-xs">
                                {visibleClaimsColumns.map((col, i) => (
                                  <td key={col.key} title={col.key in MONEY_TOTAL_FIELDS ? totalTitle(g[col.key]) : undefined} className={`border border-gray-200 px-1 py-1 ${col.key in MONEY_TOTAL_FIELDS ? 'text-right text-gray-800' : ''} ${col.key === 'actions' ? 'sticky right-0 bg-gray-50/80 z-10' : ''}`}>
                                    {i === 0
                                      ? <span className="text-gray-500 italic">Totals</span>
                                      : col.key in MONEY_TOTAL_FIELDS
                                        ? formatTotal(g[col.key])
                                        : null}
                                  </td>
                                ))}
                              </tr>
                            );
                          };

                          const claimStatusOptions = [
                            { value: 'submitted', label: 'Submitted' },
                            { value: 'approved', label: 'Approved' },
                            { value: 'pending', label: 'Pending' },
                            { value: 'denied', label: 'Denied' },
                            { value: 'pended', label: 'Pended' },
                            { value: 'rejected', label: 'Rejected' },
                            { value: 'resubmitted', label: 'Resubmitted' },
                            { value: 'needs_review', label: 'Needs Review' },
                          ];

                          const MobileEditableRow = ({ claimId, label, field, value, type = 'text', prefix = '', decimals = 2 }: {
                            claimId: string; label: string; field: string; value: string | number | null; type?: 'text' | 'number' | 'date'; prefix?: string; decimals?: number;
                          }) => {
                            const editing = isEditingField(claimId, field);
                            const numVal = type === 'number' && value != null ? parseFloat(value as string) : null;
                            const rawDate = type === 'date' && value ? new Date(value as string).toISOString().split('T')[0] : '';
                            const displayDate = type === 'date' && value ? formatCalendarDate(value as string) : null;
                            const startVal = type === 'number'
                              ? (numVal != null && !isNaN(numVal) ? numVal.toString() : '')
                              : type === 'date' ? rawDate : ((value as string) ?? '');
                            return (
                              <div
                                className="flex items-center justify-between gap-3 py-2.5 border-b border-black/5 last:border-0 min-h-[40px]"
                                onClick={() => !editing && startEditField(claimId, field, startVal)}
                              >
                                <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide shrink-0">{label}</span>
                                {editing ? (
                                  <input
                                    autoFocus
                                    type={type}
                                    step={type === 'number' ? (decimals === 0 ? '1' : '0.01') : undefined}
                                    className="flex-1 min-w-0 text-sm border border-blue-400 rounded px-2 py-1.5 outline-none bg-white text-right"
                                    value={editingValue}
                                    onChange={e => setEditingValue(e.target.value)}
                                    onBlur={() => commitEditField(claimId, field, type === 'number', type === 'date')}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') commitEditField(claimId, field, type === 'number', type === 'date');
                                      if (e.key === 'Escape') setEditingCell(null);
                                    }}
                                    onClick={e => e.stopPropagation()}
                                  />
                                ) : (
                                  <span className="text-sm text-right text-brand-blue truncate max-w-[60%]">
                                    {type === 'number'
                                      ? (numVal != null && !isNaN(numVal) ? `${prefix}${numVal.toFixed(decimals)}` : <span className="text-gray-300">—</span>)
                                      : type === 'date'
                                        ? (displayDate || <span className="text-gray-300">—</span>)
                                        : (value || <span className="text-gray-300">—</span>)}
                                  </span>
                                )}
                              </div>
                            );
                          };

                          return (
                            <>
                            {/* Mobile Claim Cards — below md */}
                            <div className="md:hidden divide-y divide-gray-200 bg-white">
                              {claims.flatMap((claim: any, claimIdx: number) => {
                                const nextClaim = claimIdx < claims.length - 1 ? claims[claimIdx + 1] : null;
                                const isLastOfDateGroup = !nextClaim || nextClaim.date_of_service !== claim.date_of_service;
                                const g = dateGroupTotals.get(claim.date_of_service ?? '');
                                const totalsCard = isLastOfDateGroup && g ? (
                                  <div key={`mobile-totals-${claim.date_of_service ?? ''}`} className="p-4 bg-gray-50/80 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                                    <p className="col-span-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Totals for {claim.date_of_service ? formatCalendarDate(claim.date_of_service) : 'this date'}</p>
                                    {!hide('chargeAmount') && <p className="text-gray-700" title={totalTitle(g.chargeAmount)}>Charge: <span className="font-semibold">{formatTotal(g.chargeAmount)}</span></p>}
                                    {!hide('insuranceReimbursement') && <p className="text-gray-700" title={totalTitle(g.insuranceReimbursement)}>Ins. Reimb.: <span className="font-semibold">{formatTotal(g.insuranceReimbursement)}</span></p>}
                                    {!hide('patientAmountPaid') && <p className="text-gray-700" title={totalTitle(g.patientAmountPaid)}>Pt. Paid: <span className="font-semibold">{formatTotal(g.patientAmountPaid)}</span></p>}
                                    {!hide('patientAmountDue') && <p className="text-gray-700" title={totalTitle(g.patientAmountDue)}>Pt. Due: <span className="font-semibold">{formatTotal(g.patientAmountDue)}</span></p>}
                                  </div>
                                ) : null;
                                return [(
                                <div key={claim.id} className="p-4 space-y-4">
                                  {/* Header: Date of Service / claim identifier / status */}
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <p className="text-sm font-semibold text-brand-blue">
                                        {claim.date_of_service ? formatCalendarDate(claim.date_of_service) : <span className="text-gray-300">No date</span>}
                                      </p>
                                      <p className="text-xs text-gray-500 mt-0.5 truncate">
                                        {(claim.expire_bcbs_claim_number || claim.oa_claim_number)
                                          ? `Claim #${claim.expire_bcbs_claim_number || claim.oa_claim_number}`
                                          : claim.visit_number != null ? `Visit #${claim.visit_number}` : 'No claim ID'}
                                      </p>
                                    </div>
                                    {!hide('claimStatus') && (
                                      isEditingField(claim.id, 'claimStatus') ? (
                                        <select
                                          autoFocus
                                          aria-label="Claim status"
                                          className="text-xs border border-blue-400 rounded px-2 py-1.5 bg-white min-h-[36px] shrink-0"
                                          value={editingValue}
                                          onChange={e => {
                                            setEditingValue(e.target.value);
                                            updateClaim.mutate({ id: claim.id, claimStatus: e.target.value as any });
                                          }}
                                          onBlur={() => setEditingCell(null)}
                                          onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setEditingCell(null); }}
                                        >
                                          {claimStatusOptions.map(opt => (
                                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                                          ))}
                                        </select>
                                      ) : (
                                        <button
                                          onClick={() => startEditField(claim.id, 'claimStatus', claim.claim_status ?? 'submitted')}
                                          aria-label="Edit claim status"
                                          className="shrink-0 min-h-[36px] flex items-center"
                                        >
                                          <Badge className={statusColors[claim.claim_status] ?? 'bg-blue-100 text-blue-800'}>
                                            {claim.claim_status ?? 'submitted'}
                                          </Badge>
                                        </button>
                                      )
                                    )}
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <button
                                          type="button"
                                          aria-label="Claim row actions"
                                          className="p-1.5 rounded hover:bg-gray-200 text-gray-500 shrink-0"
                                        >
                                          <MoreVertical className="w-4 h-4" />
                                        </button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem onClick={() => setHistoryClaimId(claim.id)}>
                                          <History className="w-4 h-4" />
                                          View History
                                        </DropdownMenuItem>
                                        {canManageStaff && (
                                          <DropdownMenuItem
                                            variant="destructive"
                                            onClick={() => setDeleteClaimTarget({
                                              id: claim.id,
                                              patientId: claim.patient_id,
                                              dateOfService: claim.date_of_service,
                                              cptCodes: claim.cpt_codes,
                                            })}
                                          >
                                            <Trash2 className="w-4 h-4" />
                                            Delete Claim
                                          </DropdownMenuItem>
                                        )}
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  </div>

                                  {/* Billing */}
                                  {(!hide('chargeAmount') || !hide('insuranceReimbursement') || !hide('patientAmountPaid') || !hide('patientAmountDue') || !hide('insuranceBilled')) && (
                                    <div>
                                      <p className="text-[10px] font-bold text-brand-gold uppercase tracking-wider mb-1">Billing</p>
                                      <div className="rounded-lg bg-brand-cream/40 px-3">
                                        {!hide('chargeAmount') && <MobileEditableRow claimId={claim.id} label="Charge" field="chargeAmount" value={claim.charge_amount} type="number" prefix="$" />}
                                        {!hide('insuranceReimbursement') && <MobileEditableRow claimId={claim.id} label="Ins. Reimb." field="insuranceReimbursement" value={claim.insurance_reimbursement} type="number" prefix="$" />}
                                        {!hide('patientAmountPaid') && <MobileEditableRow claimId={claim.id} label="Pt. Paid" field="patientAmountPaid" value={claim.patient_amount_paid} type="number" prefix="$" />}
                                        {!hide('patientAmountDue') && <MobileEditableRow claimId={claim.id} label="Pt. Due" field="patientAmountDue" value={claim.patient_amount_due} type="number" prefix="$" />}
                                        {!hide('insuranceBilled') && <MobileEditableRow claimId={claim.id} label="Ins. Billed" field="insuranceBilled" value={claim.insurance_billed} type="text" />}
                                      </div>
                                    </div>
                                  )}

                                  {/* Codes */}
                                  {(!hide('placeOfService') || !hide('visitNumber') || !hide('cptCodes') || !hide('unitsBilled') || !hide('diagnosisCodes') || !hide('modifier')) && (
                                    <div>
                                      <p className="text-[10px] font-bold text-brand-gold uppercase tracking-wider mb-1">Codes</p>
                                      <div className="rounded-lg bg-brand-cream/40 px-3">
                                        {!hide('placeOfService') && <MobileEditableRow claimId={claim.id} label="Place of Service" field="placeOfService" value={claim.place_of_service} type="text" />}
                                        {!hide('visitNumber') && <MobileEditableRow claimId={claim.id} label="Visit #" field="visitNumber" value={claim.visit_number} type="number" decimals={0} />}
                                        {!hide('cptCodes') && <MobileEditableRow claimId={claim.id} label="CPT Codes" field="cptCodes" value={claim.cpt_codes} type="text" />}
                                        {!hide('unitsBilled') && <MobileEditableRow claimId={claim.id} label="Units" field="unitsBilled" value={claim.units_billed} type="number" />}
                                        {!hide('diagnosisCodes') && <MobileEditableRow claimId={claim.id} label="Diagnosis" field="diagnosisCodes" value={claim.diagnosis_codes} type="text" />}
                                        {!hide('modifier') && <MobileEditableRow claimId={claim.id} label="Modifier" field="modifier" value={claim.modifier} type="text" />}
                                      </div>
                                    </div>
                                  )}

                                  {/* Follow-up */}
                                  {(!hide('claimSubmittedDate') || !hide('expireBcbsClaimNumber') || !hide('lmn') || !hide('checkDate') || !hide('checkNumberVirtualCard') || !hide('dateOfAppeal') || !hide('referenceNo')) && (
                                    <div>
                                      <p className="text-[10px] font-bold text-brand-gold uppercase tracking-wider mb-1">Follow-Up</p>
                                      <div className="rounded-lg bg-brand-cream/40 px-3">
                                        {!hide('claimSubmittedDate') && <MobileEditableRow claimId={claim.id} label="Date Submitted" field="claimSubmittedDate" value={claim.claim_submitted_date} type="date" />}
                                        {!hide('expireBcbsClaimNumber') && (
                                          <div
                                            className="flex items-center justify-between gap-3 py-2.5 border-b border-black/5 last:border-0 min-h-[40px]"
                                            onClick={() => !isEditingField(claim.id, 'expireBcbsClaimNumber') && startEditField(claim.id, 'expireBcbsClaimNumber', claim.expire_bcbs_claim_number ?? '')}
                                          >
                                            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide shrink-0">Claim #</span>
                                            {isEditingField(claim.id, 'expireBcbsClaimNumber') ? (
                                              <input
                                                autoFocus
                                                className="flex-1 min-w-0 text-sm border border-blue-400 rounded px-2 py-1.5 outline-none bg-white text-right"
                                                value={editingValue}
                                                onChange={e => setEditingValue(e.target.value)}
                                                onBlur={() => commitEditField(claim.id, 'expireBcbsClaimNumber')}
                                                onKeyDown={e => { if (e.key === 'Enter') commitEditField(claim.id, 'expireBcbsClaimNumber'); if (e.key === 'Escape') setEditingCell(null); }}
                                                onClick={e => e.stopPropagation()}
                                              />
                                            ) : (
                                              <span className="text-sm text-right text-brand-blue truncate max-w-[60%]">
                                                {claim.expire_bcbs_claim_number || claim.oa_claim_number || <span className="text-gray-300">—</span>}
                                              </span>
                                            )}
                                          </div>
                                        )}
                                        {!hide('lmn') && <MobileEditableRow claimId={claim.id} label="LMN Sent" field="lmn" value={claim.lmn} type="text" />}
                                        {!hide('checkDate') && <MobileEditableRow claimId={claim.id} label="Check/Payment Date" field="checkDate" value={claim.check_date} type="date" />}
                                        {!hide('checkNumberVirtualCard') && <MobileEditableRow claimId={claim.id} label="Check/EFT #" field="checkNumberVirtualCard" value={claim.check_number_virtual_card} type="text" />}
                                        {!hide('dateOfAppeal') && <MobileEditableRow claimId={claim.id} label="Appeal Date" field="dateOfAppeal" value={claim.date_of_appeal} type="date" />}
                                        {!hide('referenceNo') && <MobileEditableRow claimId={claim.id} label="Appeal Ref #" field="referenceNo" value={claim.reference_no} type="text" />}
                                      </div>
                                    </div>
                                  )}
                                </div>
                                ), ...(totalsCard ? [totalsCard] : [])];
                              })}
                            </div>
                            {/* Desktop Claims Table — md and up */}
                            <div className="hidden md:block overflow-x-auto">
                              <table className="w-full text-xs border-collapse">
                                <thead>
                                  <tr className="bg-brand-cream border-b border-brand-cream-dark">
                                    {visibleClaimsColumns.map(c => (
                                      <th
                                        key={c.key}
                                        className={`border border-brand-cream-dark px-2 py-2 text-${c.align} font-semibold text-brand-blue uppercase text-[10px] tracking-wider whitespace-nowrap ${c.key === 'actions' ? 'sticky right-0 bg-brand-cream z-10' : ''}`}
                                      >
                                        {c.key === 'actions' ? 'Actions' : c.label}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {claims.flatMap((claim: any, claimIdx: number) => {
                                    // Show the date once per group of consecutive rows that share it,
                                    // instead of repeating it on every CPT line for the same visit.
                                    const prevClaim = claimIdx > 0 ? claims[claimIdx - 1] : null;
                                    const isSameDateAsPrev = prevClaim && prevClaim.date_of_service === claim.date_of_service;
                                    const nextClaim = claimIdx < claims.length - 1 ? claims[claimIdx + 1] : null;
                                    const isLastOfDateGroup = !nextClaim || nextClaim.date_of_service !== claim.date_of_service;
                                    const isEditing = (field: string) => isEditingField(claim.id, field);
                                    const startEdit = (field: string, rawValue: string) => startEditField(claim.id, field, rawValue);
                                    const commitEdit = (field: string, isNumeric = false, isDate = false) =>
                                      commitEditField(claim.id, field, isNumeric, isDate);

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
                                      const displayDate = value ? formatCalendarDate(value) : null;
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

                                    const row = (
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
                                                <option value="needs_review">Needs Review</option>
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
                                        <td className="border border-gray-200 px-1 py-1 text-center sticky right-0 bg-white hover:bg-brand-cream/50 z-10">
                                          <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                              <button
                                                type="button"
                                                aria-label="Claim row actions"
                                                className="p-1 rounded hover:bg-gray-200 text-gray-500"
                                              >
                                                <MoreVertical className="w-4 h-4" />
                                              </button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                              <DropdownMenuItem onClick={() => setHistoryClaimId(claim.id)}>
                                                <History className="w-4 h-4" />
                                                View History
                                              </DropdownMenuItem>
                                              {canManageStaff && (
                                                <DropdownMenuItem
                                                  variant="destructive"
                                                  onClick={() => setDeleteClaimTarget({
                                                    id: claim.id,
                                                    patientId: claim.patient_id,
                                                    dateOfService: claim.date_of_service,
                                                    cptCodes: claim.cpt_codes,
                                                  })}
                                                >
                                                  <Trash2 className="w-4 h-4" />
                                                  Delete Claim
                                                </DropdownMenuItem>
                                              )}
                                            </DropdownMenuContent>
                                          </DropdownMenu>
                                        </td>
                                      </tr>
                                    );
                                    return isLastOfDateGroup
                                      ? [row, renderClaimsTotalsRow(claim.date_of_service ?? '', 'desktop')]
                                      : [row];
                                  })}
                                </tbody>
                              </table>
                            </div>
                            </>
                          );
                        })()}
                      </CardContent>
                    </Card>
                    )}
                    </div>
                  );
                });
              })()}
            </>
          )}
        </div>
        {/* Add Claim Dialog */}
        <Dialog open={showAddClaimDialog} onOpenChange={setShowAddClaimDialog}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add New Claim Record</DialogTitle>
            <DialogDescription>
              Period {addClaimPeriod} for {activePatient?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-brand-blue">Claim Information</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                  <Label>Insurance Billed</Label>
                  <Input value={claimFormData.insuranceBilled} onChange={(e) => setClaimFormData({...claimFormData, insuranceBilled: e.target.value})} />
                </div>
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-brand-blue">Codes</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-brand-blue">Billing</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                  <Label>Check/Payment Date</Label>
                  <Input type="date" value={claimFormData.checkDate} onChange={(e) => setClaimFormData({...claimFormData, checkDate: e.target.value})} />
                </div>
                <div>
                  <Label>Check/EFT #</Label>
                  <Input value={claimFormData.checkNumberVirtualCard} onChange={(e) => setClaimFormData({...claimFormData, checkNumberVirtualCard: e.target.value})} />
                </div>
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-brand-blue">Status / Follow-Up</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                  <Label>Appeal Date</Label>
                  <Input type="date" value={claimFormData.dateOfAppeal} onChange={(e) => setClaimFormData({...claimFormData, dateOfAppeal: e.target.value})} />
                </div>
                <div>
                  <Label>Appeal Ref #</Label>
                  <Input value={claimFormData.referenceNo} onChange={(e) => setClaimFormData({...claimFormData, referenceNo: e.target.value})} />
                </div>
              </div>
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

      {bulkUploadDialog}
          {claimImportDialog}
      {patientActionDialogs}
      </DashboardShell>
    );
  }

  // ── Shared list-view content (used by /dashboard, /patients/records and
  // /patients/discharged) ─────────────────────────────────────────────────

  const filterChipsElement = (
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
  );

  /** Add Patient trigger + dialog — reused on both /dashboard and
   *  /patients/records so the action is reachable from either. */
  const addPatientAction = (
    <Dialog open={showAddPatient} onOpenChange={setShowAddPatient}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 bg-brand-gold hover:bg-brand-gold-dark text-brand-blue font-semibold">
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Add Patient</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-white max-h-[90vh] overflow-y-auto">
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
                {activeInsuranceNames.map(ins => <SelectItem key={ins} value={ins}>{ins}</SelectItem>)}
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
  );

  /** Add Insurance Company trigger + dialog — shown beside Add Patient on
   *  Patient Records. Creation is owner/clinic-admin only server-side
   *  (adminOrOwnerProcedure); the button is gated behind the same
   *  canManageStaff check client-side so non-admin staff never see an
   *  action they can't complete. Read access (insuranceList above) is
   *  unrestricted — every dashboard user sees newly added insurers. */
  const addInsuranceAction = (
    <Dialog open={showAddInsurance} onOpenChange={(open) => { setShowAddInsurance(open); if (!open) setNewInsuranceName(''); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Add Insurance Company</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-white">
        <DialogHeader>
          <DialogTitle className="text-brand-blue">Add Insurance Company</DialogTitle>
          <DialogDescription>Add a new insurance company to the shared list used across patient forms and filters</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-insurance-name" className="text-brand-blue font-semibold">Insurance Company Name</Label>
            <Input
              id="new-insurance-name"
              placeholder="Enter insurance company name"
              value={newInsuranceName}
              onChange={e => setNewInsuranceName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddInsurance(); }}
              className="border-brand-cream-dark"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowAddInsurance(false)} disabled={createInsurer.isPending}>
              Cancel
            </Button>
            <Button onClick={handleAddInsurance} disabled={createInsurer.isPending} className="bg-brand-blue hover:bg-brand-blue-dark text-white font-semibold">
              {createInsurer.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Add Insurance Company
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  /** Manage Insurance Companies — admin/owner only (gated client-side by
   *  canManageStaff, matching addInsuranceAction above; enforced server-side
   *  by adminOrOwnerProcedure on insurance.delete/reactivate). Lists every
   *  catalog entry (active + inactive, via insurerCatalog — NOT the
   *  active-only activeInsuranceNames) so a deactivated insurer stays
   *  visible/manageable here even though it no longer appears in
   *  new-selection dropdowns elsewhere. */
  const manageInsuranceAction = (
    <Dialog open={showManageInsurance} onOpenChange={setShowManageInsurance}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Settings className="w-4 h-4" />
          <span className="hidden sm:inline">Manage Insurance Companies</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-white max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-brand-blue">Manage Insurance Companies</DialogTitle>
          <DialogDescription>
            Deactivate hides a company from new patient/claim forms and can be undone. Delete Insurance
            Company permanently removes it from the catalog. Neither ever changes an existing patient,
            visit, or claim — those keep their recorded insurance information.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 max-h-[55vh] overflow-y-auto pr-1">
          {insurerCatalog.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">No insurance companies yet.</p>
          )}
          {insurerCatalog.map(entry => (
            <div
              key={entry.id}
              className={`flex flex-col gap-2 rounded-lg border px-3 py-2 ${entry.isActive ? 'border-brand-cream-dark' : 'border-brand-cream-dark bg-muted/40'}`}
            >
              <div className="min-w-0">
                <p className={`text-sm font-medium truncate ${entry.isActive ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                  {entry.name}
                </p>
                {!entry.isActive && (
                  <p className="text-xs text-muted-foreground">Deactivated — hidden from new selections</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => setHistoryInsurerId(entry.id)}
                >
                  <History className="w-3.5 h-3.5" />
                  History
                </Button>
                {entry.isActive ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => setInsurerPendingDelete({ id: entry.id, name: entry.name })}
                  >
                    <EyeOff className="w-3.5 h-3.5" />
                    Deactivate
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={reactivateInsurer.isPending}
                    onClick={() => reactivateInsurer.mutate({ id: entry.id })}
                  >
                    {reactivateInsurer.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Reactivate
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-destructive hover:text-destructive"
                  aria-label={`Delete Insurance Company ${entry.name}`}
                  onClick={() => {
                    setPermanentDeleteError(null);
                    setInsurerPendingPermanentDelete({ id: entry.id, name: entry.name });
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete Insurance Company
                </Button>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
      <RecordHistoryDialog
        open={historyInsurerId !== null}
        onOpenChange={(open) => { if (!open) setHistoryInsurerId(null); }}
        entityType="insurer_catalog"
        entityId={historyInsurerId ?? ''}
      />
    </Dialog>
  );

  const deleteInsurerConfirmDialog = (
    <AlertDialog open={insurerPendingDelete !== null} onOpenChange={(open) => { if (!open) setInsurerPendingDelete(null); }}>
      <AlertDialogContent className="bg-white">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-brand-blue text-xl">Deactivate Insurance Company?</AlertDialogTitle>
          <AlertDialogDescription className="text-muted-foreground">
            {insurerPendingDelete && (
              <>
                "{insurerPendingDelete.name}" will no longer appear as an option when adding or editing
                patients. Existing patients, visits, and claims already using this name are not changed
                and remain filterable. You can reactivate it later from this same dialog.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="border-brand-cream-dark text-brand-blue hover:bg-brand-cream" disabled={deleteInsurer.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive hover:bg-destructive/90 text-white"
            disabled={deleteInsurer.isPending}
            onClick={() => {
              if (insurerPendingDelete) deleteInsurer.mutate({ id: insurerPendingDelete.id });
            }}
          >
            {deleteInsurer.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Deactivate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const permanentDeleteInsurerConfirmDialog = (
    <AlertDialog
      open={insurerPendingPermanentDelete !== null}
      onOpenChange={(open) => {
        // Not dismissable mid-request: the outcome must be visible here.
        if (!open && !permanentlyDeleteInsurer.isPending) {
          setInsurerPendingPermanentDelete(null);
          setPermanentDeleteError(null);
        }
      }}
    >
      <AlertDialogContent className="bg-white">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-brand-blue text-xl">Delete Insurance Company?</AlertDialogTitle>
          <AlertDialogDescription className="text-muted-foreground">
            {insurerPendingPermanentDelete && (
              <>
                Permanently delete ‘{insurerPendingPermanentDelete.name}’ from the insurance catalog?
                <br />
                Existing patient, visit, and claim records will keep their recorded insurance
                information. This cannot be undone.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {permanentDeleteError && (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{permanentDeleteError}</span>
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel className="border-brand-cream-dark text-brand-blue hover:bg-brand-cream" disabled={permanentlyDeleteInsurer.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive hover:bg-destructive/90 text-white"
            disabled={permanentlyDeleteInsurer.isPending}
            onClick={(e) => {
              // Keep the dialog open until the server answers; onSuccess closes it.
              e.preventDefault();
              if (!insurerPendingPermanentDelete || !permanentDeleteGuardRef.current.tryEnter()) return;
              setPermanentDeleteError(null);
              permanentlyDeleteInsurer.mutate({ id: insurerPendingPermanentDelete.id });
            }}
          >
            {permanentlyDeleteInsurer.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
            Permanently Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const bulkUploadTrigger = (
    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowUploadDialog(true)}>
      <Upload className="w-4 h-4" />
      <span className="hidden sm:inline">Bulk Upload</span>
    </Button>
  );

  // ── /patients (Overview) ────────────────────────────────────────────────

  if (activeSection === 'patients-overview') {
    return (
      <DashboardShell
        activeSection={activeSection}
        onNavigate={handleNavigate}
        onSignOut={handleSignOut}
        signingOut={logoutMutation.isPending}
        canManageStaff={canManageStaff}
        canAccessClaims={canAccessClaims}
        topbarTitle="Patients"
        topbarSubtitle="Current state of the patient population"
      >
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 xl:px-8 py-6">
          <PatientOverview
            totalPatients={patientOverviewMetrics.totalPatients}
            activePatients={patientOverviewMetrics.activePatients}
            completedPatients={patientOverviewMetrics.completedPatients}
            dischargedPatients={patientOverviewMetrics.dischargedPatients}
            insuranceCounts={insuranceCounts}
            recentPatients={recentPatients}
            onSelectPatient={(id) => selectPatient(id, '/patients/records')}
            onSelectAuthAlertPatient={(id) => selectPatient(id, '/visits')}
          />
        </div>
        {bulkUploadDialog}
          {claimImportDialog}
      </DashboardShell>
    );
  }

  // ── /patients/records ───────────────────────────────────────────────────

  if (activeSection === 'patients-records') {
    return (
      <DashboardShell
        activeSection={activeSection}
        onNavigate={handleNavigate}
        onSignOut={handleSignOut}
        signingOut={logoutMutation.isPending}
        canManageStaff={canManageStaff}
        canAccessClaims={canAccessClaims}
        topbarTitle="Patient Records"
        topbarSubtitle="Find and select a patient to view their information"
        topbarActions={<div className="flex flex-wrap items-center gap-2">{addPatientAction}<PatientBulkUploadDialog />{canManageStaff && addInsuranceAction}{canManageStaff && manageInsuranceAction}</div>}
      >
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 xl:px-8 py-6 space-y-6">
          {filterChipsElement}
          <PatientRecordsWorkspace
            insuranceList={insuranceList}
            historicalInsuranceList={historicalInsuranceList}
            insuranceCounts={insuranceCounts}
            selectedInsurance={selectedInsurance}
            onSelectInsurance={handleSelectInsurance}
            claimStatusFilters={canAccessClaims ? CLAIM_STATUS_FILTERS : []}
            claimStatusCounts={claimStatusCounts}
            selectedClaimsFilter={selectedClaimsFilter}
            onSelectClaimsFilter={handleSelectClaimsStatus}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            showMobileFilters={showMobileFilters}
            onShowMobileFiltersChange={setShowMobileFilters}
            activeFilterCount={activeFilterCount}
            onClearFilters={handleClearFilters}
            filteredPatients={filteredPatients}
            completedPatients={completedPatients}
            selectedPatientId={selectedRecordsPatientId}
            onSelectPatient={setSelectedRecordsPatientId}
            onDeletePatient={(id, name) => { setDeletePatientId(id); setDeletePatientName(name); }}
            snapshotPatient={selectedRecordsPatient}
            snapshotMetrics={recordsMetrics}
            snapshotAlertStatus={recordsAlertStatus}
            onToggleActive={handleRecordsToggleActive}
            togglePending={setPatientActive.isPending}
            onViewFullRecords={() => { if (selectedRecordsPatient) selectPatient(selectedRecordsPatient.id, '/visits'); }}
          />
        </div>
        {bulkUploadDialog}
          {claimImportDialog}
        {patientActionDialogs}
        {deleteInsurerConfirmDialog}
        {permanentDeleteInsurerConfirmDialog}
      </DashboardShell>
    );
  }

  // ── /patients/discharged ────────────────────────────────────────────────

  if (activeSection === 'patients-discharged') {
    return (
      <DashboardShell
        activeSection={activeSection}
        onNavigate={handleNavigate}
        onSignOut={handleSignOut}
        signingOut={logoutMutation.isPending}
        canManageStaff={canManageStaff}
        canAccessClaims={canAccessClaims}
        topbarTitle="Discharged Patients"
        topbarSubtitle="Review patients no longer in active care"
      >
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 xl:px-8 py-6 space-y-6">
          {filterChipsElement}
          <DischargedPatientsWorkspace
            patients={dischargedPatients}
            searchQuery={dischargedSearchQuery}
            onSearchQueryChange={setDischargedSearchQuery}
            insuranceList={insuranceList}
            historicalInsuranceList={historicalInsuranceList}
            insuranceCounts={insuranceCounts}
            selectedInsurance={selectedInsurance}
            onSelectInsurance={handleSelectInsurance}
            claimStatusFilters={canAccessClaims ? CLAIM_STATUS_FILTERS : []}
            claimStatusCounts={claimStatusCounts}
            selectedClaimsFilter={selectedClaimsFilter}
            onSelectClaimsFilter={handleSelectClaimsStatus}
            showFilters={showDischargedFilters}
            onShowFiltersChange={setShowDischargedFilters}
            activeFilterCount={activeFilterCount}
            onClearFilters={handleClearFilters}
            selectedPatientId={selectedDischargedPatientId}
            onSelectPatient={setSelectedDischargedPatientId}
            snapshotPatient={selectedDischargedPatient}
            snapshotMetrics={dischargedMetrics}
            snapshotAlertStatus={dischargedAlertStatus}
            onToggleActive={handleDischargedToggleActive}
            togglePending={setPatientActive.isPending}
            onViewFullRecords={() => { if (selectedDischargedPatient) selectPatient(selectedDischargedPatient.id, '/visits'); }}
          />
        </div>
        {bulkUploadDialog}
          {claimImportDialog}
      </DashboardShell>
    );
  }

  // ── /authorizations (Overview) ──────────────────────────────────────────
  // Read-only clinic-wide snapshot built on trpc.visits.authAlerts (C6E) —
  // KPIs, a Needs Attention summary, and status distribution. Operational
  // actions stay on /authorizations/attention; full lookup stays on
  // /authorizations/records.

  if (activeSection === 'authorizations-overview') {
    return (
      <DashboardShell
        activeSection={activeSection}
        onNavigate={handleNavigate}
        onSignOut={handleSignOut}
        signingOut={logoutMutation.isPending}
        canManageStaff={canManageStaff}
        canAccessClaims={canAccessClaims}
        topbarTitle="Authorizations"
        topbarSubtitle="Monitor authorization status and patient authorization needs."
      >
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 xl:px-8 py-6">
          <AuthorizationOverview onNavigate={navigate} />
        </div>
        {bulkUploadDialog}
          {claimImportDialog}
      </DashboardShell>
    );
  }

  // ── /authorizations/attention ───────────────────────────────────────────
  // Dedicated full-width operational queue — the real AuthAlertPanel, moved
  // here from /authorizations in C6B. Same component, same query, same
  // callback as the Dashboard's own Needs Attention widget below.

  if (activeSection === 'authorizations-attention') {
    return (
      <DashboardShell
        activeSection={activeSection}
        onNavigate={handleNavigate}
        onSignOut={handleSignOut}
        signingOut={logoutMutation.isPending}
        canManageStaff={canManageStaff}
        canAccessClaims={canAccessClaims}
        topbarTitle="Needs Attention"
        topbarSubtitle="Review patients requiring authorization action."
      >
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 xl:px-8 py-6">
          <AuthAlertPanel onSelectPatient={(id) => selectPatient(id, '/visits')} />
        </div>
        {bulkUploadDialog}
          {claimImportDialog}
      </DashboardShell>
    );
  }

  // ── /authorizations/records ─────────────────────────────────────────────
  // Clinic-wide lookup: one row per patient for their current/target
  // authorization period, sourced entirely from trpc.visits.authAlerts (the
  // same query Needs Attention uses). Full period-by-period history stays on
  // /visits, reached via View Visits below.

  if (activeSection === 'authorizations-records') {
    return (
      <DashboardShell
        activeSection={activeSection}
        onNavigate={handleNavigate}
        onSignOut={handleSignOut}
        signingOut={logoutMutation.isPending}
        canManageStaff={canManageStaff}
        canAccessClaims={canAccessClaims}
        topbarTitle="Authorization Records"
        topbarSubtitle="Review patient authorization status and records."
      >
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 xl:px-8 py-6">
          <AuthorizationRecordsWorkspace onViewVisits={(id) => selectPatient(id, '/visits')} />
        </div>
        {bulkUploadDialog}
          {claimImportDialog}
      </DashboardShell>
    );
  }

  // ── Main Dashboard View ────────────────────────────────────────────────────

  return (
    <DashboardShell
      activeSection={activeSection}
      onNavigate={handleNavigate}
      onSignOut={handleSignOut}
      signingOut={logoutMutation.isPending}
      canManageStaff={canManageStaff}
      canAccessClaims={canAccessClaims}
      topbarTitle="Dashboard"
      topbarSubtitle="Authorization & Claims Overview"
      topbarActions={
        <>
          {/* Bulk Upload — dialog itself is rendered globally (bulkUploadDialog
              below) so it also opens from the sidebar action on every route;
              this button just opens it without navigating. */}
          {canAccessClaims && bulkUploadTrigger}
          {claimsBulkUploadActions}
          {addPatientAction}
        </>
      }
    >
      {/* Main Content */}
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 xl:px-8 py-6 space-y-6 xl:space-y-8">

        {/* KPI Cards — clinic-wide only; see dashboardKpis above */}
        <div className={`grid grid-cols-1 sm:grid-cols-2 ${canAccessClaims ? 'xl:grid-cols-4' : 'xl:grid-cols-3'} gap-4`}>
          {[
            { icon: <Users className="w-4 h-4 text-brand-blue" />, label: 'Active Patients', value: dashboardKpis.activePatients, sub: 'Currently active, all insurances', tone: 'navy' as const },
            { icon: <AlertTriangle className="w-4 h-4 text-destructive" />, label: 'Authorization Attention', value: dashboardKpis.authorizationAttention, sub: 'Needs authorization action', tone: 'destructive' as const },
            // Claims KPI requires Claims access (P4-P25).
            ...(canAccessClaims ? [{ icon: <AlertCircle className="w-4 h-4 text-brand-gold-dark" />, label: 'Claims Follow-Up', value: dashboardKpis.claimsFollowUp, sub: 'Unresolved, all insurances', tone: 'gold' as const }] : []),
            { icon: <CheckCircle2 className="w-4 h-4 text-brand-gold-dark" />, label: 'Completed Patients', value: dashboardKpis.completedPatients, sub: 'Sessions exhausted', tone: 'gold' as const },
          ].map(({ icon, label, value, sub, tone }) => (
            <MetricCard key={label} icon={icon} label={label} value={value} sub={sub} tone={tone} />
          ))}
        </div>

        {/* ─── Needs Attention ────────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Needs Attention</h2>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 xl:gap-6">
            <div className={canAccessClaims ? 'lg:col-span-4' : 'lg:col-span-12'}>
              <AuthAlertPanel onSelectPatient={(id) => selectPatient(id, '/visits')} />
            </div>
            {canAccessClaims && (
            <div className="lg:col-span-8">
              <ClaimsFollowUpPanel
                insurance={selectedInsurance}
                onSelectPatient={(id) => selectPatient(id, '/claims')}
              />
            </div>
            )}
          </div>
        </section>
      </div>

      {bulkUploadDialog}
          {claimImportDialog}
      {patientActionDialogs}
    </DashboardShell>
  );
}
