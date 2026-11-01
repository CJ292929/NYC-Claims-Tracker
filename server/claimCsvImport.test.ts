/**
 * server/claimCsvImport.test.ts — P4-P26
 * The two claims CSV templates through the real parser: the downloaded
 * template itself, identity stability, blank vs zero, leading zeros,
 * multi-code quoting, wrong-template refusal, and claim totals. Synthetic data.
 */
import { describe, expect, it } from "vitest";
import {
  CLAIM_CSV_TEMPLATES,
  CMS1500_CSV_FIELDS,
  EOB_CSV_FIELDS,
  buildClaimCsvTemplate,
  detectCsvTemplateFromText,
  parseCsvDate,
  parseCsvMoney,
  wrongTemplateMessage,
} from "@shared/claimCsvTemplates";
import type { Cms1500ImportLine, EobImportLine } from "@shared/claimImport";
import { csvDocumentSha256, csvLineKey, parseClaimCsv } from "./claimCsvImport";

/** The downloaded template with its EXAMPLE ids replaced — what a user would upload. */
const usable = (kind: "cms1500" | "eob", map: (t: string) => string = t => t) =>
  map(buildClaimCsvTemplate(kind).replace(/EXAMPLE-/g, "SYN-"));

const PATIENT_TEMPLATE = '"Patient Name","Insurance","Authorized Sessions"\n"John Doe","Aetna","12"\n';

