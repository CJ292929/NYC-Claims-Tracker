import { describe, it, expect } from 'vitest';
import { historicalInsurerNames, isStaleInsurerSelection, matchesPatientFilters } from './patientFilters';

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

describe('isStaleInsurerSelection (P4-P21)', () => {
  const catalog = [
    { name: 'Aetna', aliases: [] },
    { name: 'United Healthcare Medicare Advantage', aliases: ['United Healthcare Medicare'] },
  ];
  const patients = [{ insurance: 'Aetna' }, { insurance: 'Legacy Free Text Co' }];

  it('an empty selection is never stale', () => {
    expect(isStaleInsurerSelection('', catalog, patients)).toBe(false);
  });

  it('a current catalog name or alias is not stale', () => {
    expect(isStaleInsurerSelection('Aetna', catalog, [])).toBe(false);
    expect(isStaleInsurerSelection('United Healthcare Medicare', catalog, [])).toBe(false);
  });

  it('a permanently deleted insurer (gone from catalog, used by no patient) is stale', () => {
    expect(isStaleInsurerSelection('Typo Insurer', catalog, patients)).toBe(true);
  });

  it('an uncatalogued value that patients still store is kept', () => {
    expect(isStaleInsurerSelection('Legacy Free Text Co', catalog, patients)).toBe(false);
  });
});

describe('historicalInsurerNames (P4-P22)', () => {
  const catalog = [
    { name: 'Aetna', aliases: [] },
    { name: 'United Healthcare Medicare Advantage', aliases: ['United Healthcare Medicare'] },
  ];

  it('lists recorded values not in the catalog (deleted or legacy), deduped and sorted', () => {
    const patients = [
      { insurance: 'Synthetic Deleted Co' },
      { insurance: 'Aetna' },
      { insurance: 'Synthetic Deleted Co' },
      { insurance: 'Legacy Free Text Co' },
    ];
    expect(historicalInsurerNames(catalog, patients)).toEqual(['Legacy Free Text Co', 'Synthetic Deleted Co']);
  });

  it('never lists a current catalog name or alias, or blank values', () => {
    const patients = [{ insurance: 'Aetna' }, { insurance: 'United Healthcare Medicare' }, { insurance: '' }, { insurance: '  ' }];
    expect(historicalInsurerNames(catalog, patients)).toEqual([]);
  });

  it('matches exactly, like the filter itself: a different-casing spelling is its own historical entry', () => {
    expect(historicalInsurerNames(catalog, [{ insurance: 'AETNA' }])).toEqual(['AETNA']);
  });

  it('after deleting a referenced insurer, its patients stay filterable under the historical value', () => {
    const before = [...catalog, { name: 'Synthetic Referenced Co', aliases: [] }];
    const patients = [patient('p1', 'Synthetic Referenced Co'), patient('p2', 'Aetna')];
    expect(historicalInsurerNames(before, patients)).toEqual([]);

    const after = catalog; // the catalog row is gone; patient rows unchanged
    const [historical] = historicalInsurerNames(after, patients);
    expect(historical).toBe('Synthetic Referenced Co');
    expect(isStaleInsurerSelection(historical, after, patients)).toBe(false);
    const scope = { selectedInsurance: historical, selectedClaimsFilter: 'all', patientIdsByStatus: {} };
    expect(patients.filter(p => matchesPatientFilters(p, scope)).map(p => p.id)).toEqual(['p1']);
  });
});
