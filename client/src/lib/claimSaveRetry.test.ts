/**
 * client/src/lib/claimSaveRetry.test.ts
 *
 * P4-P16: synthetic coverage for the save/retry bookkeeping used by
 * handleSaveExtractedClaims (client/src/pages/Dashboard.tsx), reproducing
 * the reported "BCBS extracted groups appear twice" + "2 rows failed to
 * save" symptoms down to their actual root cause -- a date-group row with
 * two failing CPT lines being appended twice to one shared "failed" list.
 */
import { describe, expect, it } from "vitest";
import {
  assignSourceLineIndices,
  isReviewRequiredError,
  appendFailureNote,
  clearFailureNote,
  buildSurvivingRow,
  summarizeSaveResult,
  type SaveLine,
} from "./claimSaveRetry";

describe("assignSourceLineIndices", () => {
  it("assigns distinct 0-based indices to two lines sharing the same CPT code (two legitimate 97140 lines)", () => {
    const lines: SaveLine[] = [{ cptCodes: "97140" }, { cptCodes: "97140" }];
    assignSourceLineIndices(lines);
    expect(lines[0]._sourceLineIndex).toBe(0);
    expect(lines[1]._sourceLineIndex).toBe(1);
  });

  it("gives each distinct CPT code its own index 0 (not a shared running counter)", () => {
    const lines: SaveLine[] = [{ cptCodes: "97110" }, { cptCodes: "97140" }];
    assignSourceLineIndices(lines);
    expect(lines[0]._sourceLineIndex).toBe(0);
    expect(lines[1]._sourceLineIndex).toBe(0);
  });

  it("is a no-op for a line that already has an index -- a retry reuses the ORIGINAL index instead of recomputing from a shrunk subset", () => {
    // Simulates retrying only the second of two repeated 97140 lines after
    // the first one already saved and was dropped from the retry set. If
    // the index were recomputed from this subset's array position, this
    // surviving line would be renumbered from 1 to 0 and collide with the
    // already-saved row instead of the one it actually corresponds to.
    const survivingLine: SaveLine = { cptCodes: "97140", _sourceLineIndex: 1 };
    assignSourceLineIndices([survivingLine]);
    expect(survivingLine._sourceLineIndex).toBe(1);
  });
});

