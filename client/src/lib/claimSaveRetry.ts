/**
 * client/src/lib/claimSaveRetry.ts
 *
 * P4-P16: handleSaveExtractedClaims (client/src/pages/Dashboard.tsx) saves
 * one claims.upsert call per CPT line within a date-group "row". When a
 * row has 2+ CPT lines and more than one of them fails, the row used to be
 * pushed onto a single shared "failed" list once per failing line -- so
 * the SAME row object ended up in that list twice, which then rendered as
 * the same extracted group duplicated in the review dialog on retry, and
 * which resent lines that had already saved successfully (since the whole
 * original row, not just the failing lines, was kept).
 *
 * This module extracts the pure bookkeeping for one save attempt: which
 * CPT lines need a stable identity across retries, which failures are a
 * staff-review question (ClaimLineIdentityAmbiguousError, surfaced as a
 * tRPC CONFLICT) versus safely retryable, and how to build the row(s) that
 * survive into the next attempt. The Dashboard component calls THIS rather
 * than re-deriving the same logic inline, so a test of this module is a
 * test of the actual save/retry behavior, not a parallel reimplementation
 * that could drift out of sync with it.
 */

export type SaveLine = Record<string, any> & {
  cptCodes?: string | null;
  _sourceLineIndex?: number | null;
  notes?: string;
};

/**
 * Assigns each line's 0-based position within its (date, CPT) group ONCE,
 * storing it on the line object itself. A retry only ever resubmits the
 * subset of lines that are still unresolved -- recomputing the index from
 * that shrunken subset's array position (instead of reusing the value
 * stored here) would renumber a surviving line to a different index than
 * the one it was originally saved/matched under, pointing it at the wrong
 * existing claims_records row (see server/db.ts upsertClaimRecord).
 *
 * No-op for a line that already carries an index from a prior attempt.
 * Mutates `lines` in place.
 */
export function assignSourceLineIndices(lines: SaveLine[]): void {
  const seen = new Map<string, number>();
  for (const line of lines) {
    if (line._sourceLineIndex == null) {
      const key = (line.cptCodes ?? "").trim();
      const idx = seen.get(key) ?? 0;
      seen.set(key, idx + 1);
      line._sourceLineIndex = idx;
    }
  }
}

/**
 * True when a claims.upsert failure is ClaimLineIdentityAmbiguousError
 * (server/db.ts) surfaced over tRPC as a CONFLICT -- a pre-existing legacy
 * row whose identity can't be safely disambiguated. That needs a staff
 * decision, not a blind retry; every other error (validation, schema,
 * network) is treated as retryable.
 */
export function isReviewRequiredError(err: unknown): boolean {
  return (err as { data?: { code?: string } } | null | undefined)?.data?.code === "CONFLICT";
}

/**
 * Appends a save-failure reason to a line's existing `notes`, reusing the
 * same "⚠️ " convention the review table already renders as a warning
 * icon with a tooltip (see the bulk EOB preview table). A prior attempt's
 * own failure note is replaced rather than stacked, so re-saving doesn't
 * grow an ever-longer note on each retry.
 */
export function appendFailureNote(existingNotes: string | undefined, needsReview: boolean, message: string): string {
  const note = `⚠️ ${needsReview ? "Needs manual review" : "Save failed, safe to retry"}: ${message}`;
  const base = existingNotes && !existingNotes.includes("⚠️ ") ? existingNotes : clearFailureNote(existingNotes);
  return base ? `${base} | ${note}` : note;
}

/** Strips a previously-appended "⚠️ " failure note once its line saves,
 *  preserving any other " | "-joined note segment untouched. */
export function clearFailureNote(notes: string | undefined): string | undefined {
  if (typeof notes !== "string" || !notes.includes("⚠️ ")) return notes;
  const kept = notes.split(" | ").filter(segment => !segment.startsWith("⚠️ "));
  return kept.length > 0 ? kept.join(" | ") : undefined;
}

/**
 * Builds the row that survives into the next save attempt, carrying ONLY
 * the lines that are still unresolved. Lines that already saved in this
 * attempt are never included, so a retry can't resend them.
 */
export function buildSurvivingRow(row: Record<string, any>, stillFailingLines: SaveLine[]): Record<string, any> {
  return { ...row, cptLines: stillFailingLines };
}

/** One summary line for the whole save attempt, instead of a toast per failing row/line. */
export function summarizeSaveResult(
  saved: number,
  retryRows: Array<{ cptLines?: unknown[] }>,
  reviewRows: Array<{ cptLines?: unknown[] }>
): string {
  const failCount = retryRows.reduce((n, r) => n + (r.cptLines?.length ?? 1), 0);
  const reviewCount = reviewRows.reduce((n, r) => n + (r.cptLines?.length ?? 1), 0);
  const parts = [`${saved} saved`];
  if (failCount > 0) parts.push(`${failCount} failed (safe to retry)`);
  if (reviewCount > 0) parts.push(`${reviewCount} need manual review before retrying — see ⚠️ for each`);
  return `Save result: ${parts.join(", ")}.`;
}
