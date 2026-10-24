/**
 * server/cms1500Vision.assemble.test.ts — P4-P24
 *
 * Deterministic assembly of page-by-page CMS-1500 transcriptions
 * (assembleCms1500Pages) against the synthetic scanned-layout fixture:
 * page continuation, per-line pointer → diagnosis resolution, modifiers,
 * units, the last-page-only Box 28 check, repeated CPT lines, unreadable
 * values, and patient/page boundaries that must never be guessed.
 */
import { describe, expect, it } from "vitest";
import { assembleCms1500Pages, parseFormDate, pointerLetters, reconcilePageReads, type VisionPage } from "./cms1500Vision";
import { LINES_PER_DATE, SYNTHETIC_DATES_ISO, expectedCodes, syntheticScannedPages } from "./fixtures/cms1500ScannedSynthetic";

describe("assembleCms1500Pages — three-page scanned layout", () => {
  const { groups, warnings } = assembleCms1500Pages(syntheticScannedPages(), 3);

  it("merges the three continuation pages into one claim with all 16 lines", () => {
    expect(warnings).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].pages).toEqual([1, 2, 3]);
    expect(groups[0].patientName).toBe("TESTPATIENT, ALEX");
    expect(groups[0].lines).toHaveLength(16);
    expect(groups[0].lines.map(l => l.page)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3]);
  });

  it("keeps 4 dates x 4 CPTs, including the CPTs that repeat on every date and across pages", () => {
    const lines = groups[0].lines;
    for (let d = 0; d < 4; d++) {
      const onDate = lines.filter(l => l.dateOfService === SYNTHETIC_DATES_ISO[d]);
      expect(onDate.map(l => l.cptCodes)).toEqual(LINES_PER_DATE.map(s => s.cpt));
    }
  });

  it("resolves each line's own 24E pointer, in pointer order — never the whole Box 21 list", () => {
    for (const l of groups[0].lines) {
      const spec = LINES_PER_DATE.find(s => s.cpt === l.cptCodes)!;
      expect(l.diagnosisPointer).toBe(spec.pointer);
      expect(l.diagnosisCodes).toBe(expectedCodes(spec.pointer));
      expect(l.diagnosisCodes!.split(", ")).toHaveLength(4);
    }
    // CEDF resolves in pointer order, not Box 21 order.
    expect(groups[0].lines.find(l => l.cptCodes === "97530")!.diagnosisCodes).toBe("M62.81, M54.16, R26.89, Z74.09");
  });

  it("preserves both modifiers on 97140 and GP on every line; 1 unit each; no line flagged", () => {
    for (const l of groups[0].lines) {
      expect(l.modifier).toBe(l.cptCodes === "97140" ? "59, GP" : "GP");
      expect(l.unitsBilled).toBe(1);
      expect(l.unreadable).toEqual([]);
      expect(l.placeOfService).toBe("12");
      expect(l.claimSubmittedDate).toBe("2026-03-16");
    }
  });

  it("checks lines against the last-page-only Box 28 total ($2,800.00) without warning", () => {
    expect(groups[0].warnings).toEqual([]);
    expect(groups[0].lines.reduce((s, l) => s + (l.lineChargeForValidation ?? 0), 0)).toBe(2800);
  });

  it("assigns distinct page/row source keys, stable across runs", () => {
    const keys = groups[0].lines.map(l => l.sourceLineKey);
    expect(new Set(keys).size).toBe(16);
    expect(keys[0]).toMatch(/^g[0-9a-f]{12}:p1r1$/);
    expect(keys[15]).toMatch(/:p3r4$/);
    const again = assembleCms1500Pages(syntheticScannedPages(), 3).groups[0].lines.map(l => l.sourceLineKey);
    expect(again).toEqual(keys);
  });

  it("never carries a visit number", () => {
    for (const l of groups[0].lines) expect(l).not.toHaveProperty("visitNumber");
  });
});

