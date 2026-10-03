/**
 * server/cms1500DiagnosisPointer.test.ts
 *
 * P4-P10R: CMS1500 line-level diagnosis codes must come from Box 24E's
 * pointer into Box 21's indexed list, not a blanket "every diagnosis in the
 * document" default. Covers the pure resolution functions directly (full
 * control over inputs, deterministic) and a parseCMS1500 integration case
 * using synthetic layout-mode text in the shape its own window-based
 * heuristics expect.
 *
 * NOT validated against a real CMS-1500 PDF's pdftotext output -- only
 * synthetic text matching the parser's documented input shape. Stated
 * honestly per the P4-P10R review: pointer-column extraction from
 * pdftotext -layout is inherently heuristic and unverified against a real
 * form in this environment.
 */
import { describe, expect, it } from "vitest";
import {
  parseIndexedDiagnosisCodes,
  resolveDiagnosisPointer,
  resolveLineDiagnosisCodes,
  parseCMS1500,
} from "./insuranceTemplates";

describe("parseIndexedDiagnosisCodes", () => {
  it("indexes a numbered Box 21 list (1., 2., ...) by printed position", () => {
    const text = `
      DIAGNOSIS OR NATURE OF ILLNESS
      1. M54.5
      2. M25.561
      3. M79.1
      24. A. DATE(S) OF SERVICE
    `;
    const indexed = parseIndexedDiagnosisCodes(text);
    expect(indexed.get(1)).toBe("M54.5");
    expect(indexed.get(2)).toBe("M25.561");
    expect(indexed.get(3)).toBe("M79.1");
    expect(indexed.size).toBe(3);
  });

  it("indexes a lettered Box 21 list (older form revision) A=1, B=2, ...", () => {
    const text = `
      DIAGNOSIS OR NATURE OF ILLNESS
      A M54.5
      B M25.561
      24. A. DATE(S) OF SERVICE
    `;
    const indexed = parseIndexedDiagnosisCodes(text);
    expect(indexed.get(1)).toBe("M54.5"); // A -> position 1
    expect(indexed.get(2)).toBe("M25.561"); // B -> position 2
  });

  it("falls back to positional order when no printed label survives extraction", () => {
    const text = `
      DIAGNOSIS OR NATURE OF ILLNESS
      M54.5 M25.561 M79.1
      24. A. DATE(S) OF SERVICE
    `;
    const indexed = parseIndexedDiagnosisCodes(text);
    expect(indexed.get(1)).toBe("M54.5");
    expect(indexed.get(2)).toBe("M25.561");
    expect(indexed.get(3)).toBe("M79.1");
  });

  it("returns an empty map when Box 21 has no diagnosis codes at all", () => {
    const text = `DIAGNOSIS OR NATURE OF ILLNESS\n\n24. A. DATE(S) OF SERVICE`;
    expect(parseIndexedDiagnosisCodes(text).size).toBe(0);
  });
});

describe("resolveDiagnosisPointer", () => {
  const indexed = new Map([[1, "M54.5"], [2, "M25.561"], [3, "M79.1"], [4, "R52"]]);

  it("resolves a single numeric pointer", () => {
    expect(resolveDiagnosisPointer("1", indexed)).toBe("M54.5");
  });

  it("resolves a multi-digit comma-separated pointer to multiple codes, in pointer order", () => {
    expect(resolveDiagnosisPointer("2,3", indexed)).toBe("M25.561, M79.1");
  });

  it("resolves a concatenated multi-digit pointer (no separators)", () => {
    expect(resolveDiagnosisPointer("13", indexed)).toBe("M54.5, M79.1");
  });

  it("resolves a lettered pointer (older form revision)", () => {
    expect(resolveDiagnosisPointer("AC", indexed)).toBe("M54.5, M79.1"); // A=1, C=3
  });

  it("returns null for a missing pointer", () => {
    expect(resolveDiagnosisPointer(null, indexed)).toBeNull();
    expect(resolveDiagnosisPointer(undefined, indexed)).toBeNull();
    expect(resolveDiagnosisPointer("", indexed)).toBeNull();
  });

  it("returns null for a pointer whose index is out of range for this document", () => {
    expect(resolveDiagnosisPointer("9", indexed)).toBeNull();
  });

  it("drops only the invalid indices from a mixed valid/invalid pointer, not the whole result", () => {
    expect(resolveDiagnosisPointer("1,9", indexed)).toBe("M54.5");
  });

  it("de-duplicates a pointer that repeats the same index", () => {
    expect(resolveDiagnosisPointer("1,1", indexed)).toBe("M54.5");
  });
});

