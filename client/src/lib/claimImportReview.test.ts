/**
 * client/src/lib/claimImportReview.test.ts — P4-P24
 * Review-dialog state rules: starting decisions, what Save/Retry sends,
 * reviewer edits, and bounded per-file concurrency.
 */
import { describe, expect, it } from "vitest";
import type { Cms1500ImportLine, EobImportLine, ImportDocument } from "@shared/claimImport";
import {
  applyLineEdits,
  buildCommitInput,
  buildCsvCommitInputs,
  buildCsvPreviewInput,
  buildPreviewInput,
  decisionReady,
  initialDecision,
  fileIdentity,
  runWithConcurrency,
  splitPdfFiles,
  summarizeFiles,
  summarizeResults,
  type FileReviewState,
} from "./claimImportReview";

const SHA = "a".repeat(64);

function cmsLine(key: string, over: Partial<Cms1500ImportLine> = {}): Cms1500ImportLine {
  return {
    sourceLineKey: key, page: 1, slot: 1, dateOfService: "2026-03-02", placeOfService: "12", cptCodes: "97110", modifier: "GP",
    unitsBilled: 1, diagnosisPointer: "A", diagnosisCodes: "M54.50", claimSubmittedDate: null, insuranceBilled: null,
    lineChargeForValidation: 175, unreadable: [], notes: null, ...over,
  };
}

function cmsState(lines: Cms1500ImportLine[], over: Partial<FileReviewState> = {}): FileReviewState {
  const doc: ImportDocument = {
    kind: "cms1500", sha256: SHA, fileName: "x.pdf", pageCount: 1, extractionMethod: "test", warnings: [],
    groups: [{ groupKey: "g1", patientName: "TESTPATIENT, ALEX", pages: [1], claimIdentifier: null, lines, warnings: [], unresolvedClaimTotals: [] }],
  };
  return { doc, patientChoice: {}, patientConfirmed: {}, decisions: {}, edits: {}, results: {}, ...over };
}

const preview = (over: Record<string, unknown>) => ({ sourceLineKey: "k", kind: "cms1500", candidates: [], associableIds: [], ...over }) as any;

describe("initialDecision", () => {
  it("auto-decides only lines with nothing to choose", () => {
    expect(initialDecision({ kind: "cms1500", mode: "bulk", contextAuthPeriod: null, line: preview({ status: "ready_new", period: { status: "resolved", authPeriod: 2, basis: "visit_date" } }) }))
      .toEqual({ action: "create", authPeriod: 2, periodSource: "resolved" });
    expect(initialDecision({ kind: "cms1500", mode: "bulk", contextAuthPeriod: null, line: preview({ status: "already_saved", period: { status: "uncertain", options: [1] } }) }))
      .toEqual({ action: "create" });
    for (const status of ["needs_selection", "invalid", "patient_required"]) {
      expect(initialDecision({ kind: "cms1500", mode: "bulk", contextAuthPeriod: 1, line: preview({ status, period: { status: "resolved", authPeriod: 1, basis: "visit_date" } }) })).toBeNull();
    }
  });

  it("uses the upload's period for an uncertain date only in single-patient mode, and only if it is a real option", () => {
    const line = preview({ status: "period_required", period: { status: "uncertain", options: [1, 2] } });
    expect(initialDecision({ kind: "cms1500", mode: "single", contextAuthPeriod: 2, line })).toEqual({ action: "create", authPeriod: 2, periodSource: "context" });
    expect(initialDecision({ kind: "cms1500", mode: "single", contextAuthPeriod: 3, line })).toBeNull();
    expect(initialDecision({ kind: "cms1500", mode: "bulk", contextAuthPeriod: 2, line })).toBeNull();
  });

  it("applies an EOB line only to its single matched target; selection and replacement wait for the reviewer", () => {
    expect(initialDecision({ kind: "eob", mode: "bulk", contextAuthPeriod: null, line: { ...preview({ status: "matched", targetClaimId: "t1" }), kind: "eob" } }))
      .toEqual({ action: "apply", claimRecordId: "t1" });
    for (const status of ["needs_selection", "needs_confirmation", "cms1500_required", "invalid"]) {
      expect(initialDecision({ kind: "eob", mode: "bulk", contextAuthPeriod: null, line: { ...preview({ status, targetClaimId: "t1" }), kind: "eob" } })).toBeNull();
    }
  });
});

