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
}

export function matchesPatientFilters(
  patient: { id: string; insurance: string },
  scope: PatientFilterScope
): boolean {
  if (scope.selectedInsurance && patient.insurance !== scope.selectedInsurance) {
    return false;
  }
  if (scope.selectedClaimsFilter && scope.selectedClaimsFilter !== 'all') {
    const matchingIds = scope.patientIdsByStatus[scope.selectedClaimsFilter] ?? [];
    if (!matchingIds.includes(patient.id)) {
      return false;
    }
  }
  return true;
}
