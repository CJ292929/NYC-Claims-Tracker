/**
 * P4-P32: the "Sessions Authorized" section of Edit Patient Details. Session
 * counts belong to authorization periods, so this section never edits a
 * patient field and is saved separately from the patient form:
 *
 *   * no period yet (patient created while awaiting approval): the count is
 *     shown as not set, and "Record Initial Authorization" opens the shared
 *     New Authorization dialog in initial mode once approval is received.
 *   * each existing period: its authorized / completed / remaining counts and
 *     a Correct Count control (refused for an Expired period).
 */
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getPeriodMetrics, type AuthPeriodVisit } from '@shared/authPeriodMetrics';
import { CorrectPeriodCountControl } from './AuthorizationActions';

export function AuthorizationSessionsSection({
  patientId,
  patientName,
  visits,
  loading,
  onRecordInitial,
}: {
  patientId: string;
  patientName: string;
  visits: AuthPeriodVisit[];
  loading: boolean;
  onRecordInitial: () => void;
}) {
  const periods = Array.from(new Set(visits.map(v => v.authPeriod ?? 1))).sort((a, b) => b - a);

  return (
    <section aria-labelledby="edit-patient-sessions-heading" className="rounded-lg border border-brand-cream-dark p-3 space-y-3">
      <div>
        <h3 id="edit-patient-sessions-heading" className="text-brand-blue font-semibold text-sm">Sessions Authorized</h3>
        <p className="text-xs text-muted-foreground">
          Counts belong to each authorization period and are saved on their own, not with Save Changes.
        </p>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading authorization periods…
        </p>
      ) : periods.length === 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-gray-700">
            <span className="font-semibold">Not set.</span> No authorization has been recorded for this patient yet.
            Leave it unset while approval is pending.
          </p>
          <Button
            type="button"
            size="sm"
            onClick={onRecordInitial}
            className="w-full sm:w-auto bg-green-600 hover:bg-green-700 text-white"
          >
            <ShieldCheck className="w-4 h-4" /> Record Initial Authorization
          </Button>
        </div>
      ) : (
        <ul className="space-y-2">
          {periods.map(period => {
            const periodVisits = visits.filter(v => (v.authPeriod ?? 1) === period);
            const m = getPeriodMetrics(periodVisits, period);
            return (
              <li key={period} className="flex flex-col gap-2 rounded-md bg-slate-50 p-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="font-semibold text-brand-blue">
                    Period {period}
                    {m.expired && <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-700">Expired</span>}
                  </p>
                  <p className="text-xs text-slate-600">
                    {m.authorized} authorized · {m.completed} completed · {m.remaining} remaining
                    {m.unusedExpired > 0 ? ` · ${m.unusedExpired} unused` : ''}
                  </p>
                </div>
                <CorrectPeriodCountControl
                  patientId={patientId}
                  patientName={patientName}
                  period={period}
                  authorized={m.authorized}
                  completed={m.completed}
                  sessionRows={periodVisits.length}
                  expired={m.expired}
                  className="w-full sm:w-auto"
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
