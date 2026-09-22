import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertCircle, Search, ShieldCheck } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { formatCalendarDate } from '@/lib/date';
import { StatusBadge } from './StatusBadge';
import { FilterChips, type FilterChip } from './FilterChips';
import { URGENCY_COLOR } from '@/lib/patientAuthUrgency';
import {
  matchesAuthorizationRecordFilters,
  sortAuthorizationRecords,
  getCompletedSessions,
  formatAuthPeriod,
} from '@/lib/authorizationRecordFilters';

const AUTH_STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'none', label: 'None' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'denied', label: 'Denied' },
];

const URGENCY_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'denied', label: 'Denied' },
  { value: 'exhausted', label: 'Exhausted' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'pending', label: 'Pending' },
  { value: 'ok', label: 'On Track' },
];

const ACTIVITY_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'exhausted', label: 'Exhausted' },
];

const URGENCY_SHORT_LABEL: Record<string, string> = {
  denied: 'Denied',
  exhausted: 'Exhausted',
  critical: 'Critical',
  warning: 'Warning',
  pending: 'Pending',
  ok: 'On Track',
};

function formatDate(value: number | string | null | undefined): string {
  return formatCalendarDate(value);
}

function UrgencyBadge({ urgency }: { urgency: string }) {
  const colorClass = URGENCY_COLOR[urgency as keyof typeof URGENCY_COLOR] ?? 'bg-gray-100 text-gray-600';
  const label = URGENCY_SHORT_LABEL[urgency] ?? urgency;
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${colorClass}`}>
      {label}
    </span>
  );
}

/** Clinic-wide "what is every patient's current authorization status"
 *  lookup — one row per patient for their CURRENT/TARGET authorization
 *  period only (from trpc.visits.authAlerts, the same query the Needs
 *  Attention queue uses). Full period-by-period history stays on /visits;
 *  this never fetches per-patient visit data. */
export function AuthorizationRecordsWorkspace({ onViewVisits }: { onViewVisits: (patientId: string) => void }) {
  const { data: alerts = [], isLoading, error } = trpc.visits.authAlerts.useQuery();

  const [recordsSearch, setRecordsSearch] = useState('');
  const [recordsInsurance, setRecordsInsurance] = useState('all');
  const [recordsAuthStatus, setRecordsAuthStatus] = useState('all');
  const [recordsUrgency, setRecordsUrgency] = useState('all');
  const [recordsActivity, setRecordsActivity] = useState('all');

  const insuranceOptions = useMemo(
    () => Array.from(new Set(alerts.map(a => a.insurance).filter((v): v is string => !!v))).sort(),
    [alerts]
  );

  const filterScope = {
    search: recordsSearch,
    insurance: recordsInsurance === 'all' ? '' : recordsInsurance,
    authStatus: recordsAuthStatus,
    urgency: recordsUrgency,
    activity: recordsActivity,
  };

  const records = useMemo(
    () => sortAuthorizationRecords(alerts.filter(a => matchesAuthorizationRecordFilters(a, filterScope))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [alerts, recordsSearch, recordsInsurance, recordsAuthStatus, recordsUrgency, recordsActivity]
  );

  const activeFilterCount =
    (recordsInsurance !== 'all' ? 1 : 0) +
    (recordsAuthStatus !== 'all' ? 1 : 0) +
    (recordsUrgency !== 'all' ? 1 : 0) +
    (recordsActivity !== 'all' ? 1 : 0);

  const handleClearFilters = () => {
    setRecordsInsurance('all');
    setRecordsAuthStatus('all');
    setRecordsUrgency('all');
    setRecordsActivity('all');
  };

  const chips: FilterChip[] = [];
  if (recordsInsurance !== 'all') {
    chips.push({ key: 'insurance', label: recordsInsurance, onRemove: () => setRecordsInsurance('all') });
  }
  if (recordsAuthStatus !== 'all') {
    chips.push({
      key: 'authStatus',
      label: `Auth Status: ${AUTH_STATUS_OPTIONS.find(o => o.value === recordsAuthStatus)?.label ?? recordsAuthStatus}`,
      onRemove: () => setRecordsAuthStatus('all'),
    });
  }
  if (recordsUrgency !== 'all') {
    chips.push({
      key: 'urgency',
      label: `Urgency: ${URGENCY_OPTIONS.find(o => o.value === recordsUrgency)?.label ?? recordsUrgency}`,
      onRemove: () => setRecordsUrgency('all'),
    });
  }
  if (recordsActivity !== 'all') {
    chips.push({
      key: 'activity',
      label: `Status: ${ACTIVITY_OPTIONS.find(o => o.value === recordsActivity)?.label ?? recordsActivity}`,
      onRemove: () => setRecordsActivity('all'),
    });
  }

  return (
    <section className="space-y-4">
      {/* Toolbar */}
      <Card className="border-border shadow-sm rounded-xl">
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" aria-hidden="true" />
            <Input
              type="text"
              value={recordsSearch}
              onChange={(e) => setRecordsSearch(e.target.value)}
              placeholder="Search by patient name..."
              aria-label="Search authorization records by patient name"
              className="pl-9"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="records-insurance" className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
              Insurance
            </label>
            <Select value={recordsInsurance} onValueChange={setRecordsInsurance}>
              <SelectTrigger id="records-insurance" aria-label="Filter by insurance" className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {insuranceOptions.map(ins => (
                  <SelectItem key={ins} value={ins}>{ins}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="records-auth-status" className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
              Auth Status
            </label>
            <Select value={recordsAuthStatus} onValueChange={setRecordsAuthStatus}>
              <SelectTrigger id="records-auth-status" aria-label="Filter by authorization status" className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTH_STATUS_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="records-urgency" className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
              Urgency
            </label>
            <Select value={recordsUrgency} onValueChange={setRecordsUrgency}>
              <SelectTrigger id="records-urgency" aria-label="Filter by urgency" className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {URGENCY_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="records-activity" className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
              Active / Exhausted
            </label>
            <Select value={recordsActivity} onValueChange={setRecordsActivity}>
              <SelectTrigger id="records-activity" aria-label="Filter by active or exhausted status" className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTIVITY_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <FilterChips chips={chips} onClearAll={handleClearFilters} />

      {/* Results */}
      <Card className="border-border shadow-sm rounded-xl overflow-hidden py-0 gap-0">
        <CardHeader className="border-b border-border px-5 py-4 [.border-b]:pb-4">
          <CardTitle className="text-base font-semibold text-brand-blue">Authorization Records</CardTitle>
          <CardDescription className="text-xs">
            {isLoading ? 'Loading…' : `${records.length} ${records.length === 1 ? 'record' : 'records'}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <div className="flex items-start gap-2.5 p-6 text-sm">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <p className="text-red-700">Unable to load authorization records. Please refresh.</p>
            </div>
          ) : isLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-lg bg-gray-100 animate-pulse" />)}
            </div>
          ) : alerts.length === 0 ? (
            <div className="flex items-start gap-2.5 p-6 text-sm">
              <ShieldCheck className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-muted-foreground">No authorization records found.</p>
            </div>
          ) : records.length === 0 ? (
            <div className="flex items-start gap-2.5 p-6 text-sm">
              <ShieldCheck className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-muted-foreground">No authorization records match the selected filters.</p>
            </div>
          ) : (
            <>
              {/* Mobile cards — below lg */}
              <div className="lg:hidden divide-y divide-gray-100 bg-white">
                {records.map(r => {
                  const completed = getCompletedSessions(r.sessionsAuthorized, r.sessionsRemaining);
                  return (
                    <div key={r.patientId} className="p-4 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-semibold text-sm text-brand-blue">{r.patientName}</p>
                        <UrgencyBadge urgency={r.urgency} />
                      </div>
                      <p className="text-xs text-muted-foreground">{r.insurance || '—'}</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                        <div>
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Auth Period</p>
                          <p className="text-brand-blue">{formatAuthPeriod(r.authPeriod)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Auth Status</p>
                          <StatusBadge status={r.authStatus} />
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Authorized</p>
                          <p className="font-semibold text-brand-blue">{r.sessionsAuthorized ?? '—'}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Completed</p>
                          <p className="text-brand-blue">{completed ?? '—'}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Remaining</p>
                          <p className="font-bold text-brand-gold">{r.sessionsRemaining ?? '—'}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Valid Until</p>
                          <p className="text-brand-blue">{formatDate(r.authValidUntil)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Auth Submitted</p>
                          <p className="text-brand-blue">{formatDate(r.dateAshSubmitted)}</p>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={() => onViewVisits(r.patientId)}
                      >
                        View Visits
                      </Button>
                    </div>
                  );
                })}
              </div>

              {/* Desktop table — lg and up */}
              <div className="hidden lg:block overflow-x-auto">
                <table className="w-full text-sm min-w-full">
                  <thead className="bg-brand-blue/95">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Patient</th>
                      <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Insurance</th>
                      <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Auth Period</th>
                      <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Authorized</th>
                      <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Completed</th>
                      <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Remaining</th>
                      <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Auth Status</th>
                      <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Valid Until</th>
                      <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Auth Submitted</th>
                      <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Urgency</th>
                      <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-white uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-100">
                    {records.map(r => {
                      const completed = getCompletedSessions(r.sessionsAuthorized, r.sessionsRemaining);
                      return (
                        <tr key={r.patientId} className="hover:bg-brand-cream/30 transition-colors">
                          <td className="px-4 py-2.5 text-sm font-semibold text-brand-blue whitespace-nowrap">{r.patientName}</td>
                          <td className="px-4 py-2.5 text-sm text-muted-foreground whitespace-nowrap">{r.insurance || '—'}</td>
                          <td className="px-4 py-2.5 text-sm text-brand-blue whitespace-nowrap">{formatAuthPeriod(r.authPeriod)}</td>
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            {r.sessionsAuthorized != null ? (
                              <span className="font-semibold text-brand-blue">{r.sessionsAuthorized}</span>
                            ) : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            {completed != null ? completed : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            {r.sessionsRemaining != null ? (
                              <span className="font-bold text-brand-gold">{r.sessionsRemaining}</span>
                            ) : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap"><StatusBadge status={r.authStatus} /></td>
                          <td className="px-4 py-2.5 text-sm text-muted-foreground whitespace-nowrap">{formatDate(r.authValidUntil)}</td>
                          <td className="px-4 py-2.5 text-sm text-muted-foreground whitespace-nowrap">{formatDate(r.dateAshSubmitted)}</td>
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap"><UrgencyBadge urgency={r.urgency} /></td>
                          <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                            <Button size="sm" variant="outline" onClick={() => onViewVisits(r.patientId)}>
                              View Visits
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
