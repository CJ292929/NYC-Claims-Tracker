import { describe, it, expect } from 'vitest';
import { normalizePatientName, parseCsvRow, parseCsvText } from './csvImport';

describe('parseCsvText', () => {
  it('parses quoted names containing commas into a single column', () => {
    const csv = 'Patient Name,Insurance,Authorized Sessions\n"Doe, John",Aetna,12';
    const result = parseCsvText(csv);
    expect(result.errors.filter(e => e.type !== 'FieldMismatch')).toHaveLength(0);
    expect(result.data).toEqual([
      { 'Patient Name': 'Doe, John', Insurance: 'Aetna', 'Authorized Sessions': '12' },
    ]);
  });
});

describe('normalizePatientName', () => {
  it('matches names differing only by case and surrounding whitespace', () => {
    expect(normalizePatientName('John Doe')).toBe(normalizePatientName('john doe '));
  });

  it('does not equate genuinely different names', () => {
    expect(normalizePatientName('John Doe')).not.toBe(normalizePatientName('Jane Doe'));
  });
});

describe('parseCsvRow', () => {
  it('accepts a row with missing Authorized Sessions instead of dropping it', () => {
    const { row, skipReason } = parseCsvRow({ 'Patient Name': 'Jane Smith', Insurance: 'Cigna' }, 2);
    expect(skipReason).toBeUndefined();
    expect(row).not.toBeNull();
    expect(row?.authorized).toBe(0);
    expect(row?.remaining).toBe(0);
  });

  it('accepts a row with Authorized Sessions explicitly set to 0', () => {
    const { row, skipReason } = parseCsvRow({ 'Patient Name': 'Jane Smith', 'Authorized Sessions': '0' }, 2);
    expect(skipReason).toBeUndefined();
    expect(row?.authorized).toBe(0);
  });

  it('skips a row with no patient name and reports why', () => {
    const { row, skipReason } = parseCsvRow({ 'Patient Name': '', Insurance: 'Aetna' }, 5);
    expect(row).toBeNull();
    expect(skipReason).toBe('Row 5: Missing patient name');
  });

  it('recognizes "Date ASH Submitted" as the authorization-submitted date', () => {
    const { row } = parseCsvRow({ 'Patient Name': 'John Doe', 'Date ASH Submitted': '2026-01-15' }, 1);
    expect(row?.dateAshSubmitted).toBe('2026-01-15');
  });

  it('recognizes "Date Authorization Submitted" as a fallback header', () => {
    const { row } = parseCsvRow({ 'Patient Name': 'John Doe', 'Date Authorization Submitted': '2026-02-20' }, 1);
    expect(row?.dateAshSubmitted).toBe('2026-02-20');
  });
});
