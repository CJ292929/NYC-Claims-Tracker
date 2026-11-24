import { insurerMatchValues } from '@shared/insuranceCatalog';
import { classifyAuthorizationAlert, type ClassifiableAlert } from '@shared/authRequestHold';
import { historicalInsurerNames } from '@/lib/patientFilters';

/**
 * Insurance filter for the actionable Authorization Alerts queue (Dashboard
 * Needs Attention + /authorizations/attention). Selection lives in the URL as
 * ?authInsurance=<name> so it survives reload and Back/Forward; '' = All
 * Insurances. Matching reuses the catalog rule everywhere else uses: a
 * catalog entry matches its current name AND its aliases (pre-rename names);
 * anything else (historical / legacy free text, a permanently deleted
 * insurer) matches exactly — the same rule as matchesPatientFilters — so a
 * patient whose insurer left the catalog is never lost from filtering.
 *
 * Filtering only narrows the queue; global totals (the Authorization
 * Attention KPI) are always computed from the unfiltered rows.
 */

export const AUTH_INSURANCE_PARAM = 'authInsurance';

type CatalogEntry = { name: string; aliases: string[] };
type InsuredAlert = ClassifiableAlert & { insurance: string | null };

/** The catalog entry a selection means — by current name, else by an alias
 *  (e.g. an old bookmarked URL carrying the pre-rename name). */
export function resolveInsurerSelection(selected: string, catalog: ReadonlyArray<CatalogEntry>): CatalogEntry | null {
  if (!selected) return null;
  return catalog.find(e => e.name === selected) ?? catalog.find(e => e.aliases.includes(selected)) ?? null;
}

/** Raw stored insurance values that count as the selection. Empty = all. */
export function insurerSelectionValues(selected: string, catalog: ReadonlyArray<CatalogEntry>): string[] {
  if (!selected) return [];
  const entry = resolveInsurerSelection(selected, catalog);
  return entry ? insurerMatchValues(entry) : [selected];
}

export function matchesInsurerSelection(
  insurance: string | null,
  selected: string,
  catalog: ReadonlyArray<CatalogEntry>,
): boolean {
  if (!selected) return true;
  return insurerSelectionValues(selected, catalog).includes(insurance ?? '');
}

/** Actionable rows (category 'attention') — the Authorization Alerts queue. */
export function actionableAuthorizationAlerts<T extends ClassifiableAlert>(alerts: ReadonlyArray<T>): T[] {
  return alerts.filter(a => classifyAuthorizationAlert(a) === 'attention');
}

export interface AuthAlertInsuranceOption {
  name: string;
  /** Actionable alerts for this insurer (aliases included). */
  count: number;
  historical: boolean;
  aliases: string[];
}

/**
 * Selector options: every catalog insurer (active and inactive, like the
 * patient Insurance filter), then insurers recorded on alert rows that are
 * not in the catalog ("historical"), plus the current selection if it no
 * longer resolves to anything (so a stale URL is shown, with 0, not dropped).
 */
export function authAlertInsuranceOptions(
  alerts: ReadonlyArray<InsuredAlert>,
  catalog: ReadonlyArray<CatalogEntry>,
  selected = '',
): AuthAlertInsuranceOption[] {
  const actionable = actionableAuthorizationAlerts(alerts);
  const countFor = (values: string[]) => actionable.filter(a => values.includes(a.insurance ?? '')).length;
  const options: AuthAlertInsuranceOption[] = catalog.map(entry => ({
    name: entry.name, aliases: entry.aliases, historical: false, count: countFor(insurerMatchValues(entry)),
  }));
  const historical = historicalInsurerNames(catalog, alerts.map(a => ({ insurance: a.insurance ?? '' })));
  for (const name of historical) options.push({ name, aliases: [], historical: true, count: countFor([name]) });
  if (selected && !resolveInsurerSelection(selected, catalog) && !historical.includes(selected)) {
    options.push({ name: selected, aliases: [], historical: true, count: 0 });
  }
  return options;
}

/** Canonical name to display for a selection (alias → current catalog name). */
export function canonicalInsurerSelection(selected: string, catalog: ReadonlyArray<CatalogEntry>): string {
  return resolveInsurerSelection(selected, catalog)?.name ?? selected;
}
