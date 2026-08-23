const DEFAULT_OPTIONS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

/**
 * Formats a calendar-date value (Date, ms number, or "YYYY-MM-DD"/ISO string) that is
 * UTC-midnight-anchored by construction. Always renders in UTC so the calendar date
 * shown matches what was stored, regardless of the viewer's local timezone.
 */
export function formatCalendarDate(
  value: Date | string | number | null | undefined,
  options: Intl.DateTimeFormatOptions = DEFAULT_OPTIONS,
): string {
  if (value === null || value === undefined || value === '') return '—';
  const dt = value instanceof Date ? value : new Date(value);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
}
