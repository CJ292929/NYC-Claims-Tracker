import { Button } from '@/components/ui/button';

export interface FilterChip {
  key: string;
  label: string;
  onRemove: () => void;
}

export function FilterChips({
  chips,
  onClearAll,
}: {
  chips: FilterChip[];
  onClearAll: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-brand-gold/15 text-brand-blue border border-brand-gold/30"
        >
          {chip.label}
          <button
            onClick={chip.onRemove}
            aria-label={`Remove filter: ${chip.label}`}
            className="ml-1 text-brand-blue/60 hover:text-brand-blue"
          >
            ×
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <Button
          variant="link"
          size="sm"
          onClick={onClearAll}
          className="h-auto p-0 text-xs font-semibold text-brand-blue/70 hover:text-brand-blue"
        >
          Clear Filters
        </Button>
      )}
    </div>
  );
}
