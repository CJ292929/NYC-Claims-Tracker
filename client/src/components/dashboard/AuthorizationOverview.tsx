import { AlertCircle, AlertTriangle, ArrowRight, Ban, CalendarClock, CalendarX, Clock, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { trpc } from '@/lib/trpc';
import {
  deriveAuthorizationOverviewMetrics,
  getTopAuthorizationAttention,
  AUTH_STATUS_VALUES,
  type AuthorizationOverviewRecord,
} from '@/lib/authorizationOverview';
import { formatAuthPeriod } from '@/lib/authorizationRecordFilters';
import { URGENCY_COLOR } from '@/lib/patientAuthUrgency';
import type { AuthUrgency } from '@shared/authUrgency';

const URGENCY_SHORT_LABEL: Record<AuthUrgency, string> = {
  denied: 'Denied',
  expired: 'Expired',
  exhausted: 'Exhausted',
  critical: 'Critical',
  warning: 'Warning',
  pending: 'Pending',
  ok: 'On Track',
};

function UrgencyBadge({ urgency }: { urgency: AuthUrgency }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${URGENCY_COLOR[urgency]}`}>
      {URGENCY_SHORT_LABEL[urgency]}
    </span>
  );
}

/**
 * Read-only clinic-wide snapshot at /authorizations. Sourced entirely from
 * trpc.visits.authAlerts (the same query Needs Attention and Records use) —
 * no new server query, no mutations. Operational actions stay on
 * /authorizations/attention; full lookup stays on /authorizations/records.
 */
export function AuthorizationOverview({ onNavigate }: { onNavigate: (route: string) => void }) {
  const { data: alerts, isLoading, error } = trpc.visits.authAlerts.useQuery();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-7 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl bg-gray-100 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-border shadow-sm rounded-xl">
        <CardContent className="flex items-start gap-2.5 p-4 text-sm">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <p className="text-red-700">Unable to load authorization overview. Please refresh.</p>
        </CardContent>
      </Card>
    );
  }

  const records: AuthorizationOverviewRecord[] = alerts ?? [];

  if (records.length === 0) {
    return (
      <Card className="border-border shadow-sm rounded-xl">
        <CardContent className="flex items-start gap-2.5 p-4 text-sm">
          <ShieldCheck className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-muted-foreground">No authorization records available.</p>
        </CardContent>
      </Card>
    );
  }

  const metrics = deriveAuthorizationOverviewMetrics(records);
  const topAttention = getTopAuthorizationAttention(records, 5);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <MetricCard
          icon={<AlertTriangle className="w-4 h-4 text-destructive" />}
          label="Needs Attention"
          value={metrics.needsAttention}
          sub={`of ${metrics.totalRecords} patients`}
          tone="destructive"
        />
        <MetricCard
          icon={<Clock className="w-4 h-4 text-brand-blue" />}
          label="Pending"
          value={metrics.pending}
          tone="navy"
        />
        <MetricCard
          icon={<XCircle className="w-4 h-4 text-destructive" />}
          label="Denied"
          value={metrics.denied}
          tone="destructive"
        />
        <MetricCard
          icon={<CalendarX className="w-4 h-4 text-brand-blue" />}
          label="Expired"
          value={metrics.expired}
          sub="Marked expired"
          tone="navy"
        />
        <MetricCard
          icon={<ShieldAlert className="w-4 h-4 text-destructive" />}
          label="Critical"
          value={metrics.critical}
          tone="destructive"
        />
        <MetricCard
          icon={<Ban className="w-4 h-4 text-destructive" />}
          label="Exhausted"
          value={metrics.exhausted}
          tone="destructive"
        />
        <MetricCard
          icon={<CalendarClock className="w-4 h-4 text-brand-gold-dark" />}
          label="Expiring"
          value={metrics.expiring}
          sub="Within 7 days"
          tone="gold"
        />
      </div>

      <Card className="border-border shadow-sm rounded-xl">
        <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-brand-blue text-base">Needs Attention</CardTitle>
            <CardDescription>Highest-priority authorization issues clinic-wide.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => onNavigate('/authorizations/attention')}>
            View All Needs Attention
            <ArrowRight className="w-3.5 h-3.5" />
          </Button>
        </CardHeader>
        <CardContent>
          {topAttention.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-green-700">
              <ShieldCheck className="w-4 h-4 text-green-600 shrink-0" />
              All current authorizations are on track.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {topAttention.map(record => (
                <div key={record.patientId} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="font-semibold text-brand-blue truncate">{record.patientName}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {record.insurance ?? '—'} · {formatAuthPeriod(record.authPeriod)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs font-semibold text-gray-600">
                      {record.periodExpired
                        ? (record.unusedExpiredSessions ? `${record.unusedExpiredSessions} unused · expired` : 'Expired')
                        : record.sessionsRemaining !== null ? `${record.sessionsRemaining} left` : '—'}
                    </span>
                    <UrgencyBadge urgency={record.urgency} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border shadow-sm rounded-xl">
        <CardHeader>
          <CardTitle className="text-brand-blue text-base">Authorization Status Distribution</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {AUTH_STATUS_VALUES.map(status => (
            <div key={status} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
              <StatusBadge status={status} />
              <span className="text-sm font-semibold text-brand-blue">{metrics.statusDistribution[status]}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button
          onClick={() => onNavigate('/authorizations/attention')}
          className="bg-brand-blue text-white hover:bg-brand-blue-dark"
        >
          View Needs Attention
        </Button>
        <Button variant="outline" onClick={() => onNavigate('/authorizations/records')}>
          View Authorization Records
        </Button>
      </div>
    </div>
  );
}