describe("decisionReady", () => {
  it("requires a target for associate/apply and an acknowledgement for flagged lines", () => {
    expect(decisionReady("cms1500", { action: "associate" }, [])).toBe(false);
    expect(decisionReady("cms1500", { action: "associate", claimRecordId: "r" }, [])).toBe(true);
    expect(decisionReady("cms1500", { action: "create" }, ["unitsBilled"])).toBe(false);
    expect(decisionReady("cms1500", { action: "create", acknowledgeFlags: true }, ["unitsBilled"])).toBe(true);
    expect(decisionReady("eob", { action: "apply" }, [])).toBe(false);
    expect(decisionReady("eob", { action: "skip" }, [])).toBe(true);
    expect(decisionReady("cms1500", null, [])).toBe(false);
  });
});

describe("buildCommitInput", () => {
  it("sends only unfinished, decided lines — with their original keys and the full key list", () => {
    const lines = [cmsLine("g1:p1r1"), cmsLine("g1:p1r2"), cmsLine("g1:p1r3"), cmsLine("g1:p1r4")];
    const state = cmsState(lines, {
      decisions: { "g1:p1r1": { action: "create" }, "g1:p1r2": { action: "create" }, "g1:p1r3": null, "g1:p1r4": { action: "create" } },
      results: { "g1:p1r1": { sourceLineKey: "g1:p1r1", status: "saved" }, "g1:p1r4": { sourceLineKey: "g1:p1r4", status: "failed" } } as any,
    });
    const input = buildCommitInput({ state, contextPatientId: null, contextAuthPeriod: null })!;
    expect(input.groups).toHaveLength(1);
    expect(input.groups[0].lines.map(l => l.sourceLineKey)).toEqual(["g1:p1r2", "g1:p1r4"]);
    expect(input.groups[0].allLineKeys).toEqual(["g1:p1r1", "g1:p1r2", "g1:p1r3", "g1:p1r4"]);
  });

  it("returns null when nothing is ready (so a double-click can't send an empty or repeated save)", () => {
    const state = cmsState([cmsLine("g1:p1r1")], { results: { "g1:p1r1": { sourceLineKey: "g1:p1r1", status: "unchanged" } } as any, decisions: { "g1:p1r1": { action: "create" } } });
    expect(buildCommitInput({ state, contextPatientId: null, contextAuthPeriod: null })).toBeNull();
  });

  it("carries reviewer edits, clearing the edited field's unreadable flag", () => {
    const state = cmsState([cmsLine("g1:p1r1", { unitsBilled: null, unreadable: ["unitsBilled", "modifier"], modifier: null })], {
      edits: { "g1:p1r1": { unitsBilled: 2 } },
      decisions: { "g1:p1r1": { action: "create", acknowledgeFlags: true } },
    });
    const line = buildCommitInput({ state, contextPatientId: null, contextAuthPeriod: null })!.groups[0].lines[0] as any;
    expect(line.unitsBilled).toBe(2);
    expect(line.unreadable).toEqual(["modifier"]);
  });

  it("never sends money from a CMS1500 line", () => {
    const state = cmsState([cmsLine("g1:p1r1")], { decisions: { "g1:p1r1": { action: "create" } } });
    const line = buildCommitInput({ state, contextPatientId: null, contextAuthPeriod: null })!.groups[0].lines[0] as Record<string, unknown>;
    for (const k of ["chargeAmount", "insuranceReimbursement", "patientAmountDue", "patientAmountPaid", "lineChargeForValidation", "visitNumber"]) {
      expect(line).not.toHaveProperty(k);
    }
  });

  it("maps EOB lines with a normalized claim status and their decision", () => {
    const eob: EobImportLine = {
      sourceLineKey: "e1:l", page: null, dateOfService: "2026-03-02", cptCodes: "97110", modifier: "GP", unitsBilled: 1,
      chargeAmount: 175, insuranceReimbursement: 80, patientAmountDue: 20, patientAmountPaid: null, claimStatus: "Approved",
      oaClaimNumber: null, checkDate: null, checkNumberVirtualCard: null, notes: null,
    };
    const state = cmsState([], { decisions: { "e1:l": { action: "apply", claimRecordId: "t" } } });
    state.doc = { ...state.doc, kind: "eob", groups: [{ ...state.doc.groups[0], lines: [eob] }] };
    const input = buildCommitInput({ state, contextPatientId: "p", contextAuthPeriod: 2 })!;
    expect(input.kind).toBe("eob");
    expect(input.contextPatientId).toBe("p");
    expect(input.groups[0].lines[0]).toMatchObject({ claimStatus: "approved", patientAmountDue: 20, patientAmountPaid: null, decision: { action: "apply", claimRecordId: "t" } });
  });
});

