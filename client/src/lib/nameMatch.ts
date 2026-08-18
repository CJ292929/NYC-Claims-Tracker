/**
 * client/src/lib/nameMatch.ts
 *
 * Client-side fuzzy patient name matching utility. Mirrors server/nameMatch.ts.
 * This result picks which extracted patientGroup gets shown/saved for the
 * currently active patient in the single-patient upload review flow (see
 * handleClaimFileUpload in Dashboard.tsx) — a false-positive match here
 * silently shows/saves a DIFFERENT patient's claims under the active
 * patient, so every strategy below requires the FULL set of name tokens to
 * match (just possibly reordered), never a partial/initial-only overlap.
 *
 * Handles the common mismatch between EOB/CMS1500 formats and dashboard formats:
 *   EOB:       "ALLISON AUYEUNG"   (First Last)
 *   Dashboard: "AUYEUNG, ALLISON"  (Last, First)
 *   Also:      "SMITH, JOHN JR"    (generational/professional suffix)
 *              "RAMATI, RAQUEL M"  (middle initial — common on government-
 *                                   services/NGS-style EOBs)
 *              "O'BRIEN, JAMES"    (apostrophe) / "GARCIA-LOPEZ, MARIA" (hyphen)
 *
 * Deliberately NOT included: matching on last name + first initial alone
 * (e.g. "SMITH J" as the ENTIRE input), or on an arbitrary subset of tokens.
 * Both produce false positives whenever two different patients share a last
 * name and first initial, or one patient's full name happens to contain
 * another's. This is different from tolerating a middle initial ADDED
 * alongside an otherwise-complete first+last match (see suffixTolerantMatch).
 */

/** Normalize a name: uppercase, drop apostrophes, turn other punctuation/
 *  hyphens into spaces, collapse whitespace. */
function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/['']/g, '')
    .replace(/[,.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a normalized name into tokens */
function tokenize(name: string): string[] {
  return normalizeName(name).split(' ').filter(t => t.length > 0);
}

/** Generate all canonical name variants from a raw name string */
function nameVariants(name: string): string[] {
  const tokens = tokenize(name);
  const variants = new Set<string>();

  variants.add(tokens.join(' '));

  if (tokens.length === 2) {
    variants.add([tokens[1], tokens[0]].join(' '));
  }

  if (tokens.length >= 3) {
    variants.add([tokens[0], ...tokens.slice(1)].join(' '));
    variants.add([...tokens.slice(0, tokens.length - 1), tokens[tokens.length - 1]].join(' '));
    variants.add([...tokens].reverse().join(' '));
  }

  return Array.from(variants);
}

/** Generational/professional suffixes tolerated as a surplus token in
 *  suffixTolerantMatch — anything else must be a bare initial (see below) or
 *  the match is treated as a genuinely different name. */
const NAME_SUFFIXES = new Set([
  'JR', 'SR', 'II', 'III', 'IV', 'V', 'MD', 'DO', 'PT', 'DPT', 'RN', 'PHD', 'ESQ',
]);

/**
 * Suffix-tolerant match: the longer name may have surplus tokens beyond the
 * shorter name's full token set, as long as EVERY surplus token is either a
 * recognized generational/professional suffix or a bare 1-2 character
 * initial (e.g. a middle initial). An arbitrary full extra token is never
 * accepted — allowing that would mean e.g. "MARY ANN JONES" matches an
 * unrelated "ANN JONES".
 */
function suffixTolerantMatch(tokensA: string[], tokensB: string[]): boolean {
  const [shorter, longer] = tokensA.length <= tokensB.length
    ? [tokensA, tokensB]
    : [tokensB, tokensA];

  if (longer.length === shorter.length) return false;

  const remaining = [...longer];
  for (const t of shorter) {
    const idx = remaining.indexOf(t);
    if (idx === -1) return false;
    remaining.splice(idx, 1);
  }
  return remaining.length > 0 && remaining.every(t => NAME_SUFFIXES.has(t) || t.length <= 2);
}

/**
 * Main fuzzy match function.
 * Returns true if eobName and dashName refer to the same person.
 */
export function fuzzyNameMatch(eobName: string, dashName: string): boolean {
  if (!eobName || !dashName) return false;

  const normEob = normalizeName(eobName);
  const normDash = normalizeName(dashName);

  // 1. Exact match (normalized)
  if (normEob === normDash) return true;

  const tokensEob = tokenize(eobName);
  const tokensDash = tokenize(dashName);

  // 2. Token-set match (same tokens regardless of order)
  const setEob = new Set(tokensEob);
  const setDash = new Set(tokensDash);
  if (
    setEob.size === setDash.size &&
    Array.from(setEob).every(t => setDash.has(t))
  ) return true;

  // 3. Reversed-order match via variants
  const variantsEob = nameVariants(eobName);
  const variantsDash = nameVariants(dashName);
  for (const ve of variantsEob) {
    for (const vd of variantsDash) {
      if (ve === vd) return true;
    }
  }

  // 4. Suffix-tolerant match — the only case where token sets are allowed to
  //    differ, and only by one recognized suffix token. See suffixTolerantMatch
  //    for why last-name+first-initial and arbitrary-subset heuristics are not
  //    used: both can match two genuinely different patients.
  if (suffixTolerantMatch(tokensEob, tokensDash)) return true;

  return false;
}

/**
 * Find the best matching patient from a list given an EOB name.
 */
export function findMatchingPatient<T extends { name: string }>(
  eobName: string,
  patients: T[]
): T | undefined {
  // Exact match first
  const exact = patients.find(
    p => normalizeName(p.name) === normalizeName(eobName)
  );
  if (exact) return exact;

  // Fuzzy match
  return patients.find(p => fuzzyNameMatch(eobName, p.name));
}
