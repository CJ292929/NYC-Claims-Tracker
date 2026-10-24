/**
 * shared/claimImport.test.ts — P4-P24
 * Pure decision rules for CMS1500-first imports: period resolution, CMS1500
 * and EOB line classification, and unknown-vs-zero money totals.
 */
import { describe, expect, it } from "vitest";
import {
  classifyCms1500Line,
  classifyEobLine,
  conflictingMoneyFields,
  normalizeModifierSet,
  resolveAuthPeriod,
  sumKnownMoney,
  UPLOAD_CMS1500_FIRST,
  type ExistingClaimLine,
} from "./claimImport";

const DOC = "doc-1";

function row(over: Partial<ExistingClaimLine>): ExistingClaimLine {
  return {
    id: "r1", authPeriod: 1, dateOfService: "2026-03-02", cptCodes: "97110", modifier: "GP", unitsBilled: 1,
    diagnosisCodes: null, chargeAmount: null, insuranceReimbursement: null, patientAmountDue: null, patientAmountPaid: null,
    claimStatus: "submitted", cms1500DocumentId: null, cms1500LineKey: null, eobDocumentId: null, eobLineKey: null,
    ...over,
  };
}

const resolved = { status: "resolved", authPeriod: 2, basis: "visit_date" } as const;
const cmsLine = (over: Partial<{ sourceLineKey: string; dateOfService: string | null; cptCodes: string | null; unreadable: string[] }> = {}) => ({
  sourceLineKey: "g1:p1r1", dateOfService: "2026-03-02", cptCodes: "97110", unreadable: [] as string[], ...over,
});

describe("resolveAuthPeriod", () => {
  const visits = [
    { authPeriod: 1, dateOfService: "2026-01-05" },
    { authPeriod: 1, dateOfService: "2026-02-20" },
    { authPeriod: 2, dateOfService: "2026-03-02" },
    { authPeriod: 2, dateOfService: "2026-04-10" },
  ];

  it("uses an exact visit date, never the latest period", () => {
    expect(resolveAuthPeriod(visits, "2026-01-05")).toEqual({ status: "resolved", authPeriod: 1, basis: "visit_date" });
  });

  it("uses the single period whose recorded range covers the date", () => {
    expect(resolveAuthPeriod(visits, "2026-02-01")).toEqual({ status: "resolved", authPeriod: 1, basis: "period_range" });
    expect(resolveAuthPeriod(visits, "2026-03-20")).toEqual({ status: "resolved", authPeriod: 2, basis: "period_range" });
  });

  it("is uncertain between periods and outside every range", () => {
    expect(resolveAuthPeriod(visits, "2026-02-25")).toEqual({ status: "uncertain", options: [1, 2] });
    expect(resolveAuthPeriod(visits, "2026-06-01")).toEqual({ status: "uncertain", options: [1, 2] });
    expect(resolveAuthPeriod(visits, null)).toEqual({ status: "uncertain", options: [1, 2] });
  });

  it("is uncertain when two periods recorded the same date", () => {
    expect(resolveAuthPeriod([...visits, { authPeriod: 3, dateOfService: "2026-03-02" }], "2026-03-02")).toEqual({ status: "uncertain", options: [2, 3] });
  });

  it("resolves a single undated period, but not a patient with no visits", () => {
    expect(resolveAuthPeriod([{ authPeriod: 1, dateOfService: null }], "2026-03-02")).toMatchObject({ status: "resolved", authPeriod: 1 });
    expect(resolveAuthPeriod([], "2026-03-02")).toEqual({ status: "uncertain", options: [1] });
  });
});

