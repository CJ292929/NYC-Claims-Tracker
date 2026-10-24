import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { CheckCircle2, Search, SlidersHorizontal, X } from 'lucide-react';
import { PatientFilters, type ClaimStatusFilterDef } from './PatientFilters';
import { PatientListItem } from './PatientListItem';
import { PatientSnapshotPane } from './PatientSnapshotPane';

interface RecordsPatient {
  id: string;
  name: string;
  insurance: string;
  claimsStatus?: string;
  isActive: boolean;
}

/** The primary patient browsing/management workspace: search, filters, the
 *  active patient list, the Completed Sessions folder, and a read-only
 *  snapshot preview of whichever patient is selected. Deliberately does not
 *  auto-select a patient on load — the snapshot starts empty until staff
 *  explicitly pick someone. */
export function PatientRecordsWorkspace({
  insuranceList,
  historicalInsuranceList,
  insuranceCounts,
  selectedInsurance,
  onSelectInsurance,
  claimStatusFilters,
  claimStatusCounts,
  selectedClaimsFilter,
  onSelectClaimsFilter,
  searchQuery,
  onSearchQueryChange,
  showMobileFilters,
  onShowMobileFiltersChange,
  activeFilterCount,
  onClearFilters,
  filteredPatients,
  completedPatients,
  selectedPatientId,
  onSelectPatient,
  onDeletePatient,
  snapshotPatient,
  snapshotMetrics,
  snapshotAlertStatus,
  onToggleActive,
  togglePending,
  onViewFullRecords,
}: {
  insuranceList: string[];
  historicalInsuranceList?: string[];
  insuranceCounts: Record<string, number>;
  selectedInsurance: string;
  onSelectInsurance: (insurance: string) => void;
  claimStatusFilters: ClaimStatusFilterDef[];
  claimStatusCounts: Record<string, number>;
  selectedClaimsFilter: string;
  onSelectClaimsFilter: (value: string) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  showMobileFilters: boolean;
  onShowMobileFiltersChange: (open: boolean) => void;
  activeFilterCount: number;
  onClearFilters: () => void;
  filteredPatients: RecordsPatient[];
  completedPatients: RecordsPatient[];
  selectedPatientId: string | null;
  onSelectPatient: (id: string) => void;
  onDeletePatient: (id: string, name: string) => void;
  snapshotPatient: RecordsPatient | null;
  snapshotMetrics: { totalAuthorized: number; completed: number; remaining: number };
  snapshotAlertStatus: { label: string; color: string } | null;
  onToggleActive: (checked: boolean) => void;
  togglePending: boolean;
  onViewFullRecords: () => void;
}) {
  const filtersPanel = (
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
  );

  return (
    <section>
      <Card className="border-border shadow-sm rounded-xl overflow-hidden py-0 gap-0">
        <CardHeader className="border-b border-border px-5 py-4 [.border-b]:pb-4">
          <CardTitle className="text-base font-semibold text-brand-blue">Patient Records</CardTitle>
          <CardDescription className="text-xs">Find and select a patient to view their information</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="lg:grid lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[260px_320px_minmax(0,1fr)]">
            {/* Filters — xl+ only; below xl uses the Filters sheet */}
            <div className="hidden xl:block border-r border-border p-4 max-h-[720px] overflow-y-auto">
              {filtersPanel}
            </div>

            {/* Patient List */}
            <div className="border-r border-border p-4 space-y-4 max-h-[720px] overflow-y-auto">
              <div>
                <h3 className="text-sm font-semibold text-brand-blue mb-0.5">Patients</h3>
                <p className="text-xs text-muted-foreground mb-3">{filteredPatients.length} in {selectedInsurance || 'all insurances'}</p>

                {/* Search + mobile filters control */}
                <div className="mb-3 space-y-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" aria-hidden="true" />
                    <Input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => onSearchQueryChange(e.target.value)}
                      placeholder="Search patients..."
                      aria-label="Search patients by name"
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

                  <div className="xl:hidden">
                    <Sheet open={showMobileFilters} onOpenChange={onShowMobileFiltersChange}>
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
                        <div className="px-4 pb-4">{filtersPanel}</div>
                        <SheetFooter>
                          <Button variant="outline" onClick={onClearFilters} disabled={activeFilterCount === 0}>
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
                        isActive={selectedPatientId === patient.id}
                        claimsStatus={patient.claimsStatus}
                        onSelect={() => onSelectPatient(patient.id)}
                        onDelete={() => onDeletePatient(patient.id, patient.name)}
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
                <Card className="border-green-200 shadow-sm py-0 gap-0 overflow-hidden">
                  <CardHeader className="bg-green-700 text-white py-2.5 px-3 [.border-b]:pb-2.5">
                    <CardTitle className="text-xs flex items-center gap-2 font-semibold">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Completed Sessions
                      <Badge className="bg-white text-green-700 text-[10px] ml-auto">{completedPatients.length}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {completedPatients.map(patient => (
                        <PatientListItem
                          key={patient.id}
                          name={patient.name}
                          insurance={patient.insurance}
                          isActive={selectedPatientId === patient.id}
                          tone="success"
                          trailing={<CheckCircle2 className="w-4 h-4 text-green-500" />}
                          onSelect={() => onSelectPatient(patient.id)}
                        />
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Patient Detail — the dominant workspace area */}
            <div className="p-5">
              <PatientSnapshotPane
                patient={snapshotPatient}
                metrics={snapshotMetrics}
                alertStatus={snapshotAlertStatus}
                onToggleActive={onToggleActive}
                togglePending={togglePending}
                onViewFullRecords={onViewFullRecords}
                emptyStateMessage="Select a patient to view their information."
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
