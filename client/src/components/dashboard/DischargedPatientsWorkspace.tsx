import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Search, SlidersHorizontal, UserX, X } from 'lucide-react';
import { formatCalendarDate } from '@/lib/date';
import { PatientFilters, type ClaimStatusFilterDef } from './PatientFilters';
import { PatientListItem } from './PatientListItem';
import { PatientSnapshotPane } from './PatientSnapshotPane';

interface DischargedPatient {
  id: string;
  name: string;
  insurance: string;
  claimsStatus: string;
  isActive: boolean;
  dischargeDate: number | null;
  dischargeReason: string | null;
}

/** Dedicated workspace for discharged patients — a search + list + read-only
 *  snapshot, deliberately not sharing the active-patient list or its
 *  selection state with Patient Records. Selecting a discharged patient only
 *  ever lands on the summary pane, never the full-records page directly, and
 *  never mutates discharge status (the Active/Discharged switch in the
 *  snapshot pane is the only reactivation path, same as everywhere else). */
export function DischargedPatientsWorkspace({
  patients,
  searchQuery,
  onSearchQueryChange,
  insuranceList,
  historicalInsuranceList,
  insuranceCounts,
  selectedInsurance,
  onSelectInsurance,
  claimStatusFilters,
  claimStatusCounts,
  selectedClaimsFilter,
  onSelectClaimsFilter,
  showFilters,
  onShowFiltersChange,
  activeFilterCount,
  onClearFilters,
  selectedPatientId,
  onSelectPatient,
  snapshotPatient,
  snapshotMetrics,
  snapshotAlertStatus,
  onToggleActive,
  togglePending,
  onViewFullRecords,
}: {
  patients: DischargedPatient[];
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  insuranceList: string[];
  historicalInsuranceList?: string[];
  insuranceCounts: Record<string, number>;
  selectedInsurance: string;
  onSelectInsurance: (insurance: string) => void;
  claimStatusFilters: ClaimStatusFilterDef[];
  claimStatusCounts: Record<string, number>;
  selectedClaimsFilter: string;
  onSelectClaimsFilter: (value: string) => void;
  showFilters: boolean;
  onShowFiltersChange: (open: boolean) => void;
  activeFilterCount: number;
  onClearFilters: () => void;
  selectedPatientId: string | null;
  onSelectPatient: (id: string) => void;
  snapshotPatient: DischargedPatient | null;
  snapshotMetrics: { totalAuthorized: number; completed: number; remaining: number };
  snapshotAlertStatus: { label: string; color: string } | null;
  onToggleActive: (checked: boolean) => void;
  togglePending: boolean;
  onViewFullRecords: () => void;
}) {
  const query = searchQuery.trim().toLowerCase();
  const visiblePatients = query ? patients.filter(p => p.name.toLowerCase().includes(query)) : patients;

  return (
    <section>
      <Card className="border-border shadow-sm rounded-xl overflow-hidden py-0 gap-0">
        <CardHeader className="border-b border-border px-5 py-4 [.border-b]:pb-4">
          <CardTitle className="text-base font-semibold text-brand-blue">Discharged Patients</CardTitle>
          <CardDescription className="text-xs">Review patients no longer in active care</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="lg:grid lg:grid-cols-[320px_minmax(0,1fr)]">
            {/* Discharged Patient List */}
            <div className="border-r border-border p-4 space-y-3 max-h-[720px] overflow-y-auto">
              <div>
                <h3 className="text-sm font-semibold text-brand-blue mb-0.5">Discharged</h3>
                <p className="text-xs text-muted-foreground mb-3">{visiblePatients.length} discharged patient{visiblePatients.length === 1 ? '' : 's'}</p>

                <div className="space-y-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" aria-hidden="true" />
                    <Input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => onSearchQueryChange(e.target.value)}
                      placeholder="Search discharged patients..."
                      aria-label="Search discharged patients by name"
                      className="pl-9 pr-9"
                    />
                    {searchQuery !== '' && (
                      <button
                        type="button"
                        onClick={() => onSearchQueryChange('')}
                        aria-label="Clear search"
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  <Sheet open={showFilters} onOpenChange={onShowFiltersChange}>
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
                      <div className="px-4 pb-4">
                        <PatientFilters
                          insuranceList={insuranceList}
                          historicalInsuranceList={historicalInsuranceList}
                          insuranceCounts={insuranceCounts}
                          selectedInsurance={selectedInsurance}
                          onSelectInsurance={onSelectInsurance}
                          claimStatusFilters={claimStatusFilters}
                          claimStatusCounts={claimStatusCounts}
                          selectedClaimsFilter={selectedClaimsFilter}
                          onSelectClaimsFilter={onSelectClaimsFilter}
                        />
                      </div>
                      <SheetFooter>
                        <Button variant="outline" onClick={onClearFilters} disabled={activeFilterCount === 0}>
                          Clear Filters
                        </Button>
                      </SheetFooter>
                    </SheetContent>
                  </Sheet>
                </div>
              </div>

              <div className="space-y-1 max-h-[560px] overflow-y-auto">
                {visiblePatients.length > 0 ? visiblePatients.map(patient => (
                  <PatientListItem
                    key={patient.id}
                    name={patient.name}
                    insurance={patient.insurance}
                    isActive={selectedPatientId === patient.id}
                    tone="muted"
                    trailing={<UserX className="w-4 h-4 text-gray-400" />}
                    onSelect={() => onSelectPatient(patient.id)}
                    meta={
                      <>
                        {patient.dischargeDate && (
                          <p className="text-xs text-gray-400 mt-0.5">
                            Discharged: {formatCalendarDate(patient.dischargeDate)}
                          </p>
                        )}
                        {patient.dischargeReason && (
                          <p className="text-xs text-gray-400 truncate">Reason: {patient.dischargeReason}</p>
                        )}
                      </>
                    }
                  />
                )) : (
                  <div className="p-4 text-center text-muted-foreground text-sm">
                    {searchQuery.trim() ? 'No discharged patients match your search.' : 'No discharged patients.'}
                  </div>
                )}
              </div>
            </div>

            {/* Patient Detail — snapshot only, never full records directly */}
            <div className="p-5">
              <PatientSnapshotPane
                patient={snapshotPatient}
                metrics={snapshotMetrics}
                alertStatus={snapshotAlertStatus}
                onToggleActive={onToggleActive}
                togglePending={togglePending}
                onViewFullRecords={onViewFullRecords}
                emptyStateMessage="Select a discharged patient to view their information."
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
