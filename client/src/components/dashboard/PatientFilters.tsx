import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

export interface ClaimStatusFilterDef {
  value: string;
  label: string;
  color: string;
}

export function PatientFilters({
  insuranceList,
  historicalInsuranceList = [],
  insuranceCounts,
  selectedInsurance,
  onSelectInsurance,
  claimStatusFilters,
  claimStatusCounts,
  selectedClaimsFilter,
  onSelectClaimsFilter,
}: {
  insuranceList: string[];
  /** Recorded insurers not in the catalog (e.g. permanently deleted, P4-P22)
   *  — filter-only, shown apart from catalog companies; see
   *  historicalInsurerNames in client/src/lib/patientFilters.ts. */
  historicalInsuranceList?: string[];
  insuranceCounts: Record<string, number>;
  selectedInsurance: string;
  onSelectInsurance: (insurance: string) => void;
  claimStatusFilters: ClaimStatusFilterDef[];
  claimStatusCounts: Record<string, number>;
  selectedClaimsFilter: string;
  onSelectClaimsFilter: (value: string) => void;
}) {
  const renderInsurance = (insurance: string) => {
    const isSelected = selectedInsurance === insurance;
    const count = insuranceCounts[insurance] ?? 0;
    return (
      <Button
        key={insurance}
        variant="ghost"
        onClick={() => onSelectInsurance(insurance)}
        aria-pressed={isSelected}
        className={`w-full h-auto justify-between px-2.5 py-2 text-xs font-medium ${
          isSelected ? 'bg-brand-gold text-white hover:bg-brand-gold hover:text-white' : 'text-brand-blue hover:bg-brand-cream'
        }`}
      >
        <span className="truncate text-left">{insurance}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ml-1 shrink-0 ${
          isSelected ? 'bg-white/25 text-white' : 'bg-gray-100 text-gray-700'
        }`}>{count}</span>
      </Button>
    );
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 px-1">Insurance</h3>
        <div className="max-h-64 overflow-y-auto space-y-0.5 pr-1">
          {insuranceList.map(renderInsurance)}
        </div>
        {historicalInsuranceList.length > 0 && (
          <div className="mt-3">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-1">Historical insurers</h4>
            <p className="text-[11px] text-muted-foreground mb-1.5 px-1">Recorded on patients, not in the insurance catalog</p>
            <div className="max-h-40 overflow-y-auto space-y-0.5 pr-1">
              {historicalInsuranceList.map(renderInsurance)}
            </div>
          </div>
        )}
      </div>

      <Separator />

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 px-1">Claims Status</h3>
        <div className="max-h-64 overflow-y-auto space-y-0.5 pr-1">
          {claimStatusFilters.map(({ value, label, color }) => {
            const isSelected = selectedClaimsFilter === value;
            const count = claimStatusCounts[value] ?? 0;
            return (
              <Button
                key={value}
                variant="ghost"
                onClick={() => onSelectClaimsFilter(value)}
                aria-pressed={isSelected}
                className={`w-full h-auto justify-between px-2.5 py-2 text-xs ${
                  isSelected ? 'bg-brand-gold text-white font-semibold hover:bg-brand-gold hover:text-white' : 'text-brand-blue hover:bg-brand-cream'
                }`}
              >
                <span className="truncate text-left">{label}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ml-1 shrink-0 ${
                  isSelected ? 'bg-white/25 text-white' : color
                }`}>{count}</span>
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