describe("assembleCms1500Pages — review flags instead of guesses", () => {
  it("warns when a line is missing against Box 28", () => {
    const pages = syntheticScannedPages();
    pages[1].lines.pop();
    const { groups } = assembleCms1500Pages(pages, 3);
    expect(groups[0].lines).toHaveLength(15);
    expect(groups[0].warnings.join(" ")).toMatch(/add up to \$2625\.00 but Box 28 shows \$2800\.00/);
  });

  it("flags an unreadable pointer and leaves that line's diagnosis codes null", () => {
    const pages = syntheticScannedPages();
    pages[0].lines[2].diagnosisPointer = null;
    pages[0].lines[2].unreadableFields = ["diagnosisPointer"];
    const { groups } = assembleCms1500Pages(pages, 3);
    const l = groups[0].lines[2];
    expect(l.diagnosisCodes).toBeNull();
    expect(l.unreadable).toContain("diagnosisCodes");
    expect(groups[0].lines[3].diagnosisCodes).toBe(expectedCodes("ABCD"));
  });

  it("flags a pointer letter that Box 21 does not print instead of dropping it", () => {
    const pages = syntheticScannedPages();
    pages[0].lines[0].diagnosisPointer = "ABG";
    const { groups } = assembleCms1500Pages(pages, 3);
    expect(groups[0].lines[0].diagnosisCodes).toBeNull();
    expect(groups[0].lines[0].notes).toMatch(/Box 21 G is missing/);
  });

  it("treats a Box 21 letter that reads differently on two pages as unreadable", () => {
    const pages = syntheticScannedPages();
    pages[2].diagnoses[4] = { letter: "E", code: "M54.17" };
    const { groups } = assembleCms1500Pages(pages, 3);
    expect(groups[0].warnings.join(" ")).toMatch(/Box 21 E reads differently/);
    expect(groups[0].lines.find(l => l.diagnosisPointer === "ABED")!.diagnosisCodes).toBeNull();
    expect(groups[0].lines.find(l => l.diagnosisPointer === "ABCD")!.diagnosisCodes).toBe(expectedCodes("ABCD"));
  });

  it("leaves unreadable units/modifiers null and flagged, and the Box 28 check unverifiable when a charge is unreadable", () => {
    const pages = syntheticScannedPages();
    pages[0].lines[3].unreadableFields = ["modifiers", "units", "charge"];
    const { groups } = assembleCms1500Pages(pages, 3);
    const l = groups[0].lines[3];
    expect(l.modifier).toBeNull();
    expect(l.unitsBilled).toBeNull();
    expect(l.unreadable).toEqual(expect.arrayContaining(["modifier", "unitsBilled"]));
    expect(groups[0].warnings.join(" ")).toMatch(/could not be verified/);
  });

  it("reports pages the reader could not return", () => {
    const pages = syntheticScannedPages().slice(0, 2);
    const { warnings } = assembleCms1500Pages(pages, 3, [3]);
    expect(warnings[0]).toMatch(/Page\(s\) 3 of 3 could not be read/);
  });

  it("keeps identical repeated lines on one date as distinct source lines", () => {
    const pages = syntheticScannedPages();
    pages[2].lines[1] = { ...pages[2].lines[0], row: 2 };
    const { groups } = assembleCms1500Pages(pages, 3);
    const dup = groups[0].lines.filter(l => l.page === 3 && l.cptCodes === "97110");
    expect(dup).toHaveLength(2);
    expect(dup[0].sourceLineKey).not.toBe(dup[1].sourceLineKey);
  });
});

describe("assembleCms1500Pages — patient and page boundaries are never guessed", () => {
  function otherPatient(page: VisionPage, n: number): VisionPage {
    return { ...page, pageNumber: n, patientName: "OTHERPERSON, SAM", insuredId: "SYN000222", patientAccountNumber: "SYN-ACCT-0002", claimNumber: "SYNCIC0002", patientDob: "02 02 1980" };
  }

  it("splits a multi-patient file at the page where the patient changes", () => {
    const pages = syntheticScannedPages();
    pages[2] = otherPatient(pages[2], 3);
    const { groups } = assembleCms1500Pages(pages, 3);
    expect(groups.map(g => [g.patientName, g.pages])).toEqual([
      ["TESTPATIENT, ALEX", [1, 2]],
      ["OTHERPERSON, SAM", [3]],
    ]);
    expect(new Set(groups.map(g => g.groupKey)).size).toBe(2);
  });

  it("does not merge a same-named page whose identifiers differ", () => {
    const pages = syntheticScannedPages();
    pages[1] = { ...pages[1], insuredId: "SYN999999" };
    const { groups } = assembleCms1500Pages(pages, 3);
    expect(groups.map(g => g.pages)).toEqual([[1], [2], [3]]);
  });

  it("keeps a page with an unreadable patient as its own unassigned group", () => {
    const pages = syntheticScannedPages();
    pages[1] = { ...pages[1], patientName: null, insuredId: null, patientAccountNumber: null, claimNumber: null, patientDob: null };
    const { groups } = assembleCms1500Pages(pages, 3);
    expect(groups.map(g => [g.patientName, g.pages])).toEqual([
      ["TESTPATIENT, ALEX", [1]],
      [null, [2]],
      ["TESTPATIENT, ALEX", [3]],
    ]);
    expect(groups[1].warnings.join(" ")).toMatch(/patient could not be identified/);
  });

  it("does not merge pages on name alone when no identifier is readable", () => {
    const pages = syntheticScannedPages().map(p => ({ ...p, insuredId: null, patientAccountNumber: null, claimNumber: null, patientDob: null }));
    const { groups } = assembleCms1500Pages(pages, 3);
    expect(groups).toHaveLength(3);
    expect(groups[0].warnings.join(" ")).toMatch(/kept separate/);
  });
});

