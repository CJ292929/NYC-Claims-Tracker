import type { ReactNode, MouseEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import { cn } from '@/lib/utils';

const TONE = {
  default: {
    row: 'hover:bg-brand-cream',
    rowActive: 'bg-brand-blue border-l-4 border-brand-gold',
    name: 'text-brand-blue hover:text-brand-gold',
    nameActive: 'text-white',
    meta: 'text-muted-foreground',
    metaActive: 'text-white/80',
    border: '',
  },
  success: {
    row: 'border-b border-green-100 hover:bg-green-50',
    rowActive: 'bg-green-50 border-l-4 border-l-green-500',
    name: 'text-green-800 hover:text-green-600',
    nameActive: 'text-green-800',
    meta: 'text-green-600',
    metaActive: 'text-green-600',
    border: '',
  },
  muted: {
    row: 'border-b border-gray-100 hover:bg-gray-50',
    rowActive: 'bg-gray-100 border-l-4 border-l-gray-500',
    name: 'text-gray-700 hover:text-gray-500',
    nameActive: 'text-gray-700',
    meta: 'text-gray-500',
    metaActive: 'text-gray-500',
    border: '',
  },
} as const;

export function PatientListItem({
  name,
  insurance,
  isActive,
  claimsStatus,
  meta,
  trailing,
  onSelect,
  onDelete,
  tone = 'default',
}: {
  name: string;
  insurance: string;
  isActive: boolean;
  claimsStatus?: string | null;
  meta?: ReactNode;
  trailing?: ReactNode;
  onSelect: () => void;
  onDelete?: () => void;
  tone?: 'default' | 'success' | 'muted';
}) {
  const t = TONE[tone];
  return (
    <div
      className={cn(
        'group flex items-center rounded-lg transition mb-2 cursor-pointer',
        isActive ? t.rowActive : t.row
      )}
    >
      <button onClick={onSelect} className="flex-1 text-left p-3 min-w-0">
        <p className={cn('font-semibold truncate transition-colors text-sm', isActive ? t.nameActive : t.name)}>
          {name}
        </p>
        <p className={cn('text-xs mt-0.5 truncate', isActive ? t.metaActive : t.meta)}>{insurance}</p>
        {meta}
        {claimsStatus && (
          <div className="mt-1.5">
            <StatusBadge status={claimsStatus} />
          </div>
        )}
      </button>
      {onDelete ? (
        <button
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Delete patient ${name}`}
          title={`Delete ${name}`}
          className={cn(
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100',
            'transition-opacity p-2 mr-2 rounded-md focus-visible:ring-2 focus-visible:ring-red-400 shrink-0',
            isActive ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-red-400 hover:text-red-600 hover:bg-red-50'
          )}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      ) : (
        trailing && <span className="mr-3 shrink-0">{trailing}</span>
      )}
    </div>
  );
}