describe("downloaded templates", () => {
  it("have the exact documented headers, in order", () => {
    const header = (kind: "cms1500" | "eob") => buildClaimCsvTemplate(kind).split("\r\n").find(l => !l.startsWith("#"))!;
    expect(header("cms1500")).toBe(CMS1500_CSV_FIELDS.map(f => f.header).join(","));
    expect(header("eob")).toBe(EOB_CSV_FIELDS.map(f => f.header).join(","));
    expect(CLAIM_CSV_TEMPLATES.cms1500.fileName).toBe("cms1500-import-template.csv");
    expect(CLAIM_CSV_TEMPLATES.eob.fileName).toBe("insurance-reimbursement-import-template.csv");
  });

  it("carry visible instructions, quote multi-code cells, and keep leading zeros", () => {
    const cms = buildClaimCsvTemplate("cms1500");
    expect(cms).toMatch(/^# CMS1500 import template/);
    expect(cms).toContain("# Required columns: cms1500_claim_id cms1500_line_id patient_name date_of_service cpt_code");
    expect(cms).toContain('"M54.50, M25.561"');
    expect(cms).toContain('"GP, 59"');
    expect(cms).toContain('"02"');
    const eob = buildClaimCsvTemplate("eob");
    expect(eob).toContain('"000123"');
    expect(eob).toContain("claim_status: submitted / approved / pending / denied / pended / rejected / resubmitted / needs_review");
    // Instruction lines have no commas, so a spreadsheet keeps each in one cell.
    for (const line of [...cms.split("\r\n"), ...eob.split("\r\n")].filter(l => l.startsWith("#"))) expect(line).not.toContain(",");
  });

  it("parse as-downloaded, but every EXAMPLE row is refused so samples are never imported", () => {
    for (const kind of ["cms1500", "eob"] as const) {
      const parsed = parseClaimCsv(kind, buildClaimCsvTemplate(kind));
      expect(parsed.templateError).toBeNull();
      expect(parsed.claims).toEqual([]);
      expect(parsed.rowErrors).toHaveLength(3);
      expect(parsed.rowErrors.every(e => /example row/.test(e.message))).toBe(true);
    }
  });
});

describe("CMS1500 CSV", () => {
  const parsed = parseClaimCsv("cms1500", usable("cms1500"));
  const claim = parsed.claims[0];
  const lines = claim.lines as Cms1500ImportLine[];

  it("one row per service line; identical repeated CPT lines stay distinct", () => {
    expect(parsed.rowErrors).toEqual([]);
    expect(parsed.claims).toHaveLength(1);
    expect(claim.claimId).toBe("SYN-CMS-1001");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ dateOfService: "2026-01-05", cptCodes: "97110", modifier: "GP", unitsBilled: 2, diagnosisCodes: "M54.50, M25.561", placeOfService: "11" });
    expect({ ...lines[1], sourceLineKey: "", sourceRow: 0 }).toEqual({ ...lines[0], sourceLineKey: "", sourceRow: 0 });
    expect(new Set(lines.map(l => l.sourceLineKey)).size).toBe(3);
  });

  it("normalizes MM/DD/YYYY, keeps POS 02, reads visit number only when given, never money", () => {
    expect(lines[2]).toMatchObject({ dateOfService: "2026-01-05", placeOfService: "02", modifier: "GP, 59", visitNumber: 4, claimSubmittedDate: "2026-01-10" });
    expect(lines[0].visitNumber).toBeNull();
    expect(lines.every(l => l.lineChargeForValidation === null)).toBe(true);
    expect(claim.periods).toEqual({ [lines[0].sourceLineKey]: 1, [lines[1].sourceLineKey]: 1 });
  });

  it("identity comes from the claim + line ids only: reordered and edited rows keep their keys", () => {
    const text = usable("cms1500");
    const rows = text.trim().split("\r\n");
    const header = rows.findIndex(r => !r.startsWith("#"));
    const data = rows.slice(header + 1);
    const reordered = [...rows.slice(0, header + 1), data[2], data[0], data[1].replace('"2026-01-10"', '"2026-01-12"')].join("\n");
    const again = parseClaimCsv("cms1500", reordered).claims[0];
    expect(again.sha256).toBe(claim.sha256);
    expect(again.sha256).toBe(csvDocumentSha256("cms1500", "SYN-CMS-1001"));
    const byKey = (ls: Array<{ sourceLineKey: string; cptCodes: string | null }>) => Object.fromEntries(ls.map(l => [l.sourceLineKey, l.cptCodes]));
    expect(byKey(again.lines)).toEqual(byKey(lines));
    expect(again.lines.find(l => l.sourceLineKey === lines[1].sourceLineKey)).toMatchObject({ claimSubmittedDate: "2026-01-12" });
    // Case/whitespace in ids does not create a new identity.
    expect(csvLineKey("cms1500", "SYN-CMS-1001", "2")).toBe(lines[1].sourceLineKey);
  });

  it("an unquoted multi-code cell is refused, not silently shifted into the next column", () => {
    const text = usable("cms1500").replace('"GP, 59"', "GP, 59");
    const p = parseClaimCsv("cms1500", text);
    expect(p.claims).toEqual([]);
    expect(p.blockedClaimIds).toEqual(["SYN-CMS-1001"]);
    expect(p.rowErrors.some(e => /missing its surrounding quotes/.test(e.message))).toBe(true);
  });

  it("a duplicated line id blocks the whole claim; other claims in the file still import", () => {
    const extra = '\r\n"SYN-CMS-2002","1","OTHER, PERSON","","","2026-02-02","11","97112","","1","","","",""';
    const text = usable("cms1500").trimEnd().replace(/"SYN-CMS-1001","3"/, '"SYN-CMS-1001","2"') + extra;
    const p = parseClaimCsv("cms1500", text);
    expect(p.blockedClaimIds).toEqual(["SYN-CMS-1001"]);
    expect(p.claims.map(c => c.claimId)).toEqual(["SYN-CMS-2002"]);
    expect(p.rowErrors[0].message).toMatch(/used twice in this claim/);
  });

  it("one claim belongs to one patient", () => {
    const text = usable("cms1500").replace(/("SYN-CMS-1001","3",)"SAMPLE, PATIENT"/, '$1"SOMEONE, ELSE"');
    const p = parseClaimCsv("cms1500", text);
    expect(p.claims).toEqual([]);
    expect(p.rowErrors[0].message).toMatch(/One claim belongs to one patient/);
  });

  it("a data row starting with # is an error, never a silently skipped comment", () => {
    const text = usable("cms1500").trimEnd() + '\r\n"#99","1","SAMPLE, PATIENT","","","2026-01-06","11","97110","","1","","","",""';
    const p = parseClaimCsv("cms1500", text);
    expect(p.rowErrors.some(e => /cannot start with #/.test(e.message))).toBe(true);
    expect(p.dataRowCount).toBe(4);
  });

  it("place of service that lost its leading zero is called out", () => {
    const p = parseClaimCsv("cms1500", usable("cms1500").replace('"02"', '"2"'));
    expect(p.rowErrors[0].message).toMatch(/dropped a leading zero/);
  });
});

describe("Insurance Reimbursement CSV", () => {
  const parsed = parseClaimCsv("eob", usable("eob"));
  const claim = parsed.claims[0];
  const lines = claim.lines as EobImportLine[];

  it("parses one row per adjudicated line with its CMS1500 reference", () => {
    expect(parsed.rowErrors).toEqual([]);
    expect(lines).toHaveLength(3);
    expect(claim.refs[lines[0].sourceLineKey]).toEqual({ claimId: "SYN-CMS-1001", lineId: "1" });
    expect(lines[0]).toMatchObject({ chargeAmount: 150, insuranceReimbursement: 80, patientAmountDue: 20, claimStatus: "approved", checkDate: "2026-02-01", oaClaimNumber: "SYN-PAYER-0001" });
  });

  it("blank stays unknown (null), explicit 0 is zero, responsibility is never copied into paid", () => {
    expect(lines[0].patientAmountPaid).toBeNull();
    expect(lines[1].patientAmountPaid).toBe(0);
    expect(lines[2]).toMatchObject({ insuranceReimbursement: 0, patientAmountDue: null, patientAmountPaid: null, claimStatus: "denied" });
  });

  it("keeps identifiers as text: check number 000123 and an Excel =\"...\" literal", () => {
    expect(lines[0].checkNumberVirtualCard).toBe("000123");
    const p = parseClaimCsv("eob", usable("eob").replace('"000123"', '"=""000777"""'));
    expect((p.claims[0].lines[0] as EobImportLine).checkNumberVirtualCard).toBe("000777");
  });

  it("half a CMS1500 reference is refused", () => {
    const p = parseClaimCsv("eob", usable("eob").replace('"SYN-ERA-5001","1","SYN-CMS-1001","1"', '"SYN-ERA-5001","1","SYN-CMS-1001",""'));
    expect(p.rowErrors[0].message).toMatch(/both cms1500_claim_id and cms1500_line_id/);
  });

  it("claim totals are reported for review, never written to a line", () => {
    const withTotal = usable("eob").replace(/"SYN-PAYER-0001","000123","",""/g, '"SYN-PAYER-0001","000123","160.00",""');
    const p = parseClaimCsv("eob", withTotal);
    expect(p.claims[0].unresolvedClaimTotals).toEqual([{ dateOfService: "2026-01-05", cptCodes: "97110, 97140", planPaid: 160, patientResponsibility: null, cptCount: 3 }]);
    expect((p.claims[0].lines as EobImportLine[]).map(l => l.insuranceReimbursement)).toEqual([80, 80, 0]);
    expect(p.claims[0].warnings.join(" ")).toMatch(/not saved to, divided between or copied onto any line/);
  });

  it("a claim total repeated on every line is refused", () => {
    const repeated = usable("eob")
      .replace(/"80\.00"/g, '"95.00"').replace(/"95\.00","0"/, '"95.00","95.00"')
      .replace(/"SYN-PAYER-0001","000123","",""/g, '"SYN-PAYER-0001","000123","95.00",""');
    const p = parseClaimCsv("eob", repeated);
    expect(p.claims).toEqual([]);
    expect(p.rowErrors.some(e => /repeats the claim total/.test(e.message))).toBe(true);
  });

  it("claim totals that differ between rows of one claim are refused", () => {
    let n = 0;
    const text = usable("eob").replace(/"SYN-PAYER-0001","000123","",""/g, () => `"SYN-PAYER-0001","000123","${++n === 1 ? "100.00" : "160.00"}",""`);
    expect(parseClaimCsv("eob", text).rowErrors.some(e => /different values on rows of the same claim/.test(e.message))).toBe(true);
  });
});

describe("wrong template", () => {
  it("each template is refused by the other upload, with where to upload it", () => {
    const asEob = parseClaimCsv("eob", usable("cms1500"));
    expect(asEob.templateError).toBe("This is the CMS1500 CSV template, not Insurance Reimbursement. Nothing was imported. Upload it under Bulk Upload → CMS1500.");
    const asCms = parseClaimCsv("cms1500", usable("eob"));
    expect(asCms.templateError).toMatch(/Insurance Reimbursement CSV template, not CMS1500/);
  });

  it("the patient template is refused by both claims uploads, and claims templates by the patient upload", () => {
    expect(parseClaimCsv("cms1500", PATIENT_TEMPLATE).templateError).toMatch(/patient list/);
    expect(parseClaimCsv("eob", PATIENT_TEMPLATE).templateError).toMatch(/patient list/);
    expect(detectCsvTemplateFromText(PATIENT_TEMPLATE)).toBe("patient");
    expect(wrongTemplateMessage("cms1500", detectCsvTemplateFromText(usable("eob")))).toMatch(/Bulk Upload → Insurance Reimbursement/);
    expect(wrongTemplateMessage("eob", detectCsvTemplateFromText(usable("cms1500")))).toMatch(/Bulk Upload → CMS1500/);
  });

  it("unknown, duplicate or missing columns refuse the file", () => {
    expect(parseClaimCsv("cms1500", usable("cms1500").replace("cpt_code,", "cpt,")).templateError).toMatch(/Unknown column\(s\): cpt/);
    expect(parseClaimCsv("cms1500", "cms1500_claim_id,cms1500_line_id,patient_name\n").templateError).toMatch(/Missing required column\(s\): date_of_service, cpt_code/);
    expect(parseClaimCsv("cms1500", "cms1500_claim_id,cms1500_claim_id\n").templateError).toMatch(/appears more than once/);
    expect(parseClaimCsv("eob", "").templateError).toMatch(/empty/);
  });
});

describe("cell formats", () => {
  it("dates are strict and never guessed", () => {
    expect(parseCsvDate("2026-02-30")).toMatchObject({ ok: false });
    expect(parseCsvDate("02/03/26")).toMatchObject({ ok: false });
    expect(parseCsvDate("2/3/2026")).toEqual({ ok: true, value: "2026-02-03" });
  });

  it("amounts: $ and thousands separators allowed, negatives and junk refused", () => {
    expect(parseCsvMoney("$1,234.50")).toEqual({ ok: true, value: 1234.5 });
    expect(parseCsvMoney("0")).toEqual({ ok: true, value: 0 });
    expect(parseCsvMoney("")).toEqual({ ok: true, value: null });
    expect(parseCsvMoney("-5")).toMatchObject({ ok: false });
    expect(parseCsvMoney("(5.00)")).toMatchObject({ ok: false });
    expect(parseCsvMoney("12.345")).toMatchObject({ ok: false });
  });
});
