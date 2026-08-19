import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

interface SnapshotPatient {
  id: string;
  name: string;
  insurance: string;
  isActive: boolean;
}

interface AlertStatus {
  label: string;
  color: string;
}

/** Read-only "at a glance" preview shown once a patient is selected from a
 *  list — deliberately minimal (no editable tables) so browsing a list never
 *  requires leaving the page. "View Full Records" is the only way to reach
 *  the editable Visits/Claims tables at /visits. */
export function PatientSnapshotPane({
  patient,
  metrics,
  alertStatus,
  onToggleActive,
  togglePending,
  onViewFullRecords,
  emptyStateMessage = 'Select a patient to see their summary.',
}: {
  patient: SnapshotPatient | null;
  metrics: { totalAuthorized: number; completed: number; remaining: number };
  alertStatus: AlertStatus | null;
  onToggleActive: (checked: boolean) => void;
  togglePending: boolean;
  onViewFullRecords: () => void;
  emptyStateMessage?: string;
}) {
  if (!patient) {
    return (
      <div className="h-full min-h-[200px] flex items-center justify-center text-sm text-muted-foreground text-center px-4">
        {emptyStateMessage}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <button onClick={onViewFullRecords} className="group text-left">
            <h3 className="text-xl font-semibold text-brand-blue group-hover:text-brand-gold transition-colors cursor-pointer">
              {patient.name}
            </h3>
          </button>
          <div className="mt-1.5 flex items-center gap-3 flex-wrap text-sm text-muted-foreground">
            <span>Insurance: {patient.insurance}</span>
            <span className="flex items-center gap-2">
              <span className={patient.isActive !== false ? 'text-green-700 font-semibold' : 'text-gray-500 font-semibold'}>
                {patient.isActive !== false ? 'Active' : 'Discharged'}
              </span>
              <Switch
                checked={patient.isActive !== false}
                onCheckedChange={onToggleActive}
                disabled={togglePending}
                aria-label="Toggle patient active status"
              />
            </span>
          </div>
        </div>
        {alertStatus && (
          <Badge role="status" className={`text-xs px-2.5 py-1 rounded-full font-medium ${alertStatus.color}`}>{alertStatus.label}</Badge>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="p-3 bg-brand-cream/40 rounded-lg text-center">
          <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-1">Authorized</p>
          <p className="text-2xl font-bold text-brand-gold">{metrics.totalAuthorized}</p>
        </div>
        <div className="p-3 bg-brand-cream/40 rounded-lg text-center">
          <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-1">Completed</p>
          <p className="text-2xl font-bold text-green-600">{metrics.completed}</p>
        </div>
        <div className="p-3 bg-brand-cream/40 rounded-lg text-center">
          <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-1">Remaining</p>
          <p className="text-2xl font-bold text-brand-blue">{metrics.remaining}</p>
        </div>
      </div>

      <Button
        onClick={onViewFullRecords}
        className="w-full bg-brand-blue hover:bg-brand-blue-dark text-white font-semibold"
      >
        View Full Records &amp; Edit Date ASH Submitted
      </Button>
    </div>
  );
}