describe("isReviewRequiredError", () => {
  it("recognizes a CONFLICT (ClaimLineIdentityAmbiguousError) as needing review", () => {
    expect(isReviewRequiredError({ data: { code: "CONFLICT" } })).toBe(true);
  });

  it("treats a schema/validation/network error as retryable, not review-required", () => {
    expect(isReviewRequiredError({ data: { code: "BAD_REQUEST" } })).toBe(false);
    expect(isReviewRequiredError({ data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
    expect(isReviewRequiredError(new Error("network error"))).toBe(false);
    expect(isReviewRequiredError(undefined)).toBe(false);
  });
});

describe("appendFailureNote / clearFailureNote", () => {
  it("appends a review-required note distinctly from a retryable one", () => {
    expect(appendFailureNote(undefined, true, "ambiguous")).toBe("⚠️ Needs manual review: ambiguous");
    expect(appendFailureNote(undefined, false, "boom")).toBe("⚠️ Save failed, safe to retry: boom");
  });

  it("preserves a pre-existing non-failure note instead of discarding it", () => {
    const note = appendFailureNote("payer printed one combined total", false, "boom");
    expect(note).toBe("payer printed one combined total | ⚠️ Save failed, safe to retry: boom");
  });

  it("replaces a stale failure note on a second attempt rather than stacking it", () => {
    const first = appendFailureNote(undefined, false, "first error");
    const second = appendFailureNote(first, true, "second error");
    expect(second).toBe("⚠️ Needs manual review: second error");
  });

  it("clearFailureNote strips only the failure note, leaving other content intact", () => {
    const withFailure = appendFailureNote("existing note", false, "boom");
    expect(clearFailureNote(withFailure)).toBe("existing note");
    expect(clearFailureNote("existing note")).toBe("existing note");
    expect(clearFailureNote(undefined)).toBeUndefined();
  });
});

describe("buildSurvivingRow", () => {
  it("carries forward ONLY the still-failing lines, not the row's full original cptLines", () => {
    const row = { dateOfService: "2026-05-01", cptLines: [{ cptCodes: "97140" }, { cptCodes: "97530" }] };
    const stillFailing = [row.cptLines[1]];
    const surviving = buildSurvivingRow(row, stillFailing);
    expect(surviving.cptLines).toHaveLength(1);
    expect(surviving.cptLines[0].cptCodes).toBe("97530");
    expect(surviving.dateOfService).toBe("2026-05-01");
  });
});

describe("P4-P16 regression: a date-group with two failing CPT lines does not duplicate in the retry set", () => {
  /** Mirrors handleSaveExtractedClaims's per-row/per-line loop structure
   *  closely enough to prove the actual bug (pushing the same row object
   *  once per failing line) is fixed, without re-rendering the Dashboard
   *  component or making a real network call. */
  function simulateSaveAttempt(
    rows: Array<{ dateOfService: string; cptLines: SaveLine[] }>,
    shouldFail: (line: SaveLine) => { fail: true; reviewRequired: boolean; message: string } | { fail: false }
  ) {
    let saved = 0;
    const retryRows: ReturnType<typeof buildSurvivingRow>[] = [];
    const reviewRows: ReturnType<typeof buildSurvivingRow>[] = [];

    for (const row of rows) {
      assignSourceLineIndices(row.cptLines);
      const stillFailing: SaveLine[] = [];
      let rowNeedsReview = false;
      for (const line of row.cptLines) {
        const outcome = shouldFail(line);
        if (!outcome.fail) {
          saved++;
          continue;
        }
        line.notes = appendFailureNote(line.notes, outcome.reviewRequired, outcome.message);
        if (outcome.reviewRequired) rowNeedsReview = true;
        stillFailing.push(line);
      }
      if (stillFailing.length > 0) {
        (rowNeedsReview ? reviewRows : retryRows).push(buildSurvivingRow(row, stillFailing));
      }
    }
    return { saved, retryRows, reviewRows };
  }

  it("one BCBS date-group whose two CPT lines BOTH fail appears exactly once in the retry set, not twice", () => {
    const rows = [
      {
        dateOfService: "2026-06-01",
        cptLines: [
          { cptCodes: "97140" } as SaveLine,
          { cptCodes: "97530" } as SaveLine,
        ],
      },
    ];

    const { saved, retryRows, reviewRows } = simulateSaveAttempt(rows, () => ({
      fail: true,
      reviewRequired: false,
      message: "insurance_reimbursement: Expected number, received string",
    }));

    expect(saved).toBe(0);
    // The old bug pushed the shared `row` reference once per failing line,
    // so this date-group would show up TWICE here (and twice in the
    // review dialog on retry). It must appear exactly once.
    expect(retryRows).toHaveLength(1);
    expect(reviewRows).toHaveLength(0);
    expect(retryRows[0].cptLines).toHaveLength(2);
  });

  it("a row with one successful and one failing line keeps the failing line only -- the successful line is never resent", () => {
    const rows = [
      {
        dateOfService: "2026-06-02",
        cptLines: [
          { cptCodes: "97140", _tag: "ok" } as SaveLine,
          { cptCodes: "97530", _tag: "bad" } as SaveLine,
        ],
      },
    ];

    const { saved, retryRows } = simulateSaveAttempt(rows, (line) =>
      line._tag === "bad" ? { fail: true, reviewRequired: false, message: "boom" } : { fail: false }
    );

    expect(saved).toBe(1);
    expect(retryRows).toHaveLength(1);
    expect(retryRows[0].cptLines).toHaveLength(1);
    expect(retryRows[0].cptLines[0]._tag).toBe("bad");
  });

  it("review-required and merely-retryable failures land in separate buckets", () => {
    const rows = [
      { dateOfService: "2026-06-03", cptLines: [{ cptCodes: "97140", _tag: "conflict" } as SaveLine] },
      { dateOfService: "2026-06-04", cptLines: [{ cptCodes: "97530", _tag: "transient" } as SaveLine] },
    ];

    const { retryRows, reviewRows } = simulateSaveAttempt(rows, (line) =>
      line._tag === "conflict"
        ? { fail: true, reviewRequired: true, message: "identity ambiguous" }
        : { fail: true, reviewRequired: false, message: "transient" }
    );

    expect(reviewRows).toHaveLength(1);
    expect(retryRows).toHaveLength(1);
    expect(reviewRows[0].dateOfService).toBe("2026-06-03");
    expect(retryRows[0].dateOfService).toBe("2026-06-04");
  });

  it("retrying preserves each surviving line's original sourceLineIndex across attempts", () => {
    const lineA: SaveLine = { cptCodes: "97140" };
    const lineB: SaveLine = { cptCodes: "97140" };
    const rows = [{ dateOfService: "2026-06-05", cptLines: [lineA, lineB] }];

    // Attempt 1: lineA (index 0) saves, lineB (index 1) fails.
    const first = simulateSaveAttempt(rows, (line) => (line === lineA ? { fail: false } : { fail: true, reviewRequired: false, message: "boom" }));
    expect(first.saved).toBe(1);
    expect(first.retryRows).toHaveLength(1);
    expect(lineB._sourceLineIndex).toBe(1);

    // Attempt 2 (retry): only lineB is resubmitted. Its index must still
    // be 1, not recomputed as 0 from being alone in the retry set.
    const retryRow = first.retryRows[0];
    const second = simulateSaveAttempt([retryRow as any], () => ({ fail: false }));
    expect(second.saved).toBe(1);
    expect(lineB._sourceLineIndex).toBe(1);
  });
});

describe("summarizeSaveResult", () => {
  it("produces one summary string covering saved/failed/review counts instead of per-row toasts", () => {
    const retryRows = [{ cptLines: [{}, {}] }];
    const reviewRows = [{ cptLines: [{}] }];
    expect(summarizeSaveResult(3, retryRows, reviewRows)).toBe(
      "Save result: 3 saved, 2 failed (safe to retry), 1 need manual review before retrying — see ⚠️ for each."
    );
  });

  it("omits the failed/review clauses entirely when there are none", () => {
    expect(summarizeSaveResult(5, [], [])).toBe("Save result: 5 saved.");
  });
});
