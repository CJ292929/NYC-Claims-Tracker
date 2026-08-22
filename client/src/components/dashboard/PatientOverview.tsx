import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, ClipboardList, UserCheck, UserX, Users } from 'lucide-react';
import { AuthAlertPanel } from './AuthAlertPanel';
import { MetricCard } from './MetricCard';
import { PatientListItem } from './PatientListItem';

interface OverviewPatient {
  id: string;
  name: string;
  insurance: string;
  isActive: boolean;
}

/** "What is the current state of our patient population?" — a patient-
 *  management-oriented summary built entirely from data the app already
 *  loads (patients list, completed-session ids, insurance counts). It does
 *  not duplicate the cross-functional Dashboard: no claims follow-up, no
 *  session-progress charts, just population-level counts and where to go
 *  next (recent patients, insurance mix, authorization attention). */
export function PatientOverview({
  totalPatients,
  activePatients,
  completedPatients,
  dischargedPatients,
  insuranceCounts,
  recentPatients,
  onSelectPatient,
  onSelectAuthAlertPatient,
}: {
  totalPatients: number;
  activePatients: number;
  completedPatients: number;
  dischargedPatients: number;
  insuranceCounts: Record<string, number>;
  recentPatients: OverviewPatient[];
  onSelectPatient: (id: string) => void;
  onSelectAuthAlertPatient: (id: string) => void;
}) {
  const insuranceDistribution = Object.entries(insuranceCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const maxInsuranceCount = insuranceDistribution.length > 0 ? insuranceDistribution[0][1] : 0;

  return (
    <div className="space-y-6">
      {/* ─── Population summary ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard icon={<Users className="w-4 h-4 text-brand-blue" />} label="Total Patients" value={totalPatients} tone="navy" />
        <MetricCard icon={<UserCheck className="w-4 h-4 text-green-600" />} label="Active Patients" value={activePatients} sub="Sessions remaining" tone="navy" />
        <MetricCard icon={<CheckCircle2 className="w-4 h-4 text-brand-gold-dark" />} label="Completed Patients" value={completedPatients} sub="Sessions exhausted" tone="gold" />
        <MetricCard icon={<UserX className="w-4 h-4 text-gray-500" />} label="Discharged Patients" value={dischargedPatients} tone="navy" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 xl:gap-6">
        {/* ─── Recent Patients ────────────────────────────────────────────── */}
        <div className="lg:col-span-5">
          <Card className="border-border shadow-sm rounded-xl overflow-hidden py-0 gap-0 h-full">
            <CardHeader className="border-b border-border px-5 py-4 [.border-b]:pb-4">
              <CardTitle className="text-base font-semibold text-brand-blue">Recently Added</CardTitle>
              <CardDescription className="text-xs">Most recently added patients</CardDescription>
            </CardHeader>
            <CardContent className="p-3">
              {recentPatients.length > 0 ? (
                <div className="space-y-1">
                  {recentPatients.map((patient) => (
                    <PatientListItem
                      key={patient.id}
                      name={patient.name}
                      insurance={patient.insurance}
                      isActive={false}
                      onSelect={() => onSelectPatient(patient.id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="p-4 text-center text-muted-foreground text-sm">No patients yet.</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ─── Insurance distribution ─────────────────────────────────────── */}
        <div className="lg:col-span-7">
          <Card className="border-border shadow-sm rounded-xl overflow-hidden py-0 gap-0 h-full">
            <CardHeader className="border-b border-border px-5 py-4 [.border-b]:pb-4">
              <CardTitle className="text-base font-semibold text-brand-blue flex items-center gap-2">
                <ClipboardList className="w-4 h-4" />
                Insurance Distribution
              </CardTitle>
              <CardDescription className="text-xs">Active patients by insurance</CardDescription>
            </CardHeader>
            <CardContent className="p-5">
              {insuranceDistribution.length > 0 ? (
                <div className="space-y-2.5">
                  {insuranceDistribution.map(([insurance, count]) => (
                    <div key={insurance} className="flex items-center gap-3">
                      <span className="text-xs text-brand-blue font-medium w-40 sm:w-48 truncate shrink-0">{insurance}</span>
                      <div className="flex-1 h-2 rounded-full bg-brand-cream overflow-hidden">
                        <div
                          className="h-full rounded-full bg-brand-blue"
                          style={{ width: `${maxInsuranceCount > 0 ? (count / maxInsuranceCount) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground w-6 text-right shrink-0">{count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4 text-center text-muted-foreground text-sm">No active patients yet.</div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ─── Authorization attention summary ────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Needs Authorization Attention</h2>
        <AuthAlertPanel onSelectPatient={onSelectAuthAlertPatient} />
      </div>
    </div>
  );
}
