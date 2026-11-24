import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import type { AuthAlertInsuranceOption } from '@/lib/authAlertInsuranceFilter';

/**
 * Searchable insurance selector for the Authorization Alerts queue. Search
 * matches the insurer's current name or any catalog alias (old names), so
 * typing a pre-rename name still finds the entry. '' = All Insurances.
 * Counts are actionable alerts per insurer.
 */
export function AuthAlertInsuranceFilter({
  options,
  selected,
  totalCount,
  onSelect,
}: {
  options: AuthAlertInsuranceOption[];
  /** Canonical selected name ('' = all). */
  selected: string;
  /** Actionable alerts across all insurances (the "All Insurances" count). */
  totalCount: number;
  onSelect: (insurance: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (value: string) => { onSelect(value); setOpen(false); };
  const catalog = options.filter(o => !o.historical);
  const historical = options.filter(o => o.historical);
  const item = (o: AuthAlertInsuranceOption) => (
    <CommandItem key={o.name} value={o.name} keywords={o.aliases} onSelect={() => pick(o.name)} className="text-xs">
      <Check className={`w-3.5 h-3.5 ${selected === o.name ? 'opacity-100' : 'opacity-0'}`} />
      <span className="flex-1 min-w-0 truncate">{o.name}</span>
      <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-700">{o.count}</span>
    </CommandItem>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={`Filter authorization alerts by insurance: ${selected || 'All Insurances'}`}
          className="h-8 w-full sm:w-56 justify-between text-xs font-medium text-brand-blue"
        >
          <span className="truncate">{selected || 'All Insurances'}</span>
          <ChevronsUpDown className="w-3.5 h-3.5 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(18rem,calc(100vw-2rem))] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search insurers" aria-label="Search insurance companies" className="text-base sm:text-sm" />
          <CommandList>
            <CommandEmpty>No insurers match.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__all__" keywords={['All Insurances']} onSelect={() => pick('')} className="text-xs">
                <Check className={`w-3.5 h-3.5 ${selected === '' ? 'opacity-100' : 'opacity-0'}`} />
                <span className="flex-1">All Insurances</span>
                <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-700">{totalCount}</span>
              </CommandItem>
            </CommandGroup>
            {catalog.length > 0 && <CommandGroup heading="Insurance companies">{catalog.map(item)}</CommandGroup>}
            {historical.length > 0 && (
              <CommandGroup heading="Historical insurers (not in catalog)">{historical.map(item)}</CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
