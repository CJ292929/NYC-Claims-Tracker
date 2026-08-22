import { describe, it, expect } from 'vitest';
import { getPatientOverviewMetrics, type PatientOverviewPatient } from './patientOverviewMetrics';

const patient = (id: string, isActive: boolean | null | undefined = true): PatientOverviewPatient => ({ id, isActive });

describe('getPatientOverviewMetrics', () => {
  it('CASE A: normal active, not completed -> Active', () => {
    const result = getPatientOverviewMetrics([patient('1')], []);
    expect(result).toEqual({ totalPatients: 1, activePatients: 1, completedPatients: 0, dischargedPatients: 0 });
  });

  it('CASE B: active + completed -> Completed, not Active', () => {
    const result = getPatientOverviewMetrics([patient('1')], ['1']);
    expect(result).toEqual({ totalPatients: 1, activePatients: 0, completedPatients: 1, dischargedPatients: 0 });
  });

  it('CASE C: discharged -> Discharged', () => {
    const result = getPatientOverviewMetrics([patient('1', false)], []);
    expect(result).toEqual({ totalPatients: 1, activePatients: 0, completedPatients: 0, dischargedPatients: 1 });
  });

  it('CASE D: discharged + completedSet contains id -> Discharged only', () => {
    const result = getPatientOverviewMetrics([patient('1', false)], ['1']);
    expect(result).toEqual({ totalPatients: 1, activePatients: 0, completedPatients: 0, dischargedPatients: 1 });
  });

  it('CASE E: zero visits / not completed -> Active', () => {
    const result = getPatientOverviewMetrics([patient('1')], []);
    expect(result.activePatients).toBe(1);
    expect(result.completedPatients).toBe(0);
  });

  it('CASE F: mixed population', () => {
    const patients = [
      ...['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => patient(id)),
      ...['c1', 'c2'].map((id) => patient(id)),
      ...['d1', 'd2', 'd3'].map((id) => patient(id, false)),
    ];
    const result = getPatientOverviewMetrics(patients, ['c1', 'c2']);
    expect(result).toEqual({ totalPatients: 10, activePatients: 5, completedPatients: 2, dischargedPatients: 3 });
  });

  it('CASE G: empty -> all zero', () => {
    const result = getPatientOverviewMetrics([], []);
    expect(result).toEqual({ totalPatients: 0, activePatients: 0, completedPatients: 0, dischargedPatients: 0 });
  });

  it('CASE H: invariant holds across a mixed population', () => {
    const patients = [
      patient('1'), patient('2', false), patient('3'), patient('4', false), patient('5'),
    ];
    const result = getPatientOverviewMetrics(patients, ['1', '5']);
    expect(result.totalPatients).toBe(result.activePatients + result.completedPatients + result.dischargedPatients);
  });

  it('treats isActive undefined/null the same as true (not discharged)', () => {
    const result = getPatientOverviewMetrics([patient('1', undefined), patient('2', null)], []);
    expect(result.activePatients).toBe(2);
  });

  it('accepts a Set directly for completedPatientIds', () => {
    const result = getPatientOverviewMetrics([patient('1')], new Set(['1']));
    expect(result.completedPatients).toBe(1);
  });
});