describe("helpers", () => {
  it("builds a preview request with edits and patient choices", () => {
    const state = cmsState([cmsLine("g1:p1r1", { cptCodes: null, unreadable: ["cptCodes"] })], { edits: { "g1:p1r1": { cptCodes: "97112" } }, patientChoice: { g1: "p-1" } });
    const input = buildPreviewInput({ state, contextPatientId: null }) as any;
    expect(input.groups[0].patientId).toBe("p-1");
    expect(input.groups[0].lines[0]).toMatchObject({ cptCodes: "97112", unreadable: [] });
  });

  it("leaves a line untouched without edits", () => {
    const l = cmsLine("k");
    expect(applyLineEdits(l, undefined)).toBe(l);
  });

  it("summarizes per-file results", () => {
    const state = cmsState([cmsLine("a"), cmsLine("b"), cmsLine("c")], { results: { a: { status: "saved" }, b: { status: "review_required" } } as any });
    expect(summarizeResults(state)).toMatchObject({ total: 3, saved: 1, review: 1, pending: 2 });
  });

  it("bounds concurrency and isolates failures", async () => {
    let active = 0, peak = 0;
    const out = await runWithConcurrency([1, 2, 3, 4, 5], 2, async n => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      if (n === 3) throw new Error("bad file");
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(out.map(r => r.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"]);
    expect((out[4] as PromiseFulfilledResult<number>).value).toBe(50);
  });
});

describe("P4-P26 CSV requests", () => {
  const source = { kind: "cms1500" as const, fileName: "cms.csv", csvText: "cms1500_claim_id,cms1500_line_id\n" };
  const withGroups = (n: number, linesPer: number): FileReviewState => {
    const base = cmsState([]);
    const groups = Array.from({ length: n }, (_, g) => ({
      ...base.doc.groups[0], groupKey: `g${g}`,
      lines: Array.from({ length: linesPer }, (_, i) => cmsLine(`g${g}:csv.${i}`)),
    }));
    const decisions: FileReviewState["decisions"] = {};
    for (const g of groups) for (const l of g.lines) decisions[l.sourceLineKey] = { action: "create", authPeriod: 1, periodSource: "resolved" };
    return { ...base, doc: { ...base.doc, groups }, decisions };
  };

  it("sends only decisions and patient input — never line values or keys the file did not produce", () => {
    const state = withGroups(1, 2);
    state.patientChoice = { g0: "11111111-1111-4111-8111-111111111111" };
    state.patientConfirmed = { g0: true };
    const [batch] = buildCsvCommitInputs({ source, state });
    expect(batch).toEqual({
      ...source,
      groups: [{
        groupKey: "g0", patientId: "11111111-1111-4111-8111-111111111111", patientConfirmed: true,
        lines: [
          { sourceLineKey: "g0:csv.0", decision: { action: "create", authPeriod: 1, periodSource: "resolved" } },
          { sourceLineKey: "g0:csv.1", decision: { action: "create", authPeriod: 1, periodSource: "resolved" } },
        ],
      }],
    });
    expect(buildCsvPreviewInput({ source, state })).toEqual({ ...source, patientChoices: { g0: "11111111-1111-4111-8111-111111111111" } });
  });

  it("splits large files into bounded requests without splitting a claim, and never resends done lines", () => {
    const state = withGroups(5, 40);
    const batches = buildCsvCommitInputs({ source, state, maxLines: 100 });
    expect(batches.map(b => b.groups.map(g => g.lines.length))).toEqual([[40, 40], [40, 40], [40]]);
    state.results["g0:csv.0"] = { sourceLineKey: "g0:csv.0", status: "saved" };
    state.results["g1:csv.3"] = { sourceLineKey: "g1:csv.3", status: "review_required", reason: "needs_selection" };
    const retry = buildCsvCommitInputs({ source, state, maxLines: 1000 });
    const keys = retry.flatMap(b => b.groups.flatMap(g => g.lines.map(l => l.sourceLineKey)));
    expect(keys).not.toContain("g0:csv.0");
    expect(keys).toContain("g1:csv.3");
    expect(keys).toHaveLength(199);
  });

  it("nothing ready → no request", () => {
    const state = withGroups(1, 1);
    state.decisions = {};
    expect(buildCsvCommitInputs({ source, state })).toEqual([]);
  });
});

describe("P4-P27 PDF-first bulk uploads", () => {
  it("summarizes files: read, reading, failed, fully saved, and still to review", () => {
    const savedState = cmsState([cmsLine("a"), cmsLine("b")], { results: { a: { status: "saved" }, b: { status: "unchanged" } } as any });
    const partState = cmsState([cmsLine("c"), cmsLine("d")], { results: { c: { status: "saved" }, d: { status: "failed" } } as any });
    const s = summarizeFiles([
      { stage: "queued" },
      { stage: "extracting" },
      { stage: "checking", review: cmsState([cmsLine("x")]) },
      { stage: "failed" },
      { stage: "review", review: savedState },
      { stage: "review", review: partState },
      { stage: "review", review: cmsState([cmsLine("e")]) },
    ]);
    expect(s).toEqual({ total: 7, read: 4, reading: 3, failed: 1, saved: 1, needsReview: 2 });
  });

  it("a failed file does not hide another file's saved outcome", () => {
    const savedState = cmsState([cmsLine("a")], { results: { a: { status: "saved" } } as any });
    expect(summarizeFiles([{ stage: "failed" }, { stage: "review", review: savedState }])).toMatchObject({ failed: 1, saved: 1, needsReview: 0 });
  });

  it("identifies the same file picked twice, not two different files with the same name", () => {
    const a = { name: "cms.pdf", size: 10, lastModified: 1 };
    expect(fileIdentity(a)).toBe(fileIdentity({ ...a }));
    expect(fileIdentity(a)).not.toBe(fileIdentity({ ...a, size: 11 }));
  });

  it("keeps PDFs by type or extension and rejects everything else", () => {
    const { pdfs, rejected } = splitPdfFiles([
      { name: "a.pdf", type: "application/pdf" },
      { name: "B.PDF", type: "" },
      { name: "scan", type: "application/pdf" },
      { name: "remit.csv", type: "text/csv" },
      { name: "photo.jpg", type: "image/jpeg" },
    ]);
    expect(pdfs.map(f => f.name)).toEqual(["a.pdf", "B.PDF", "scan"]);
    expect(rejected.map(f => f.name)).toEqual(["remit.csv", "photo.jpg"]);
  });
});
