/**
 * server/nameMatch.ts
 *
 * Fuzzy patient name matching utility. This result drives which patient record
 * an extracted claim gets saved against (see bulkImportFromEOB in routers.ts),
 * so a false-positive match silently misattributes real financial/medical data
 * to the wrong patient — every strategy here requires the FULL set of name
 * tokens to match (just possibly reordered), never a partial/initial-only
 * overlap, so two different people can never satisfy a match by coincidence.
 *
 * Handles the common mismatch between EOB/CMS1500 formats and dashboard formats:
 *   EOB:       "ALLISON AUYEUNG"   (First Last)
 *   Dashboard: "AUYEUNG, ALLISON"  (Last, First)
 *   Also:      "AUYEUNG ALLISON"   (Last First, no comma)
 *              "Auyeung, Allison"  (mixed case)
 *              "GARCIA, ISABELA"   (already Last, First)
 *              "SMITH, JOHN JR"    (generational/professional suffix)
 *
 * Matching strategy (in order of confidence):
 *   1. Exact match (case-insensitive) — fastest path
 *   2. Token-set match — split both names into tokens, check if same set of tokens
 *   3. Reversed-order match — "FIRST LAST" vs "LAST, FIRST" by swapping tokens
 *   4. Suffix-tolerant match — "SMITH, JOHN" matches "JOHN SMITH JR" (surplus
 *      tokens must be a recognized generational/professional suffix, e.g. JR,
 *      SR, II, MD — never an arbitrary extra token, which could belong to a
 *      different person of a similar name)
 *
 * Deliberately NOT included: matching on last name + first initial alone
 * (e.g. "SMITH J"), or on an arbitrary subset of tokens. Both produce false
 * positives whenever two different patients share a last name and first
 * initial, or one patient's full name happens to contain another's — an
 * unacceptable risk when the result determines where a claim's money and
 * diagnosis history get recorded.
 */

/** Normalize a name: uppercase, remove commas/punctuation, collapse whitespace */
function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[,\.]/g, ' ')   // commas and dots → space
    .replace(/\s+/g, ' ')     // collapse multiple spaces
    .trim();
}

/** Split a normalized name into tokens */
function tokenize(name: string): string[] {
  return normalizeName(name).split(' ').filter(t => t.length > 0);
}

/**
 * Generate all canonical name variants from a raw name string.
 * Returns an array of normalized strings to compare against.
 *
 * Examples for "AUYEUNG, ALLISON":
 *   → ["AUYEUNG ALLISON", "ALLISON AUYEUNG"]
 *
 * Examples for "ALLISON AUYEUNG":
 *   → ["ALLISON AUYEUNG", "AUYEUNG ALLISON"]
 */
function nameVariants(name: string): string[] {
  const tokens = tokenize(name);
  const variants = new Set<string>();

  // Original token order
  variants.add(tokens.join(' '));

  // Reversed token order (handles First Last ↔ Last First)
  if (tokens.length === 2) {
    variants.add([tokens[1], tokens[0]].join(' '));
  }

  // For 3+ tokens: try Last=first token, First=rest (and vice versa)
  if (tokens.length >= 3) {
    // Last + rest-as-first
    variants.add([tokens[0], ...tokens.slice(1)].join(' '));
    // First + rest-as-last
    variants.add([...tokens.slice(0, tokens.length - 1), tokens[tokens.length - 1]].join(' '));
    // Reversed all
    variants.add([...tokens].reverse().join(' '));
  }

  return Array.from(variants);
}

/** Generational/professional suffixes tolerated as the one surplus token in
 *  suffixTolerantMatch — anything else is treated as a genuinely different
 *  name, not a formatting variation. */
const NAME_SUFFIXES = new Set([
  'JR', 'SR', 'II', 'III', 'IV', 'V', 'MD', 'DO', 'PT', 'DPT', 'RN', 'PHD', 'ESQ',
]);

/**
 * Suffix-tolerant match: the longer name may have exactly ONE surplus token
 * beyond the shorter name's full token set, and only if that surplus token is
 * a recognized generational/professional suffix (e.g. "JOHN SMITH JR" vs
 * "SMITH, JOHN"). An arbitrary extra token is never accepted — allowing that
 * would mean e.g. "MARY ANN JONES" matches an unrelated "ANN JONES", which is
 * exactly the kind of false positive that misattributes a claim to the wrong
 * patient.
 */
function suffixTolerantMatch(tokensA: string[], tokensB: string[]): boolean {
  const [shorter, longer] = tokensA.length <= tokensB.length
    ? [tokensA, tokensB]
    : [tokensB, tokensA];

  if (longer.length !== shorter.length + 1) return false;

  const remaining = [...longer];
  for (const t of shorter) {
    const idx = remaining.indexOf(t);
    if (idx === -1) return false; // a shorter-name token is missing entirely — not just a suffix difference
    remaining.splice(idx, 1);
  }
  return remaining.length === 1 && NAME_SUFFIXES.has(remaining[0]);
}

/**
 * Main fuzzy match function.
 *
 * @param eobName    - Name extracted from EOB/CMS1500 (e.g. "ALLISON AUYEUNG")
 * @param dashName   - Name stored in the dashboard (e.g. "AUYEUNG, ALLISON")
 * @returns true if the names refer to the same person
 */
export function fuzzyNameMatch(eobName: string, dashName: string): boolean {
  if (!eobName || !dashName) return false;

  const normEob = normalizeName(eobName);
  const normDash = normalizeName(dashName);

  // 1. Exact match (case-insensitive, punctuation-normalized)
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

  // 4. Suffix-tolerant match (e.g. "SMITH, JOHN" vs "JOHN SMITH JR") — the
  //    only case where token sets are allowed to differ, and only by one
  //    recognized suffix token. See suffixTolerantMatch for why the previous
  //    last-name+first-initial and arbitrary-subset heuristics were removed:
  //    both could match two genuinely different patients.
  if (suffixTolerantMatch(tokensEob, tokensDash)) return true;

  return false;
}

/**
 * Find the best matching patient from a list given an EOB name.
 *
 * @param eobName    - Name from EOB/CMS1500
 * @param patients   - Array of dashboard patients with { id, name, ... }
 * @returns The matched patient or null
 */
export function findMatchingPatient<T extends { name: string }>(
  eobName: string,
  patients: T[]
): T | null {
  // Try exact match first (fastest)
  const exact = patients.find(
    p => normalizeName(p.name) === normalizeName(eobName)
  );
  if (exact) return exact;

  // Try fuzzy match
  return patients.find(p => fuzzyNameMatch(eobName, p.name)) ?? null;
}