describe("resolveLineDiagnosisCodes", () => {
  it("uses the single document-wide diagnosis for every line when there is no ambiguity", () => {
    const indexed = new Map([[1, "M54.5"]]);
    expect(resolveLineDiagnosisCodes(indexed, null, "M54.5")).toBe("M54.5");
    expect(resolveLineDiagnosisCodes(indexed, "9", "M54.5")).toBe("M54.5"); // pointer irrelevant, unambiguous either way
  });

  it("never falls back to every diagnosis when there are multiple and no pointer resolves", () => {
    const indexed = new Map([[1, "M54.5"], [2, "M25.561"]]);
    expect(resolveLineDiagnosisCodes(indexed, null, "M54.5, M25.561")).toBeNull();
    expect(resolveLineDiagnosisCodes(indexed, "9", "M54.5, M25.561")).toBeNull(); // invalid pointer
  });

  it("uses only the pointer-resolved subset when multiple diagnoses exist and the pointer resolves", () => {
    const indexed = new Map([[1, "M54.5"], [2, "M25.561"], [3, "M79.1"]]);
    expect(resolveLineDiagnosisCodes(indexed, "2", "M54.5, M25.561, M79.1")).toBe("M25.561");
  });
});

describe("parseCMS1500 line-level diagnosis assignment (integration, synthetic layout text)", () => {
  // Shaped to match parseCMS1500's Strategy 2 (layout-mode) window heuristics:
  // a CPT code line, a modifier token within 5 lines forward of it (feeding
  // both the existing modifier extraction and the new pointer search), and a
  // decimal charge within -2/+3 lines of the CPT line.
  function layoutDoc(serviceLines: string) {
    return `
HEALTH INSURANCE CLAIM FORM
DIAGNOSIS OR NATURE OF ILLNESS
1. M54.5
2. M25.561
24. A. DATE(S) OF SERVICE
${serviceLines}
    `;
  }

  it("assigns each line only its own pointer-referenced diagnosis, not every diagnosis in the document", () => {
    const text = layoutDoc(`
06 10 26
97110
GP 1
350.00 1

06 11 26
97140
GP 2
150.00 1
    `);
    const [group] = parseCMS1500(text);
    expect(group).toBeDefined();
    const allLines = group.claims.flatMap(c => c.cptLines ?? []);
    const line1 = allLines.find(l => l.cptCodes === "97110");
    const line2 = allLines.find(l => l.cptCodes === "97140");
    expect(line1?.diagnosisCodes).toBe("M54.5"); // pointer "1" only
    expect(line2?.diagnosisCodes).toBe("M25.561"); // pointer "2" only -- NOT both
  });

  it("leaves diagnosisCodes null for a line with a missing/unresolvable pointer when the document has multiple diagnoses", () => {
    const text = layoutDoc(`
06 10 26
97110
GP
350.00 1
    `);
    const [group] = parseCMS1500(text);
    const line = group.claims.flatMap(c => c.cptLines ?? []).find(l => l.cptCodes === "97110");
    expect(line?.diagnosisCodes).toBeNull(); // no pointer found -- never defaults to "M54.5, M25.561"
  });

  it("still assigns the single diagnosis to every line when the document has only one (no ambiguity, no pointer needed)", () => {
    const text = `
HEALTH INSURANCE CLAIM FORM
DIAGNOSIS OR NATURE OF ILLNESS
1. M54.5
24. A. DATE(S) OF SERVICE

06 10 26
97110
350.00 1
    `;
    const [group] = parseCMS1500(text);
    const line = group.claims.flatMap(c => c.cptLines ?? []).find(l => l.cptCodes === "97110");
    expect(line?.diagnosisCodes).toBe("M54.5");
  });
});
