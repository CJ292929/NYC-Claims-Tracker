export interface PatientOverviewPatient {
  id: string;
  isActive?: boolean | null;
}

export interface PatientOverviewMetrics {
  totalPatients: number;
  activePatients: number;
  completedPatients: number;
  dischargedPatients: number;
}

/**
 * Mutually-exclusive Patient Overview KPI categories (used by the /patients
 * Overview page only — not the main Dashboard's C6F "Active Patients" KPI,
 * which intentionally still counts active-and-completed patients as active).
 *
 * - dischargedPatients: isActive === false
 * - completedPatients: isActive !== false AND id in completedPatientIds
 * - activePatients: isActive !== false AND id NOT in completedPatientIds
 *
 * A discharged patient whose id is also in completedPatientIds still counts
 * only as discharged — discharge status takes priority over completion.
 *
 * Invariant: totalPatients === activePatients + completedPatients + dischargedPatients
 */
export function getPatientOverviewMetrics(
  patients: PatientOverviewPatient[],
  completedPatientIds: Iterable<string>,
): PatientOverviewMetrics {
  const completedSet = completedPatientIds instanceof Set
    ? completedPatientIds
    : new Set(completedPatientIds);

  let activePatients = 0;
  let completedPatients = 0;
  let dischargedPatients = 0;

  for (const patient of patients) {
    if (patient.isActive === false) {
      dischargedPatients++;
    } else if (completedSet.has(patient.id)) {
      completedPatients++;
    } else {
      activePatients++;
    }
  }

  return {
    totalPatients: patients.length,
    activePatients,
    completedPatients,
    dischargedPatients,
  };
}
