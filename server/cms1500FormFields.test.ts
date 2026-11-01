/**
 * server/cms1500FormFields.test.ts — P4-P28
 *
 * Fillable CMS-1500s, read for real by pdfjs from generated PDFs with invented
 * values. The text layer of these PDFs holds only labels, which is why a text
 * parser finds no service lines in them. No AI involved or mocked.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));

import { assembleCms1500Pages, parseFormBirthDate, renderPdfPages, standardFontDataUrl } from "./cms1500Vision";
import { collectTextFields, formFieldsToPage, readCms1500FormPages } from "./cms1500FormFields";
import { parseCMS1500 } from "./insuranceTemplates";
import { formHeader, formRow, syntheticFormPdf } from "./fixtures/cms1500FormPdfSynthetic";

const date = ["02", "02", "26"] as [string, string, string];

describe("reading a fillable CMS-1500", () => {
  const pdf = syntheticFormPdf([{
    ...formHeader("TESTPATIENT, ALEX", "A100", { t_charge: "350.00" }),
    ...formRow(1, { date, cpt: "97110", mods: ["GP", "59"], pointer: "AB", charge: "175.00", units: "2" }),
    ...formRow(2, { date, cpt: "G0283", mods: ["GP"], pointer: "B", charge: "175.00", units: "1" }),
  }]);

  it("reads every value from the form fields", async () => {
    const pages = await readCms1500FormPages(pdf);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      pageNumber: 1, patientName: "TESTPATIENT, ALEX", patientAccountNumber: "A100", insuredGroupNumber: "SYNGRP", totalCharge: 350,
    });
    expect(pages[0].diagnoses).toEqual([{ letter: "A", code: "M54.50" }, { letter: "B", code: "M25.561" }]);
    expect(pages[0].lines[0]).toMatchObject({ row: 1, dateFrom: "02 02 26", cpt: "97110", modifiers: ["GP", "59"], diagnosisPointer: "AB", units: 2, charge: 175 });
  });

  it("assembles into lines with each line's own diagnosis codes, and no money field", async () => {
    const { groups, warnings } = assembleCms1500Pages(await readCms1500FormPages(pdf), 1);
    expect(warnings).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].warnings).toEqual([]);
    expect(groups[0].lines.map(l => [l.sourceLineKey.split(":")[1], l.dateOfService, l.cptCodes, l.modifier, l.unitsBilled, l.diagnosisCodes])).toEqual([
      ["p1r1", "2026-02-02", "97110", "GP, 59", 2, "M54.50, M25.561"],
      ["p1r2", "2026-02-02", "G0283", "GP", 1, "M25.561"],
    ]);
    expect(groups[0].lines[0].claimSubmittedDate).toBe("2026-03-01");
    expect(groups[0].lines[0]).not.toHaveProperty("insuranceReimbursement");
  });

  it("carries Box 26 and Box 3 as weak identity evidence", async () => {
    const { groups } = assembleCms1500Pages(await readCms1500FormPages(pdf), 1);
    expect(groups[0].patientIdentity).toEqual({ sourceSystem: "cms1500_box26", externalId: "A100", strength: "account", birthDate: "1950-03-14" });
  });

  it("the text layer alone yields no lines: this is the failure the form reader fixes", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf) }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((i: any) => i.str ?? "").join(" ");
    expect(text.replace(/\s+/g, "").length).toBeGreaterThan(40);
    expect(text).not.toContain("97110");
    expect(parseCMS1500(text)).toEqual([]);
  });

  it("flags a Box 28 mismatch instead of accepting it", async () => {
    const off = syntheticFormPdf([{ ...formHeader("TESTPATIENT, ALEX", "A100", { t_charge: "999.00" }), ...formRow(1, { date, cpt: "97110" }) }]);
    const { groups } = assembleCms1500Pages(await readCms1500FormPages(off), 1);
    expect(groups[0].warnings.join(" ")).toMatch(/Box 28/);
  });
});

describe("multi-page files", () => {
  it("keeps different patients apart, one group per patient, every page read", async () => {
    const pdf = syntheticFormPdf([
      { ...formHeader("TESTPATIENT, ALEX", "A100"), ...formRow(1, { date, cpt: "97110" }) },
      { ...formHeader("OTHERPERSON, SAM", "B200"), ...formRow(1, { date, cpt: "97530" }) },
    ]);
    const { groups } = assembleCms1500Pages(await readCms1500FormPages(pdf), 2);
    expect(groups.map(g => [g.patientName, g.pages, g.lines.map(l => l.cptCodes)])).toEqual([
      ["TESTPATIENT, ALEX", [1], ["97110"]],
      ["OTHERPERSON, SAM", [2], ["97530"]],
    ]);
  });

  it("joins a continued claim by name and a shared identifier", async () => {
    const pdf = syntheticFormPdf([
      { ...formHeader("TESTPATIENT, ALEX", "A100"), ...formRow(1, { date, cpt: "97110" }) },
      { ...formHeader("TESTPATIENT, ALEX", "A100"), ...formRow(1, { date, cpt: "97530" }) },
    ]);
    const { groups } = assembleCms1500Pages(await readCms1500FormPages(pdf), 2);
    expect(groups).toHaveLength(1);
    expect(groups[0].lines.map(l => l.sourceLineKey.split(":")[1])).toEqual(["p1r1", "p2r1"]);
  });

  it("a flat PDF or a scan has no form pages, so it keeps its existing path", async () => {
    expect(await readCms1500FormPages(syntheticFormPdf([{}]))).toEqual([]);
    expect(await readCms1500FormPages(Buffer.from("not a pdf"))).toEqual([]);
  });
});

describe("details", () => {
  it("reads only text fields, and the first filled value of a repeated name", () => {
    const fields = collectTextFields([
      { fieldType: "Btn", fieldName: "sex", fieldValue: "M" },
      { fieldType: "Tx", fieldName: "pt_name", fieldValue: "  " },
      { fieldType: "Tx", fieldName: "pt_name", fieldValue: "A, B" },
      { fieldType: "Tx", fieldName: "pt_name", fieldValue: "C, D" },
    ]);
    expect(Array.from(fields.entries())).toEqual([["pt_name", "A, B"]]);
  });

  it("a page with no name and no service line is not a form page", () => {
    expect(formFieldsToPage(new Map([["tax_id", "123"]]), 1)).toBeNull();
  });

  it("does not read non-numeric units as a number", () => {
    const page = formFieldsToPage(new Map([["cpt1", "97110"], ["day1", "two"]]), 1)!;
    expect(page.lines[0].units).toBeNull();
  });

  it("a two-digit birth year or a future date is not evidence", () => {
    expect(parseFormBirthDate("03 14 1950")).toBe("1950-03-14");
    expect(parseFormBirthDate("03 14 38")).toBeNull();
    expect(parseFormBirthDate("03 14 2999")).toBeNull();
  });

  it("finds pdfjs's font data, so rendered pages keep their printed text", async () => {
    const url = standardFontDataUrl()!;
    expect(url).toMatch(/standard_fonts\/$/);
    const { existsSync, readdirSync } = await import("node:fs");
    expect(existsSync(url)).toBe(true);
    expect(readdirSync(url).length).toBeGreaterThan(5);
  });

  it("really renders a non-embedded font's text into the page image sent to the reader", async () => {
    const withText = await renderPdfPages(syntheticFormPdf([{ pt_name: "TESTPATIENT, ALEX" }]));
    const blank = await renderPdfPages(Buffer.from(syntheticFormPdf([{ pt_name: "TESTPATIENT, ALEX" }]).toString("latin1").replace(/\(HEALTH INSURANCE[^)]*\)/, m => `(${" ".repeat(m.length - 2)})`), "latin1"));
    expect(withText).not.toBeNull();
    // The labels are in the top band: a page image without them compresses far smaller.
    expect(withText![0][0].length).toBeGreaterThan(blank![0][0].length + 2000);
  }, 30000);
});
