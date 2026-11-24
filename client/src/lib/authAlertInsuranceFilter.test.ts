import { describe, expect, it } from 'vitest';
import type { AuthUrgency } from '@shared/authUrgency';
import {
  actionableAuthorizationAlerts,
  authAlertInsuranceOptions,
  canonicalInsurerSelection,
  matchesInsurerSelection,
} from './authAlertInsuranceFilter';

const catalog = [
  { name: 'United Healthcare Medicare Advantage', aliases: ['United Healthcare Medicare'] },
  { name: 'Aetna', aliases: [] },
  { name: 'Cigna', aliases: [] }, // in catalog, no alerts → 0
];
const alert = (id: string, insurance: string | null, urgency: AuthUrgency = 'critical', isActive = true) => ({
  patientId: id, patientName: id, insurance, urgency, authPeriod: 1, hold: null, isActive,
});
const alerts = [
  alert('renamed-new', 'United Healthcare Medicare Advantage'),
  alert('renamed-old', 'United Healthcare Medicare'), // pre-rename value still stored
  alert('aetna', 'Aetna'),
  alert('aetna-ok', 'Aetna', 'ok'),
  alert('aetna-discharged', 'Aetna', 'critical', false),
  alert('deleted-insurer', 'Old Regional Plan'), // permanently deleted from the catalog
  alert('no-insurer', null),
];

const filtered = (selected: string) =>
  actionableAuthorizationAlerts(alerts).filter(a => matchesInsurerSelection(a.insurance, selected, catalog)).map(a => a.patientId);

describe('Authorization Alerts insurance filter', () => {
  it('All Insurances = every actionable row (discharged and on-track excluded)', () => {
    expect(filtered('')).toEqual(['renamed-new', 'renamed-old', 'aetna', 'deleted-insurer', 'no-insurer']);
  });

  it('a catalog insurer matches its aliases; an alias in the URL resolves to the current name', () => {
    expect(filtered('United Healthcare Medicare Advantage')).toEqual(['renamed-new', 'renamed-old']);
    expect(canonicalInsurerSelection('United Healthcare Medicare', catalog)).toBe('United Healthcare Medicare Advantage');
    expect(filtered('United Healthcare Medicare')).toEqual(['renamed-new', 'renamed-old']);
  });

  it('historical insurers (absent from the catalog) stay filterable, exact match', () => {
    expect(filtered('Old Regional Plan')).toEqual(['deleted-insurer']);
    const opts = authAlertInsuranceOptions(alerts, catalog);
    expect(opts.find(o => o.name === 'Old Regional Plan')).toMatchObject({ historical: true, count: 1 });
  });

  it('options carry counts that equal the filtered list, including zero', () => {
    const opts = authAlertInsuranceOptions(alerts, catalog);
    for (const o of opts) expect(o.count).toBe(filtered(o.name).length);
    expect(opts.find(o => o.name === 'Cigna')).toMatchObject({ count: 0, historical: false });
    expect(opts.find(o => o.name === 'Aetna')?.count).toBe(1); // discharged + on-track not counted
  });

  it('a stale selection (no catalog entry, no patient) is kept as an option with 0, not dropped', () => {
    expect(filtered('Gone Insurer')).toEqual([]);
    expect(authAlertInsuranceOptions(alerts, catalog, 'Gone Insurer').find(o => o.name === 'Gone Insurer')).toMatchObject({ count: 0 });
  });

  it('count and list agree on > 1000 rows', () => {
    const big = Array.from({ length: 1500 }, (_, i) =>
      alert(`p${i}`, i % 3 === 0 ? 'United Healthcare Medicare' : 'Aetna', i % 5 === 0 ? 'ok' : 'warning', i % 7 !== 0));
    const opts = authAlertInsuranceOptions(big, catalog);
    const list = actionableAuthorizationAlerts(big).filter(a => matchesInsurerSelection(a.insurance, 'United Healthcare Medicare Advantage', catalog));
    expect(opts.find(o => o.name === 'United Healthcare Medicare Advantage')?.count).toBe(list.length);
    expect(list.length).toBe(big.filter((_, i) => i % 3 === 0 && i % 5 !== 0 && i % 7 !== 0).length);
    expect(opts.reduce((n, o) => n + o.count, 0)).toBe(actionableAuthorizationAlerts(big).length);
  });
});
