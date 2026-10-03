/**
 * shared/nameMatch.ts
 *
 * Fuzzy patient name matching utility — the single implementation used by
 * both the client (single-patient upload flow + bulk import preview) and the
 * server (bulkImportFromEOB persistence). Previously server/nameMatch.ts and
 * client/src/lib/nameMatch.ts were separately hand-maintained copies of the
 * same logic; keeping one copy here means the preview a staff member sees
 * can never drift from what persistence actually does.
 *
 * This result drives which patient record an extracted claim gets saved
 * against (see bulkImportFromEOB in routers.ts),
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
 *              "RAMATI, RAQUEL M"  (middle initial — common on government-
 *                                   services/NGS-style EOBs, e.g. "NAME
 *                                   LASTNAME, FIRSTNAME MID")
 *              "O'BRIEN, JAMES"    (apostrophe) / "GARCIA-LOPEZ, MARIA" (hyphen)
 *
 * Matching strategy (in order of confidence):
 *   1. Exact match (case-insensitive) — fastest path
 *   2. Token-set match — split both names into tokens, check if same set of tokens
 *   3. Reversed-order match — "FIRST LAST" vs "LAST, FIRST" by swapping tokens
 *   4. Suffix-tolerant match — "SMITH, JOHN" matches "JOHN SMITH JR" or
 *      "JOHN Q SMITH" (every surplus token must be a recognized generational/
 *      professional suffix, e.g. JR, SR, II, MD, OR a bare 1-2 character
 *      initial — never an arbitrary full extra token, which could belong to a
 *      different person of a similar name)
 *
 * Deliberately NOT included: matching on last name + first initial alone
 * (e.g. "SMITH J" as the ENTIRE input, with no full first name anywhere), or
 * on an arbitrary subset of tokens. Both produce false positives whenever two
 * different patients share a last name and first initial, or one patient's
 * full name happens to contain another's — an unacceptable risk when the
 * result determines where a claim's money and diagnosis history get recorded.
 * This is different from tolerating a middle initial ADDED alongside an
 * otherwise-complete first+last match (see suffixTolerantMatch), which can't
 * create that kind of collision.
 */

/** Normalize a name: uppercase, drop apostrophes, turn other punctuation/
 *  hyphens into spaces, collapse whitespace. Apostrophes are dropped rather
 *  than spaced so "O'BRIEN" and "OBRIEN" normalize to the same token; hyphens
 *  become spaces so "GARCIA-LOPEZ" and "GARCIA LOPEZ" tokenize the same way. */
function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/['']/g, '')     // apostrophes (straight or curly) → dropped
    .replace(/[,.\-]/g, ' ')  // commas, dots, hyphens → space
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

/** Generational/professional suffixes tolerated as a surplus token in
 *  suffixTolerantMatch — anything else must be a bare initial (see below) or
 *  the match is treated as a genuinely different name, not a formatting
 *  variation. */
const NAME_SUFFIXES = new Set([
  'JR', 'SR', 'II', 'III', 'IV', 'V', 'MD', 'DO', 'PT', 'DPT', 'RN', 'PHD', 'ESQ',
]);

/**
 * Suffix-tolerant match: the longer name may have surplus tokens beyond the
 * shorter name's full token set, as long as EVERY surplus token is either a
 * recognized generational/professional suffix ("JOHN SMITH JR" vs
 * "SMITH, JOHN") or a bare 1-2 character initial ("NAME RAMATI, RAQUEL M" —
 * common on government-services/NGS-style EOBs that print a middle initial —
 * vs "RAMATI, RAQUEL"). An arbitrary full extra token is never accepted —
 * allowing that would mean e.g. "MARY ANN JONES" matches an unrelated "ANN
 * JONES", which is exactly the kind of false positive that misattributes a
 * claim to the wrong patient. A short token can't create that risk: two
 * different real patients differing only by inserted initials would need the
 * same first+last name tokens to begin with, which is already a vanishingly
 * rare collision this system treats as out of scope (see file header).
 */