describe("form value parsing", () => {
  it("parses printed CMS-1500 dates and rejects impossible ones", () => {
    expect(parseFormDate("03 02 26")).toBe("2026-03-02");
    expect(parseFormDate("03/02/2026")).toBe("2026-03-02");
    expect(parseFormDate("030226")).toBe("2026-03-02");
    expect(parseFormDate("13 02 26")).toBeNull();
    expect(parseFormDate("03 02")).toBeNull();
    expect(parseFormDate(null)).toBeNull();
  });

  it("reads letter and older digit pointers, rejecting anything else", () => {
    expect(pointerLetters("ABCD")).toEqual(["A", "B", "C", "D"]);
    expect(pointerLetters("cedf")).toEqual(["C", "E", "D", "F"]);
    expect(pointerLetters("1234")).toEqual(["A", "B", "C", "D"]);
    expect(pointerLetters("A,C")).toEqual(["A", "C"]);
    expect(pointerLetters("AXZ")).toBeNull();
    expect(pointerLetters("ABCDE")).toBeNull();
    expect(pointerLetters("")).toBeNull();
  });
});

describe("reconcilePageReads — two independent reads, disagreements flagged", () => {
  const page = () => syntheticScannedPages()[0];

  it("keeps everything when both reads agree", () => {
    const r = reconcilePageReads(page(), page());
    expect(r).toEqual(page());
  });

  it("blanks and flags each line field the reads disagree on, never picking one", () => {
    const b = page();
    b.lines[0].cpt = "97112";
    b.lines[1].units = 2;
    b.lines[2].diagnosisPointer = "CEFD";
    b.lines[3].modifiers = ["GP"];
    const r = reconcilePageReads(page(), b);
    expect(r.lines[0].unreadableFields).toEqual(["cpt"]);
    expect(r.lines[1].unreadableFields).toEqual(["units"]);
    expect(r.lines[2].unreadableFields).toEqual(["diagnosisPointer"]);
    expect(r.lines[3].unreadableFields).toEqual(["modifiers"]);
    const { groups } = assembleCms1500Pages([r, ...syntheticScannedPages().slice(1)], 3);
    expect(groups[0].lines[0].cptCodes).toBeNull();
    expect(groups[0].lines[1].unitsBilled).toBeNull();
    expect(groups[0].lines[2].diagnosisCodes).toBeNull();
    expect(groups[0].lines[3].modifier).toBeNull();
  });

  it("flags a row only one read found so it cannot be saved without review", () => {
    const b = page();
    b.lines.push({ ...b.lines[5], row: 7 });
    const r = reconcilePageReads(page(), b);
    expect(r.lines).toHaveLength(7);
    expect(r.lines[6].unreadableFields).toEqual(expect.arrayContaining(["date", "cpt"]));
  });

  it("drops header values and Box 21 codes the reads disagree on; tolerates a name variant the safe matcher accepts", () => {
    const b = { ...page(), insuredId: "SYN000112", patientName: "TESTPATIENT, ALEX J", totalCharge: 175 };
    b.diagnoses = b.diagnoses.map(d => (d.letter === "C" ? { ...d, code: "M62.82" } : d));
    const r = reconcilePageReads({ ...page(), totalCharge: null }, b);
    expect(r.insuredId).toBeNull();
    expect(r.patientName).toBe("TESTPATIENT, ALEX");
    expect(r.totalCharge).toBeNull();
    expect(r.diagnoses.find(d => d.letter === "C")!.code).toBeNull();
    expect(reconcilePageReads(page(), { ...page(), patientName: "OTHERPERSON, SAM" }).patientName).toBeNull();
  });
});
