import { describe, it, expect } from 'vitest';
import { matchesPatientFilters } from './patientFilters';

const patient = (id: string, insurance: string) => ({ id, insurance });

describe('matchesPatientFilters', () => {
  it('matches everyone when no insurance or status filter is active', () => {
    const scope = { selectedInsurance: '', selectedClaimsFilter: 'all', patientIdsByStatus: {} };
    expect(matchesPatientFilters(patient('1', 'Aetna'), scope)).toBe(true);
  });

  it('excludes patients on a different insurance', () => {
    const scope = { selectedInsurance: 'Aetna', selectedClaimsFilter: 'all', patientIdsByStatus: {} };
    expect(matchesPatientFilters(patient('1', 'Meritain Health'), scope)).toBe(false);
    expect(matchesPatientFilters(patient('2', 'Aetna'), scope)).toBe(true);
  });

  it('excludes patients not in the selected claims status bucket', () => {
    const scope = {
      selectedInsurance: '',
      selectedClaimsFilter: 'denied',
      patientIdsByStatus: { denied: ['1'] },
    };
    expect(matchesPatientFilters(patient('1', 'Aetna'), scope)).toBe(true);
    expect(matchesPatientFilters(patient('2', 'Aetna'), scope)).toBe(false);
  });

  it('requires both insurance and status to match when both are active', () => {
    const scope = {
      selectedInsurance: 'Aetna',
      selectedClaimsFilter: 'denied',
      patientIdsByStatus: { denied: ['1', '2'] },
    };
    expect(matchesPatientFilters(patient('1', 'Aetna'), scope)).toBe(true);
    expect(matchesPatientFilters(patient('2', 'Meritain Health'), scope)).toBe(false);
    expect(matchesPatientFilters(patient('3', 'Aetna'), scope)).toBe(false);
  });

  it('matches patients stored under a pre-rename alias of the selected insurance', () => {
    const scope = {
      selectedInsurance: 'United Healthcare Medicare Advantage',
      selectedClaimsFilter: 'all',
      patientIdsByStatus: {},
      selectedInsuranceAliases: ['United Healthcare Medicare'],
    };
    expect(matchesPatientFilters(patient('1', 'United Healthcare Medicare'), scope)).toBe(true);
    expect(matchesPatientFilters(patient('2', 'United Healthcare Medicare Advantage'), scope)).toBe(true);
    expect(matchesPatientFilters(patient('3', 'United Healthcare'), scope)).toBe(false);
  });
});
