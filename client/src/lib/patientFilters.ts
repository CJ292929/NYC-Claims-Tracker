/**
 * Shared predicate for scoping patients to the active Insurance / Claims
 * Status filters. Used by the main patient list, the Completed Sessions
 * folder, the Discharged Patients folder, and selected-patient validity
 * checks so all of them agree on what's "in scope" — search text is
 * intentionally excluded, since search only affects what's visible, not
 * what's considered a valid selection.
 */

export interface PatientFilterScope {
  selectedInsurance: string;
  selectedClaimsFilter: string;
  patientIdsByStatus: Record<string, string[]>;
  /** Alternate raw values (e.g. a pre-rename insurer name preserved as a
   *  catalog alias — see shared/insuranceCatalog.ts) that should also count
   *  as a match for selectedInsurance. Omit/empty for the common case where
   *  selectedInsurance has no aliases. */
  selectedInsuranceAliases?: string[];
}

export function matchesPatientFilters(
  patient: { id: string; insurance: string },
  scope: PatientFilterScope
): boolean {
  if (scope.selectedInsurance) {
    const acceptable = scope.selectedInsuranceAliases?.length
      ? [scope.selectedInsurance, ...scope.selectedInsuranceAliases]
      : [scope.selectedInsurance];
    if (!acceptable.includes(patient.insurance)) return false;
  }
  if (scope.selectedClaimsFilter && scope.selectedClaimsFilter !== 'all') {
    const matchingIds = scope.patientIdsByStatus[scope.selectedClaimsFilter] ?? [];
    if (!matchingIds.includes(patient.id)) {
      return false;
    }
  }
  return true;
}

/**
 * True when an Insurance filter selection no longer points at anything: the
 * value isn't a current catalog name or alias, and no patient (active or
 * discharged) stores it. A permanently deleted insurer (P4-P21) always meets
 * both conditions, since deletion is refused while any record uses it. A
 * legacy free-text insurer that patients still store is never stale, even
 * though it has no catalog entry.
 */
export function isStaleInsurerSelection(
  selected: string,
  catalog: ReadonlyArray<{ name: string; aliases: string[] }>,
  patients: ReadonlyArray<{ insurance: string }>
): boolean {
  if (!selected) return false;
  if (catalog.some(entry => entry.name === selected || entry.aliases.includes(selected))) return false;
  return !patients.some(p => p.insurance === selected);
}
