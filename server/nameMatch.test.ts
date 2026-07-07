import { describe, it, expect } from 'vitest';
import { fuzzyNameMatch, findMatchingPatient } from './nameMatch';

describe('fuzzyNameMatch', () => {
  // ── Exact / case-insensitive ─────────────────────────────────────────────
  it('matches exact same name (case-insensitive)', () => {
    expect(fuzzyNameMatch('ALLISON AUYEUNG', 'ALLISON AUYEUNG')).toBe(true);
    expect(fuzzyNameMatch('Allison Auyeung', 'ALLISON AUYEUNG')).toBe(true);
  });

  // ── Comma format (Last, First) ↔ (First Last) ────────────────────────────
  it('matches "ALLISON AUYEUNG" against "AUYEUNG, ALLISON"', () => {
    expect(fuzzyNameMatch('ALLISON AUYEUNG', 'AUYEUNG, ALLISON')).toBe(true);
  });

  it('matches "AUYEUNG, ALLISON" against "ALLISON AUYEUNG"', () => {
    expect(fuzzyNameMatch('AUYEUNG, ALLISON', 'ALLISON AUYEUNG')).toBe(true);
  });

  it('matches "GARCIA, ISABELA" against "ISABELA GARCIA"', () => {
    expect(fuzzyNameMatch('GARCIA, ISABELA', 'ISABELA GARCIA')).toBe(true);
  });

  it('matches "ISABELA GARCIA" against "GARCIA, ISABELA"', () => {
    expect(fuzzyNameMatch('ISABELA GARCIA', 'GARCIA, ISABELA')).toBe(true);
  });

  // ── No comma, reversed order ─────────────────────────────────────────────
  it('matches "AUYEUNG ALLISON" (no comma) against "ALLISON AUYEUNG"', () => {
    expect(fuzzyNameMatch('AUYEUNG ALLISON', 'ALLISON AUYEUNG')).toBe(true);
  });

  it('matches "SYED RAHMAN" against "RAHMAN, SYED"', () => {
    expect(fuzzyNameMatch('SYED RAHMAN', 'RAHMAN, SYED')).toBe(true);
  });

  // ── Mixed case ───────────────────────────────────────────────────────────
  it('matches mixed-case "Auyeung, Allison" against "ALLISON AUYEUNG"', () => {
    expect(fuzzyNameMatch('Auyeung, Allison', 'ALLISON AUYEUNG')).toBe(true);
  });

  // ── Last name + first initial ────────────────────────────────────────────
  it('matches "AUYEUNG A" against "ALLISON AUYEUNG" via last+initial', () => {
    expect(fuzzyNameMatch('AUYEUNG A', 'ALLISON AUYEUNG')).toBe(true);
  });

  it('matches "A AUYEUNG" against "AUYEUNG, ALLISON" via last+initial', () => {
    expect(fuzzyNameMatch('A AUYEUNG', 'AUYEUNG, ALLISON')).toBe(true);
  });

  // ── Should NOT match different people ────────────────────────────────────
  it('does not match completely different names', () => {
    expect(fuzzyNameMatch('JOHN SMITH', 'ALLISON AUYEUNG')).toBe(false);
  });

  it('does not match same first name only', () => {
    expect(fuzzyNameMatch('ALLISON SMITH', 'ALLISON AUYEUNG')).toBe(false);
  });

  it('does not match same last name only', () => {
    expect(fuzzyNameMatch('JOHN AUYEUNG', 'ALLISON AUYEUNG')).toBe(false);
  });

  // ── Edge cases ───────────────────────────────────────────────────────────
  it('returns false for empty strings', () => {
    expect(fuzzyNameMatch('', 'ALLISON AUYEUNG')).toBe(false);
    expect(fuzzyNameMatch('ALLISON AUYEUNG', '')).toBe(false);
  });

  it('handles extra whitespace', () => {
    expect(fuzzyNameMatch('  ALLISON  AUYEUNG  ', 'AUYEUNG, ALLISON')).toBe(true);
  });
});

describe('findMatchingPatient', () => {
  const patients = [
    { id: '1', name: 'AUYEUNG, ALLISON' },
    { id: '2', name: 'RAHMAN, SYED' },
    { id: '3', name: 'GARCIA, ISABELA' },
    { id: '4', name: 'JOHN SMITH' },
  ];

  it('finds patient by EOB First-Last format', () => {
    const result = findMatchingPatient('ALLISON AUYEUNG', patients);
    expect(result?.id).toBe('1');
  });

  it('finds patient by EOB Last-First format', () => {
    const result = findMatchingPatient('RAHMAN, SYED', patients);
    expect(result?.id).toBe('2');
  });

  it('finds patient by reversed order', () => {
    const result = findMatchingPatient('SYED RAHMAN', patients);
    expect(result?.id).toBe('2');
  });

  it('finds patient by mixed case', () => {
    const result = findMatchingPatient('Garcia, Isabela', patients);
    expect(result?.id).toBe('3');
  });

  it('returns null for unmatched name', () => {
    const result = findMatchingPatient('UNKNOWN PERSON', patients);
    expect(result).toBeNull();
  });

  it('does not false-match on shared last name with different first name', () => {
    const result = findMatchingPatient('JOHN AUYEUNG', patients);
    expect(result).toBeNull();
  });
});
