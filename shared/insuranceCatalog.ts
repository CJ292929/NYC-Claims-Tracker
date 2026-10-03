/**
 * shared/insuranceCatalog.ts
 *
 * Single implementation of insurer-name normalization, shared by the client
 * (Add Insurance Company dialog validation) and the server (insurance.create
 * dup-check + the DB's normalized-name unique index use the same rule, so a
 * client-side "looks fine" can never diverge from what the server/DB accept).
 *
 * Normalization is deliberately case- and whitespace-insensitive only — it
 * never strips or merges words, so distinct insurer products (e.g. "United
 * Healthcare" vs "United Healthcare Medicare Advantage") are never treated
 * as duplicates of each other just because their names overlap.
 */

/** Trim, collapse internal whitespace runs to a single space, lowercase. */
export function normalizeInsurerName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface InsurerCatalogEntry {
  id: string;
  name: string;
  /** Previously-used display names for this same product (e.g. the pre-rename
   *  "United Healthcare Medicare" for "United Healthcare Medicare Advantage")
   *  — kept so existing patient/claim records storing the old name still
   *  resolve to this entry for filtering/counting purposes. */
  aliases: string[];
}

/** Every raw string value (current name + any aliases) that should be
 *  treated as "this insurer" when matching a patient's stored insurance
 *  value against a catalog entry. */
export function insurerMatchValues(entry: Pick<InsurerCatalogEntry, 'name' | 'aliases'>): string[] {
  return [entry.name, ...entry.aliases];
}