function suffixTolerantMatch(tokensA: string[], tokensB: string[]): boolean {
  const [shorter, longer] = tokensA.length <= tokensB.length
    ? [tokensA, tokensB]
    : [tokensB, tokensA];

  if (longer.length === shorter.length) return false; // handled by exact/token-set match already

  const remaining = [...longer];
  for (const t of shorter) {
    const idx = remaining.indexOf(t);
    if (idx === -1) return false; // a shorter-name token is missing entirely — not just a suffix/initial difference
    remaining.splice(idx, 1);
  }
  return remaining.length > 0 && remaining.every(t => NAME_SUFFIXES.has(t) || t.length <= 2);
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

/**
 * Looser "candidate" detector for names fuzzyNameMatch deliberately refuses
 * to auto-match: every token of the shorter name appears, in order, inside
 * the longer name, but the longer name has extra tokens too long to be an
 * initial/suffix (e.g. a spelled-out middle name — "JOHN SMITH" vs "JOHN
 * MICHAEL SMITH"). This is NOT a safe automatic match — two different real
 * people can share a first+last name — so it must only ever be surfaced for
 * explicit staff confirmation, never used to auto-import.
 */
function isNameSubsequence(shorter: string[], longer: string[]): boolean {
  let i = 0;
  for (const token of longer) {
    if (token === shorter[i]) i++;
    if (i === shorter.length) return true;
  }
  return shorter.length === 0;
}

function isCandidateNameMatch(eobName: string, dashName: string): boolean {
  if (!eobName || !dashName) return false;
  const tokensEob = tokenize(eobName);
  const tokensDash = tokenize(dashName);
  if (tokensEob.length === tokensDash.length) return false; // equal-length diffs are fuzzyNameMatch's job
  if (tokensEob.length < 2 || tokensDash.length < 2) return false; // require a first+last anchor on both sides

  const [shorter, longer] = tokensEob.length < tokensDash.length
    ? [tokensEob, tokensDash]
    : [tokensDash, tokensEob];
  return isNameSubsequence(shorter, longer);
}

/**
 * Classifies a dashboard roster against one extracted EOB name into two
 * tiers, so callers (the bulk import preview, and the single-patient upload
 * flow it shares this module with) can tell "nothing at all in the file
 * resembles this patient" apart from "a specific name was found that looks
 * like this patient but differs by a middle name or similar — a human needs
 * to confirm it's the same person before anything is imported."
 *
 * `confirmed` is populated only by the existing safe-match rules in
 * fuzzyNameMatch (exact/token-set/reversed/suffix-or-initial-tolerant) and is
 * safe to auto-import, exactly as before. `candidates` is never safe to
 * auto-import — every caller must require an explicit confirmation action
 * before treating a candidate as a match.
 */
export function classifyPatientMatch<T extends { name: string }>(
  eobName: string,
  patients: T[]
): { confirmed: T | null; candidates: T[] } {
  // Collect EVERY roster entry that satisfies the safe-match rules, rather
  // than taking findMatchingPatient's first hit — if two roster entries both
  // qualify (e.g. a duplicate patient record, or two patients who happen to
  // share the exact same formatted name), picking the first would silently
  // misattribute the claim to whichever happens to sort first. Exact matches
  // are checked as their own tier so an unambiguous exact match still wins
  // outright even if some other patient also fuzzy-matches (see "exact match
  // wins outright" in nameMatch.test.ts).
  const exactMatches = patients.filter(p => normalizeName(p.name) === normalizeName(eobName));
  const safeMatches = exactMatches.length > 0
    ? exactMatches
    : patients.filter(p => fuzzyNameMatch(eobName, p.name));

  if (safeMatches.length === 1) return { confirmed: safeMatches[0], candidates: [] };
  if (safeMatches.length > 1) {
    // Ambiguous duplicate: never auto-import, require an explicit staff pick
    // from among exactly these matches.
    return { confirmed: null, candidates: safeMatches };
  }

  return { confirmed: null, candidates: patients.filter(p => isCandidateNameMatch(eobName, p.name)) };
}
