import { cn } from '@/lib/utils';

/**
 * Single source of truth for claim/auth status → color mapping.
 * Mirrors the values in Dashboard.tsx's CLAIM_STATUS_FILTERS exactly —
 * keep both in sync if a new status value is ever introduced.
 */
export const STATUS_STYLES: Record<string, { className: string; label: string }> = {
  submitted: { className: 'bg-blue-100 text-blue-800', label: 'Submitted' },
  approved: { className: 'bg-green-100 text-green-800', label: 'Approved' },
  pending: { className: 'bg-yellow-100 text-yellow-800', label: 'Pending' },
  denied: { className: 'bg-red-100 text-red-800', label: 'Denied' },
  // P4-P31: authorization status only (claims never use it).
  expired: { className: 'bg-slate-200 text-slate-800', label: 'Expired' },
  pended: { className: 'bg-orange-100 text-orange-800', label: 'Pended' },
  rejected: { className: 'bg-gray-900 text-white', label: 'Rejected' },
  resubmitted: { className: 'bg-violet-100 text-violet-800', label: 'Resubmitted' },
  none: { className: 'bg-gray-50 text-gray-500', label: 'No Status' },
};

export function StatusBadge({
  status,
  label,
  className,
}: {
  status: string | null | undefined;
  label?: string;
  className?: string;
}) {
  const key = status ?? 'none';
  const cfg = STATUS_STYLES[key] ?? STATUS_STYLES.none;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold capitalize whitespace-nowrap',
        cfg.className,
        className
      )}
    >
      {label ?? cfg.label}
    </span>
  );
}
