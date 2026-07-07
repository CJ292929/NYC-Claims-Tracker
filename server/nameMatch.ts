/**
 * server/nameMatch.ts
 *
 * Fuzzy patient name matching utility.
 *
 * Handles the common mismatch between EOB/CMS1500 formats and dashboard formats:
 *   EOB:       "ALLISON AUYEUNG"   (First Last)
 *   Dashboard: "AUYEUNG, ALLISON"  (Last, First)
 *   Also:      "AUYEUNG ALLISON"   (Last First, no comma)
 *              "Auyeung, Allison"  (mixed case)
 *              "GARCIA, ISABELA"   (already Last, First)
 *
 * Matching strategy (in order of confidence):
 *   1. Exact match (case-insensitive) — fastest path
 *   2. Token-set match — split both names into tokens, check if same set of tokens
 *   3. Reversed-order match — "FIRST LAST" vs "LAST, FIRST" by swapping tokens
 *   4. Last-name + first-initial match — "AUYEUNG A" matches "ALLISON AUYEUNG"
 *   5. Partial token overlap — all tokens of the shorter name appear in the longer
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

/**
 * Check if two name token sets overlap sufficiently.
 * Returns true if every token in the shorter name appears in the longer name.
 */
function tokenSetMatch(tokensA: string[], tokensB: string[]): boolean {
  const [shorter, longer] = tokensA.length <= tokensB.length
    ? [tokensA, tokensB]
    : [tokensB, tokensA];
  return shorter.every(t => longer.includes(t));
}

/**
 * Last-name + first-initial match.
 * "AUYEUNG A" matches "ALLISON AUYEUNG" or "AUYEUNG ALLISON".
 */
function lastNameFirstInitialMatch(tokensA: string[], tokensB: string[]): boolean {
  if (tokensA.length < 1 || tokensB.length < 1) return false;

  // Try: last token of A matches any token of B, and first char of first token of A matches first char of any token of B
  for (const a of tokensA) {
    for (const b of tokensB) {
      if (a === b) {
        // Same last name found — now check if first initials match
        const aOthers = tokensA.filter(t => t !== a);
        const bOthers = tokensB.filter(t => t !== b);
        if (aOthers.length === 0 || bOthers.length === 0) continue;
        // Check if first initials of remaining tokens match
        if (aOthers[0][0] === bOthers[0][0]) return true;
      }
    }
  }
  return false;
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

  // 4. Last-name + first-initial match
  if (lastNameFirstInitialMatch(tokensEob, tokensDash)) return true;

  // 5. Partial token overlap (all tokens of shorter appear in longer)
  //    Only apply when both names have ≥2 tokens to avoid false positives
  if (tokensEob.length >= 2 && tokensDash.length >= 2) {
    if (tokenSetMatch(tokensEob, tokensDash)) return true;
  }

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
