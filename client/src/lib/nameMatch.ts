/**
 * client/src/lib/nameMatch.ts
 *
 * Client-side fuzzy patient name matching utility.
 * Mirrors server/nameMatch.ts — keep both in sync if logic changes.
 *
 * Handles format mismatches between EOB/CMS1500 and dashboard:
 *   EOB:       "ALLISON AUYEUNG"   (First Last)
 *   Dashboard: "AUYEUNG, ALLISON"  (Last, First)
 */

/** Normalize a name: uppercase, remove commas/punctuation, collapse whitespace */
function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[,.]/g, ' ')
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

/** Check if two name token sets overlap sufficiently */
function tokenSetMatch(tokensA: string[], tokensB: string[]): boolean {
  const [shorter, longer] = tokensA.length <= tokensB.length
    ? [tokensA, tokensB]
    : [tokensB, tokensA];
  return shorter.every(t => longer.includes(t));
}

/** Last-name + first-initial match */
function lastNameFirstInitialMatch(tokensA: string[], tokensB: string[]): boolean {
  if (tokensA.length < 1 || tokensB.length < 1) return false;
  for (const a of tokensA) {
    for (const b of tokensB) {
      if (a === b) {
        const aOthers = tokensA.filter(t => t !== a);
        const bOthers = tokensB.filter(t => t !== b);
        if (aOthers.length === 0 || bOthers.length === 0) continue;
        if (aOthers[0][0] === bOthers[0][0]) return true;
      }
    }
  }
  return false;
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

  // 4. Last-name + first-initial match
  if (lastNameFirstInitialMatch(tokensEob, tokensDash)) return true;

  // 5. Partial token overlap (all tokens of shorter appear in longer)
  if (tokensEob.length >= 2 && tokensDash.length >= 2) {
    if (tokenSetMatch(tokensEob, tokensDash)) return true;
  }

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
