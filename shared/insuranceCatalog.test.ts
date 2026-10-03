import { describe, it, expect } from 'vitest';
import { normalizeInsurerName, insurerMatchValues } from './insuranceCatalog';

describe('normalizeInsurerName', () => {
  it('trims leading/trailing whitespace', () => {
    expect(normalizeInsurerName('  Aetna  ')).toBe('aetna');
  });

  it('collapses internal whitespace runs', () => {
    expect(normalizeInsurerName('Aegis   One  Inc.')).toBe('aegis one inc.');
  });

  it('is case-insensitive', () => {
    expect(normalizeInsurerName('UMR')).toBe(normalizeInsurerName('umr'));
    expect(normalizeInsurerName('Gallagher Bassett')).toBe(normalizeInsurerName('GALLAGHER BASSETT'));
  });

  it('treats case/whitespace variants of the same name as equal', () => {
    expect(normalizeInsurerName('Hanover')).toBe(normalizeInsurerName('  hanover '));
    expect(normalizeInsurerName('  hanover ')).toBe(normalizeInsurerName('HANOVER'));
  });

  it('does not merge distinct insurer products that merely resemble each other', () => {
    expect(normalizeInsurerName('United Healthcare')).not.toBe(
      normalizeInsurerName('United Healthcare Medicare Advantage')
    );
  });
});

describe('insurerMatchValues', () => {
  it('includes the current name and any aliases', () => {
    const entry = { name: 'United Healthcare Medicare Advantage', aliases: ['United Healthcare Medicare'] };
    expect(insurerMatchValues(entry)).toEqual([
      'United Healthcare Medicare Advantage',
      'United Healthcare Medicare',
    ]);
  });

  it('is just the name when there are no aliases', () => {
    expect(insurerMatchValues({ name: 'Aetna', aliases: [] })).toEqual(['Aetna']);
  });
});
