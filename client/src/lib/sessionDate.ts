/**
 * client/src/lib/sessionDate.ts
 *
 * Validation for the "Log New Session" dialog's Date of Service. A native
 * `<input type="date">` reports "" while the date is blank or only partly
 * typed, and a YYYY-MM-DD string once it is complete — but browsers differ
 * on how strictly they reject impossible dates, so the calendar check is
 * done here too. Used by both the Confirm Session button and Enter
 * (implicit form submission), so they share one rule.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True only for a complete, real calendar date in YYYY-MM-DD form. */
export function isCompleteSessionDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || month < 1 || month > 12 || day < 1) return false;
  // Day 0 of the next month is the last day of this month (UTC avoids DST).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}