describe("classifyCms1500Line", () => {
  it("is ready to create a new line when nothing sits at that date + CPT", () => {
    const c = classifyCms1500Line({ line: cmsLine(), documentId: null, siblingLineKeys: [], existing: [row({ cptCodes: "97112" })], period: resolved });
    expect(c.status).toBe("ready_new");
  });

  it("recognises a source line already saved from the same document", () => {
    const c = classifyCms1500Line({
      line: cmsLine(), documentId: DOC, siblingLineKeys: ["g1:p1r1"],
      existing: [row({ id: "saved", cms1500DocumentId: DOC, cms1500LineKey: "g1:p1r1" })], period: resolved,
    });
    expect(c).toMatchObject({ status: "already_saved", existingClaimId: "saved" });
  });

  it("does not treat a saved sibling line of the same extraction as a conflict (repeated identical lines)", () => {
    const c = classifyCms1500Line({
      line: cmsLine({ sourceLineKey: "g1:p1r2" }), documentId: DOC, siblingLineKeys: ["g1:p1r1", "g1:p1r2"],
      existing: [row({ cms1500DocumentId: DOC, cms1500LineKey: "g1:p1r1" })], period: resolved,
    });
    expect(c.status).toBe("ready_new");
  });

  it("requires a choice when a historical (reimbursement-first) row sits at the same date + CPT", () => {
    const hist = row({ id: "hist", insuranceReimbursement: 80 });
    const c = classifyCms1500Line({ line: cmsLine(), documentId: null, siblingLineKeys: [], existing: [hist], period: resolved });
    expect(c.status).toBe("needs_selection");
    expect(c.associableIds).toEqual(["hist"]);
  });

  it("requires a choice for another document's line, and does not offer to associate it", () => {
    const other = row({ id: "other", cms1500DocumentId: "doc-2", cms1500LineKey: "g9:p1r1" });
    const c = classifyCms1500Line({ line: cmsLine(), documentId: DOC, siblingLineKeys: [], existing: [other], period: resolved });
    expect(c.status).toBe("needs_selection");
    expect(c.associableIds).toEqual([]);
  });

  it("requires a choice when a re-extraction of the same file produced a different key (drift)", () => {
    const drift = row({ cms1500DocumentId: DOC, cms1500LineKey: "g1:OLDKEY" });
    const c = classifyCms1500Line({ line: cmsLine(), documentId: DOC, siblingLineKeys: ["g1:p1r1"], existing: [drift], period: resolved });
    expect(c.status).toBe("needs_selection");
  });

  it("needs a period when the date's period is uncertain, and is invalid without a readable date/CPT", () => {
    expect(classifyCms1500Line({ line: cmsLine(), documentId: null, siblingLineKeys: [], existing: [], period: { status: "uncertain", options: [1, 2] } }).status).toBe("period_required");
    expect(classifyCms1500Line({ line: cmsLine({ cptCodes: null }), documentId: null, siblingLineKeys: [], existing: [], period: resolved }).status).toBe("invalid");
    expect(classifyCms1500Line({ line: cmsLine({ unreadable: ["dateOfService"] }), documentId: null, siblingLineKeys: [], existing: [], period: resolved }).status).toBe("invalid");
  });

  it("only compares the same patient's rows on the exact date (wrong date never matches)", () => {
    const c = classifyCms1500Line({ line: cmsLine(), documentId: null, siblingLineKeys: [], existing: [row({ dateOfService: "2026-03-03" })], period: resolved });
    expect(c.status).toBe("ready_new");
  });
});

