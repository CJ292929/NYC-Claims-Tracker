/**
 * server/cms1500ExportCsv.test.ts — P4-P28
 *
 * The billing system's invoice export, parsed for real with synthetic rows of
 * the same shape (server/fixtures/cms1500ExportSynthetic.ts). No database.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));

import { detectCsvTemplateFromText, wrongTemplateMessage } from "@shared/claimCsvTemplates";
import type { Cms1500ImportLine } from "@shared/claimImport";
import { applyCsvLineEdits, parseClaimCsv } from "./claimCsvImport";
import { exportIdentityConflicts, parseCms1500Export, parseExportDescription } from "./cms1500ExportCsv";
import { EXPORT_HEADER, exportCsv, exportRow } from "./fixtures/cms1500ExportSynthetic";

const lines = (claim: { lines: unknown[] }) => claim.lines as Cms1500ImportLine[];

describe("actual export shape", () => {
  const file = exportCsv(exportRow({ invoice: "SYN1-C01" }), exportRow({ invoice: "SYN2-C01", serviceDate: "2026-02-04" }));

  it("is recognized from its headers and only readable under CMS1500", () => {
    expect(detectCsvTemplateFromText(file)).toBe("cms1500_export");
    expect(wrongTemplateMessage("cms1500", "cms1500_export")).toBeNull();
    expect(parseClaimCsv("eob", file).templateError).toMatch(/Upload it under Bulk Upload → CMS1500/);
  });

  it("reads quoted commas and embedded newlines as one row per invoice, several lines per row", () => {
    const parsed = parseClaimCsv("cms1500", file);
    expect(parsed.templateError).toBeNull();
    expect(parsed.rowErrors).toEqual([]);
    expect(parsed.dataRowCount).toBe(2);
    expect(parsed.claims.map(c => c.claimId)).toEqual(["SYN1-C01", "SYN2-C01"]);
    expect(parsed.claims[0].lines).toHaveLength(3);
  });

  it("maps each service block to its own CPT, units and diagnosis codes", () => {
    const [claim] = parseClaimCsv("cms1500", file).claims;
    expect(lines(claim).map(l => [l.cptCodes, l.unitsBilled, l.diagnosisCodes])).toEqual([
      ["97530", 1, "M54.50, M25.561"],
      ["97530", 1, "M54.50, M25.561"],
      ["97112", 1, "M54.50"],
    ]);
    expect(lines(claim).every(l => l.unreadable.length === 0)).toBe(true);
  });

  it("uses Service Date(s), never Invoice Date(s)", () => {
    const [claim] = parseClaimCsv("cms1500", exportCsv(exportRow({ invoice: "SYN1-C01", invoiceDate: "2026-05-05", serviceDate: "2026-02-02" }))).claims;
    expect(new Set(lines(claim).map(l => l.dateOfService))).toEqual(new Set(["2026-02-02"]));
  });

  it("never reads a payment or an amount from Total, Balance, prices or coinsurance", () => {
    const [claim] = parseClaimCsv("cms1500", exportCsv(exportRow({ invoice: "SYN1-C01", total: "999.99", balance: "888.88" }))).claims;
    expect(JSON.stringify(claim)).not.toMatch(/999\.99|888\.88|350|175/);
    for (const l of lines(claim)) expect(l.lineChargeForValidation).toBeNull();
    for (const l of lines(claim)) {
      expect(l).not.toHaveProperty("chargeAmount");
      expect(l).not.toHaveProperty("insuranceReimbursement");
    }
  });

  it("treats patient_guid as a namespaced external id, and keeps ids as strings", () => {
    const [claim] = parseClaimCsv("cms1500", exportCsv(exportRow({ invoice: "000123-C01", guid: "000456-1", birthDate: "1950-03-14" }))).claims;
    expect(claim.claimId).toBe("000123-C01");
    expect(claim.patientId).toBeNull();
    expect(claim.identity).toEqual({ sourceSystem: "billing_invoice_export", externalId: "000456-1", strength: "patient", birthDate: "1950-03-14", conflict: null });
  });
});

describe("stable identity", () => {
  const a = exportRow({ invoice: "SYN1-C01" });
  const b = exportRow({ invoice: "SYN2-C01", serviceDate: "2026-02-04" });

  it("repeated services stay distinct lines", () => {
    const keys = lines(parseClaimCsv("cms1500", exportCsv(a)).claims[0]).map(l => l.sourceLineKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("reordering rows or service blocks keeps every key", () => {
    const keysOf = (csv: string) => new Set(parseClaimCsv("cms1500", csv).claims.flatMap(c => lines(c).map(l => l.sourceLineKey)));
    const shuffled = exportRow({
      invoice: "SYN1-C01",
      description: `Synthetic Health Plan #SYN000 / 00000
1x 97112 - Neuromuscular reeducation ($175.00)
M54.50
1x 97530 - Therapeutic activities ($175.00)
M54.50, M25.561
1x 97530 - Therapeutic activities ($175.00)
M54.50, M25.561
Coinsurance: $350.00`,
    });
    expect(keysOf(exportCsv(b, a))).toEqual(keysOf(exportCsv(a, b)));
    expect(keysOf(exportCsv(shuffled, b))).toEqual(keysOf(exportCsv(a, b)));
  });

  it("the document identity comes from the invoice number, not the file", () => {
    const one = parseClaimCsv("cms1500", exportCsv(a)).claims[0];
    const two = parseClaimCsv("cms1500", exportCsv(b, a)).claims[1];
    expect(two.sha256).toBe(one.sha256);
  });

  it("an exact repeat of an invoice is one invoice; a different repeat is refused", () => {
    expect(parseClaimCsv("cms1500", exportCsv(a, a)).claims).toHaveLength(1);
    const parsed = parseClaimCsv("cms1500", exportCsv(a, exportRow({ invoice: "SYN1-C01", serviceDate: "2026-02-09" })));
    expect(parsed.claims).toHaveLength(0);
    expect(parsed.rowErrors[0].message).toMatch(/also on row/);
  });

  it("does not collide with a CMS1500 template claim of the same id", () => {
    const exportClaim = parseClaimCsv("cms1500", exportCsv(exportRow({ invoice: "SAME-ID" }))).claims[0];
    expect(exportClaim.sha256).not.toBe(parseClaimCsv("cms1500", 'cms1500_claim_id,cms1500_line_id,patient_name,date_of_service,cpt_code\nSAME-ID,1,"A, B",2026-01-01,97110').claims[0].sha256);
  });
});

describe("nothing is guessed", () => {
  it("a vague description has no CPT or units, and goes to review with its text", () => {
    const { services } = parseExportDescription("Synthetic Plan\n1x Home visit ($100.00)\nM54.50\nFollow-up call with family");
    expect(services[0]).toMatchObject({ cptCode: null, units: 1, diagnosisCodes: "M54.50" });
    expect(services[0].unreadable).toEqual(["cptCodes"]);
    expect(services[0].notes).toMatch(/Home visit/);
    // Text the adapter does not understand is never silently dropped.
    expect(services[1]).toMatchObject({ cptCode: null, units: null });
    expect(services[1].unreadable).toEqual(expect.arrayContaining(["cptCodes", "unitsBilled", "diagnosisCodes"]));
  });

  it("a five-letter word is not a CPT code", () => {
    expect(parseExportDescription("Plan\n1x THERA - Therapy ($1.00)\nM54.50").services[0].cptCode).toBeNull();
  });

  it("reads HCPCS codes and printed modifiers, and invents no modifier", () => {
    const { services } = parseExportDescription("Plan\n2x G0283 GP 59 - Electrical stim ($1.00)\nM54.50\n1x 97110 - Exercises ($1.00)\nM54.50");
    expect(services[0]).toMatchObject({ cptCode: "G0283", modifiers: "GP, 59", units: 2 });
    expect(services[1]).toMatchObject({ cptCode: "97110", modifiers: null });
  });

  it("missing units and bad diagnosis values are flagged", () => {
    const { services } = parseExportDescription("Plan\n97110 - Exercises ($1.00)\nM54.50, NOTACODE, M25.561");
    expect(services[0].units).toBeNull();
    expect(services[0].diagnosisCodes).toBeNull();
    expect(services[0].unreadable).toEqual(expect.arrayContaining(["unitsBilled", "diagnosisCodes"]));
  });

  it("several service dates leave each line's date to the reviewer", () => {
    const [claim] = parseClaimCsv("cms1500", exportCsv(exportRow({ invoice: "SYN1-C01", serviceDate: '"2026-02-02, 2026-02-04"' }))).claims;
    const l = lines(claim)[0];
    expect(l.dateOfService).toBeNull();
    expect(l.unreadable).toContain("dateOfService");
    expect(claim.lineDateOptions![l.sourceLineKey]).toEqual(["2026-02-02", "2026-02-04"]);
    expect(claim.warnings.join(" ")).toMatch(/2 service dates/);
  });

  it("an empty description or invoice number is a row error, not a guess", () => {
    const parsed = parseClaimCsv("cms1500", exportCsv(exportRow({ invoice: "SYN1-C01", description: "Only a payer line" }), exportRow({ invoice: "" })));
    expect(parsed.claims).toHaveLength(0);
    expect(parsed.rowErrors.map(e => e.message).join(" ")).toMatch(/Invoice # is empty/);
    expect(parsed.rowErrors.map(e => e.message).join(" ")).toMatch(/No service lines/);
  });

  it("names exactly which required columns are missing", () => {
    const parsed = parseClaimCsv("cms1500", "Invoice #,Description,Patient\nX,1x 97110 - E,Y\n");
    expect(parsed.templateError).toMatch(/missing required column\(s\): service date\(s\)/);
  });
});

describe("review values for flagged fields", () => {
  const line: Cms1500ImportLine = {
    sourceLineKey: "g1:csv.X.0", page: null, slot: null, dateOfService: null, placeOfService: null, cptCodes: null, modifier: null, unitsBilled: null,
    diagnosisPointer: null, diagnosisCodes: null, claimSubmittedDate: null, insuranceBilled: null, lineChargeForValidation: null,
    unreadable: ["dateOfService", "cptCodes", "unitsBilled", "diagnosisCodes"], notes: null,
  };

  it("accepts valid values and clears those flags", () => {
    const out = applyCsvLineEdits(line, { dateOfService: "2026-02-04", cptCodes: "97110", unitsBilled: 2, diagnosisCodes: "m54.50, M25.561" }, ["2026-02-02", "2026-02-04"]);
    expect(out).toMatchObject({ dateOfService: "2026-02-04", cptCodes: "97110", unitsBilled: 2, diagnosisCodes: "M54.50, M25.561", unreadable: [] });
  });

  it("a date the file does not list, a vague CPT or bad diagnosis stays flagged", () => {
    const out = applyCsvLineEdits(line, { dateOfService: "2026-03-01", cptCodes: "visit", diagnosisCodes: "not a code" }, ["2026-02-02", "2026-02-04"]);
    expect(out.dateOfService).toBeNull();
    expect(out.cptCodes).toBeNull();
    expect(out.unreadable).toEqual(expect.arrayContaining(["dateOfService", "cptCodes", "diagnosisCodes"]));
  });

  it("a field that was read from the file cannot be edited", () => {
    const readLine = { ...line, cptCodes: "97530", unreadable: ["unitsBilled"] };
    expect(applyCsvLineEdits(readLine, { cptCodes: "97110" }, []).cptCodes).toBe("97530");
  });
});

describe("file-level identity conflicts", () => {
  const parse = (...rows: string[]) => parseCms1500Export(exportCsv(...rows), 0, 1000).invoices;

  it("one guid with two birth dates or two names", () => {
    const dob = exportIdentityConflicts(parse(exportRow({ invoice: "A" }), exportRow({ invoice: "B", birthDate: "1951-01-01" })));
    expect(dob.get("A")).toMatch(/more than one Birth Date/);
    const name = exportIdentityConflicts(parse(exportRow({ invoice: "A" }), exportRow({ invoice: "B", patient: "Sam Otherperson" })));
    expect(name.get("B")).toMatch(/more than one patient name/);
  });

  it("one name with two guids", () => {
    const c = exportIdentityConflicts(parse(exportRow({ invoice: "A" }), exportRow({ invoice: "B", guid: "S2002-1" })));
    expect(c.get("A")).toMatch(/more than one patient_guid/);
  });

  it("the same person across invoices is no conflict, whatever the name order", () => {
    expect(exportIdentityConflicts(parse(exportRow({ invoice: "A" }), exportRow({ invoice: "B", patient: "Testpatient, Alex" }))).size).toBe(0);
  });

  it("the header row alone is refused", () => {
    expect(parseClaimCsv("cms1500", EXPORT_HEADER + "\n").templateError).toMatch(/no data rows/);
  });
});
