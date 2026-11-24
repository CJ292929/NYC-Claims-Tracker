import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  AlertCircle,
  Clock,
  BellRing,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  XCircle,
  CalendarX,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { URGENCY_SORT_ORDER } from '@/lib/authorizationRecordFilters';
import { ApproveAuthorizationDialog, AuthorizationActionButtons, useMarkAuthorizationRequested, type ApproveTarget } from './AuthorizationActions';
import { HoldAuthorizationRequestDialog, HoldRequestButton, type HoldTarget } from './AuthorizationHold';
import { AuthAlertInsuranceFilter } from './AuthAlertInsuranceFilter';
import {
  actionableAuthorizationAlerts,
  authAlertInsuranceOptions,
  canonicalInsurerSelection,
  matchesInsurerSelection,
} from '@/lib/authAlertInsuranceFilter';

const URGENCY_CONFIG = {
  denied: {
    label: 'Authorization Denied',
    sublabel: 'Authorization requires attention',
    icon: <AlertCircle className="w-4 h-4" />,
    cardClass: 'border-l-4 border-red-600 bg-red-50',
    badgeClass: 'bg-red-100 text-red-700',
    iconClass: 'text-red-700',
  },
  // P4-P31: manually marked Expired — not Denied, not Sessions Exhausted.
  expired: {
    label: 'Authorization Expired',
    sublabel: 'Request a new authorization',
    icon: <CalendarX className="w-4 h-4" />,
    cardClass: 'border-l-4 border-slate-500 bg-slate-50',
    badgeClass: 'bg-slate-200 text-slate-800',
    iconClass: 'text-slate-600',
  },
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

export function AuthAlertPanel({
  onSelectPatient,
  insurance = '',
  onInsuranceChange,
}: {
  onSelectPatient: (id: string) => void;
  /** URL-held insurance selection ('' = All Insurances). */
  insurance?: string;
  /** Present = show the insurance selector; receives the new selection. */
  onInsuranceChange?: (insurance: string) => void;
}) {
  const { data: alerts = [], isLoading, error } = trpc.visits.authAlerts.useQuery();
  // Same shared catalog query the Dashboard uses (react-query dedupes it).
  const { data: insurerCatalog = [] } = trpc.insurance.list.useQuery(undefined, { enabled: !!onInsuranceChange });
  const { requestingId, markRequested } = useMarkAuthorizationRequested();
  const [approveDialogPatient, setApproveDialogPatient] = useState<ApproveTarget | null>(null);
  const [holdTarget, setHoldTarget] = useState<HoldTarget | null>(null);

  // Only actionable rows: needs attention, not on hold, not discharged (the
  // same classification the Authorization Attention count uses).
  const actionable = actionableAuthorizationAlerts(alerts);
  const selected = onInsuranceChange ? canonicalInsurerSelection(insurance, insurerCatalog) : '';
  const urgent = actionable
    .filter(a => matchesInsurerSelection(a.insurance, selected, insurerCatalog))
    .sort((a, b) => {
      return URGENCY_SORT_ORDER[a.urgency] - URGENCY_SORT_ORDER[b.urgency];
    });
  const filtered = selected !== '';

  return (
    <Card className="border-border shadow-sm rounded-xl h-full flex flex-col py-0 gap-0 overflow-hidden">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border px-4 py-3 shrink-0 [.border-b]:pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-brand-blue">
          <BellRing className="w-4 h-4 text-brand-gold" />
          Authorization Alerts
        </CardTitle>
        {urgent.length > 0 && (
          <Badge
            variant="destructive"
            className="rounded-full min-w-5 h-5 px-1.5 justify-center"
            aria-label={filtered ? `${urgent.length} alerts for ${selected}` : `${urgent.length} alerts`}
          >
            {urgent.length}
          </Badge>
        )}
      </CardHeader>
      {onInsuranceChange && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 border-b border-border px-4 py-2 shrink-0">
          <AuthAlertInsuranceFilter
            options={authAlertInsuranceOptions(alerts, insurerCatalog, selected)}
            selected={selected}
            totalCount={actionable.length}
            onSelect={onInsuranceChange}
          />
          {/* Filtered count is labelled apart from the global (all insurances) total. */}
          <p role="status" className="text-xs text-muted-foreground">
            {filtered
              ? `Showing ${urgent.length} of ${actionable.length} alerts (filtered: ${selected})`
              : `${actionable.length} alerts, all insurances`}
          </p>
        </div>
      )}
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
        ) : urgent.length === 0 && filtered ? (
          <div className="flex items-start gap-2.5 p-4 text-sm">
            <ShieldCheck className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-muted-foreground">No authorization alerts for {selected}.</p>
              <button type="button" className="text-xs underline text-brand-blue" onClick={() => onInsuranceChange?.('')}>
                Show all insurances ({actionable.length})
              </button>
            </div>
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
                          {alert.periodExpired ? (
                            <span className="shrink-0 text-xs font-semibold text-slate-600">
                              {alert.unusedExpiredSessions > 0 ? `${alert.unusedExpiredSessions} unused · expired` : 'Expired'}
                            </span>
                          ) : alert.sessionsRemaining !== null && (
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
                  <AuthorizationActionButtons
                    className="px-3 pb-1.5 flex gap-2"
                    authPending={alreadyPending}
                    requesting={isRequesting}
                    onMarkRequested={() => markRequested(alert.patientId)}
                    onApprove={() => setApproveDialogPatient({ id: alert.patientId, name: alert.patientName, insurance: alert.insurance ?? '' })}
                  />
                  <div className="px-3 pb-2.5">
                    <HoldRequestButton
                      className="h-7 text-xs w-full"
                      onClick={() => setHoldTarget({ patientId: alert.patientId, patientName: alert.patientName, authPeriod: alert.authPeriod })}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <ApproveAuthorizationDialog target={approveDialogPatient} onClose={() => setApproveDialogPatient(null)} />
      <HoldAuthorizationRequestDialog target={holdTarget} onClose={() => setHoldTarget(null)} />
    </Card>
  );
}
