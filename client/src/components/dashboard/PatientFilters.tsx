import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

export interface ClaimStatusFilterDef {
  value: string;
  label: string;
  color: string;
}

export function PatientFilters({
  insuranceList,
  insuranceCounts,
  selectedInsurance,
  onSelectInsurance,
  claimStatusFilters,
  claimStatusCounts,
  selectedClaimsFilter,
  onSelectClaimsFilter,
}: {
  insuranceList: string[];
  insuranceCounts: Record<string, number>;
  selectedInsurance: string;
  onSelectInsurance: (insurance: string) => void;
  claimStatusFilters: ClaimStatusFilterDef[];
  claimStatusCounts: Record<string, number>;
  selectedClaimsFilter: string;
  onSelectClaimsFilter: (value: string) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 px-1">Insurance</h3>
        <div className="max-h-64 overflow-y-auto space-y-0.5 pr-1">
          {insuranceList.map((insurance) => {
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
          })}
        </div>
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