describe("classifyEobLine", () => {
  const eob = (over: Record<string, unknown> = {}) => ({
    sourceLineKey: "e1:l1", dateOfService: "2026-03-02", cptCodes: "97110", modifier: "GP", unitsBilled: 1,
    chargeAmount: 175, insuranceReimbursement: 80, patientAmountDue: 20, patientAmountPaid: null, ...over,
  });
  const cms = (over: Partial<ExistingClaimLine> = {}) => row({ cms1500DocumentId: "c1", cms1500LineKey: "g1:p1r1", ...over });

  it("is blocked with 'upload the CMS1500 first' when no CMS1500 line exists", () => {
    const c = classifyEobLine({ line: eob(), documentId: null, existing: [] });
    expect(c).toMatchObject({ status: "cms1500_required", reason: UPLOAD_CMS1500_FIRST });
  });

  it("is blocked for a historical row that has no CMS1500 yet", () => {
    const c = classifyEobLine({ line: eob(), documentId: null, existing: [row({ insuranceReimbursement: 80 })] });
    expect(c.status).toBe("cms1500_required");
    expect(c.reason).toMatch(/associate it/);
  });

  it("matches exactly one compatible CMS1500 line", () => {
    expect(classifyEobLine({ line: eob(), documentId: null, existing: [cms({ id: "t" })] })).toMatchObject({ status: "matched", targetClaimId: "t" });
  });

  it("requires a selection between identical repeated CMS1500 lines", () => {
    const c = classifyEobLine({ line: eob(), documentId: null, existing: [cms({ id: "a" }), cms({ id: "b", cms1500LineKey: "g1:p1r2" })] });
    expect(c.status).toBe("needs_selection");
    expect(c.candidates.map(x => x.id)).toEqual(["a", "b"]);
  });

  it("does not pick 'the only unpaid one' among repeated lines by elimination", () => {
    const c = classifyEobLine({ line: eob(), documentId: "e-doc", existing: [cms({ id: "a", eobDocumentId: "e-old", eobLineKey: "x" }), cms({ id: "b", cms1500LineKey: "g1:p1r2" })] });
    expect(c.status).toBe("needs_selection");
  });

  it("narrows by modifiers and units when both sides print them", () => {
    const c = classifyEobLine({
      line: eob({ cptCodes: "97140", modifier: "59, GP" }), documentId: null,
      existing: [cms({ id: "gp", cptCodes: "97140", modifier: "GP" }), cms({ id: "59gp", cptCodes: "97140", modifier: "GP, 59", cms1500LineKey: "k2" })],
    });
    expect(c).toMatchObject({ status: "matched", targetClaimId: "59gp" });
  });

  it("asks for confirmation when the only compatible line already has another EOB's payment", () => {
    const c = classifyEobLine({ line: eob(), documentId: "e-doc", existing: [cms({ id: "t", eobDocumentId: "e-old", eobLineKey: "x", insuranceReimbursement: 80 })] });
    expect(c).toMatchObject({ status: "needs_confirmation", targetClaimId: "t" });
  });

  it("asks for confirmation before replacing different existing money (manual/historical amounts)", () => {
    const c = classifyEobLine({ line: eob(), documentId: null, existing: [cms({ id: "t", insuranceReimbursement: 95 })] });
    expect(c.status).toBe("needs_confirmation");
    expect(c.reason).toMatch(/insuranceReimbursement/);
  });

  it("recognises the same EOB line already applied (reimport)", () => {
    const c = classifyEobLine({ line: eob(), documentId: "e-doc", existing: [cms({ id: "t", eobDocumentId: "e-doc", eobLineKey: "e1:l1" })] });
    expect(c).toMatchObject({ status: "already_saved", targetClaimId: "t" });
  });

  it("never matches a different date", () => {
    expect(classifyEobLine({ line: eob({ dateOfService: "2026-03-03" }), documentId: null, existing: [cms()] }).status).toBe("cms1500_required");
  });
});

describe("money helpers", () => {
  it("keeps unknown separate from zero", () => {
    expect(sumKnownMoney([null, undefined, ""])).toEqual({ total: null, unknownCount: 3 });
    expect(sumKnownMoney([0, null])).toEqual({ total: 0, unknownCount: 1 });
    expect(sumKnownMoney(["175.00", 25, null])).toEqual({ total: 200, unknownCount: 1 });
  });

  it("only reports conflicts against non-null stored values", () => {
    const r = row({ chargeAmount: 175, insuranceReimbursement: null, patientAmountDue: 20 });
    expect(conflictingMoneyFields(r, { chargeAmount: 175, insuranceReimbursement: 80, patientAmountDue: 25, patientAmountPaid: null })).toEqual(["patientAmountDue"]);
  });

  it("normalizes modifier sets regardless of order and separators", () => {
    expect(normalizeModifierSet("GP, 59")).toBe(normalizeModifierSet("59 gp"));
    expect(normalizeModifierSet(null)).toBe("");
  });
});
