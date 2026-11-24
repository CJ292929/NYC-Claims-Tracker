import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { searchInsuranceOptions } from '@/lib/patientFilters';

export interface ClaimStatusFilterDef {
  value: string;
  label: string;
  color: string;
}

export function PatientFilters({
  insuranceList,
  historicalInsuranceList = [],
  insuranceAliases = {},
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
  /** Catalog aliases by insurer name — searching an old name finds its entry. */
  insuranceAliases?: Record<string, string[]>;
  insuranceCounts: Record<string, number>;
  selectedInsurance: string;
  onSelectInsurance: (insurance: string) => void;
  claimStatusFilters: ClaimStatusFilterDef[];
  claimStatusCounts: Record<string, number>;
  selectedClaimsFilter: string;
  onSelectClaimsFilter: (value: string) => void;
}) {
  // Search narrows only which options are shown. Selection and counts are
  // untouched, and the selected option stays visible (searchInsuranceOptions).
  const [insuranceQuery, setInsuranceQuery] = useState('');
  const searchId = useId();
  const optionsRef = useRef<HTMLDivElement>(null);
  const visibleCatalog = searchInsuranceOptions(insuranceList, insuranceQuery, insuranceAliases, selectedInsurance);
  const visibleHistorical = searchInsuranceOptions(historicalInsuranceList, insuranceQuery, {}, selectedInsurance);
  const noMatches = insuranceQuery.trim() !== '' && visibleCatalog.length === 0 && visibleHistorical.length === 0;

  const optionButtons = () =>
    Array.from(optionsRef.current?.querySelectorAll<HTMLButtonElement>('button[data-insurance-option]') ?? []);
  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); optionButtons()[0]?.focus(); }
    if (e.key === 'Escape' && insuranceQuery) { e.preventDefault(); e.stopPropagation(); setInsuranceQuery(''); }
  };
  const onOptionsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const buttons = optionButtons();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === 'Home') return buttons[0]?.focus();
    if (e.key === 'End') return buttons[buttons.length - 1]?.focus();
    if (e.key === 'ArrowUp' && i === 0) return document.getElementById(searchId)?.focus();
    buttons[Math.min(buttons.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  const renderInsurance = (insurance: string) => {
    const isSelected = selectedInsurance === insurance;
    const count = insuranceCounts[insurance] ?? 0;
    return (
      <Button
        key={insurance}
        data-insurance-option
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
        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" aria-hidden />
          <Input
            id={searchId}
            type="search"
            value={insuranceQuery}
            onChange={(e) => setInsuranceQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search insurers"
            aria-label="Search insurance companies"
            className="h-9 pl-8 pr-8 text-base sm:text-xs"
          />
          {insuranceQuery && (
            <button
              type="button"
              onClick={() => setInsuranceQuery('')}
              aria-label="Clear insurer search"
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-muted-foreground hover:text-brand-blue focus-visible:outline-2 focus-visible:outline-brand-gold"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div ref={optionsRef} onKeyDown={onOptionsKeyDown}>
          <div className="max-h-64 overflow-y-auto space-y-0.5 pr-1">
            {visibleCatalog.map(renderInsurance)}
          </div>
          {visibleHistorical.length > 0 && (
            <div className="mt-3">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-1">Historical insurers</h4>
              <p className="text-[11px] text-muted-foreground mb-1.5 px-1">Recorded on patients, not in the insurance catalog</p>
              <div className="max-h-40 overflow-y-auto space-y-0.5 pr-1">
                {visibleHistorical.map(renderInsurance)}
              </div>
            </div>
          )}
        </div>
        {noMatches && (
          <p role="status" className="px-1 py-2 text-xs text-muted-foreground">
            No insurers match “{insuranceQuery.trim()}”.{' '}
            <button type="button" className="underline text-brand-blue" onClick={() => setInsuranceQuery('')}>Clear search</button>
          </p>
        )}
      </div>

      {/* Empty for non-Super-Admins (P4-P23): Claims status is claim data. */}
      {claimStatusFilters.length > 0 && (<>
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
      </>)}
    </div>
  );
}
