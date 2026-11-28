/**
 * client/src/lib/periodDisplayOrder.ts
 *
 * Display order for one authorization period's session rows. Rows arrive in
 * stored Session # order. A visit added later with Add Missing Session fills
 * the period's first unused slot, so its Session # can be higher than a visit
 * dated after it (Jan 19 backfilled as Session 4 after Jan 26 was Session 3).
 *
 * Display only: dated rows are shown in Date of Service order, and undated
 * rows (unused slots and placeholders) keep the exact positions they had.
 * No stored value changes: session ids, Session #, # Remaining and claim
 * links stay as recorded.
 */

export interface PeriodDisplayRow {
  id: string;
  sessionNumber: number | null;
  dateOfService: Date | string | null;
}

const dayValue = (d: Date | string): number => {
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

const compareDated = (a: PeriodDisplayRow, b: PeriodDisplayRow): number =>
  dayValue(a.dateOfService!) - dayValue(b.dateOfService!) ||
  (a.sessionNumber ?? Number.POSITIVE_INFINITY) - (b.sessionNumber ?? Number.POSITIVE_INFINITY) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Dated rows in Date of Service order inside the slots dated rows already
 *  occupy; undated rows stay where they were. Returns a new array. */
export function orderPeriodVisitsForDisplay<T extends PeriodDisplayRow>(rows: readonly T[]): T[] {
  const dated = rows.filter(r => r.dateOfService != null).sort(compareDated);
  let next = 0;
  return rows.map(r => (r.dateOfService != null ? dated[next++] : r));
}

/** Ids of dated rows recorded after a later-dated visit already held a lower
 *  Session # (for example a backfilled visit). Their stored # Remaining is the
 *  count as of when they were entered, so the table labels them. */
export function addedAfterLaterVisitIds(rows: readonly PeriodDisplayRow[]): Set<string> {
  const ids = new Set<string>();
  const dated = rows.filter(r => r.dateOfService != null && r.sessionNumber != null);
  for (const r of dated) {
    const t = dayValue(r.dateOfService!);
    if (dated.some(o => o !== r && dayValue(o.dateOfService!) > t && o.sessionNumber! < r.sessionNumber!)) {
      ids.add(r.id);
    }
  }
  return ids;
}
