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

  // ── Generational/professional suffixes ───────────────────────────────────
  it('matches "SMITH, JOHN" against "JOHN SMITH JR" via suffix tolerance', () => {
    expect(fuzzyNameMatch('SMITH, JOHN', 'JOHN SMITH JR')).toBe(true);
  });

  it('matches "JANE DOE MD" against "DOE, JANE" via suffix tolerance', () => {
    expect(fuzzyNameMatch('JANE DOE MD', 'DOE, JANE')).toBe(true);
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

  // ── Regression: last-name + first-initial must NOT match (removed on
  //    purpose — it previously misattributed claims between two different
  //    patients who share a last name and first initial, e.g. two different
  //    "Auyeung" patients whose first names both start with "A") ───────────
  it('does not match on last name + first initial alone', () => {
    expect(fuzzyNameMatch('AUYEUNG A', 'ALLISON AUYEUNG')).toBe(false);
    expect(fuzzyNameMatch('A AUYEUNG', 'AUYEUNG, ALLISON')).toBe(false);
  });

  it('does not match two different patients sharing a last name and first initial', () => {
    // "ANDREW AUYEUNG" and "ALLISON AUYEUNG" are different people, both would
    // pass the old "last name + first initial" heuristic — must not match now.
    expect(fuzzyNameMatch('ANDREW AUYEUNG', 'ALLISON AUYEUNG')).toBe(false);
  });

  // ── Regression: an extra token that isn't a recognized suffix must NOT
  //    match — e.g. "MARY ANN JONES" is a different person from "ANN JONES" ─
  it('does not match when the extra token is not a recognized suffix', () => {
    expect(fuzzyNameMatch('MARY ANN JONES', 'ANN JONES')).toBe(false);
    expect(fuzzyNameMatch('JOHN SMITH', 'JOHN SMITH WILLIAMS')).toBe(false);
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

  it('does not misattribute a claim between two patients sharing a last name and first initial', () => {
    const rosterWithCollision = [
      ...patients,
      { id: '5', name: 'AUYEUNG, ANDREW' },
    ];
    // An EOB claim for "ALLISON AUYEUNG" must resolve to patient 1, never
    // patient 5 (same last name + first initial "A") — this is the exact
    // false-positive scenario the suffix-tolerant matcher replaces.
    const result = findMatchingPatient('ALLISON AUYEUNG', rosterWithCollision);
    expect(result?.id).toBe('1');
  });

  it('returns null rather than a wrong-patient match when only a last-name+initial collision exists', () => {
    // Isolates the fix from array order: with ONLY the colliding patient in
    // the roster (no correct "Allison Auyeung" present), the old last-name+
    // first-initial heuristic would have incorrectly matched "Andrew Auyeung"
    // here. The fixed matcher must return null instead of guessing.
    const rosterWithOnlyCollision = [{ id: '5', name: 'AUYEUNG, ANDREW' }];
    const result = findMatchingPatient('ALLISON AUYEUNG', rosterWithOnlyCollision);
    expect(result).toBeNull();
  });
});
