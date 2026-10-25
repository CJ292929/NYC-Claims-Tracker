/**
 * server/fixtures/cms1500ScannedSynthetic.ts — P4-P24
 *
 * Anonymized, fully SYNTHETIC page transcriptions shaped like the supplied
 * three-page black-and-white CMS-1500 scan: one claim continued across 3
 * pages ("continued - page N of 3"), 6 + 6 + 4 = 16 service lines over 4
 * dates of service, the same four CPTs on every date (97140 with modifiers
 * 59 + GP, every other line GP only), 1 unit at $175.00 each, six Box 21
 * codes (A-F) with a different 24E pointer string per line, and Box 28
 * ($2,800.00) printed only on the last page.
 *
 * No value here comes from a real patient or claim: the name, IDs, NPIs,
 * dates and diagnosis codes are invented placeholders.
 */
import type { VisionPage, VisionServiceLine } from "../cms1500Vision";

export const SYNTHETIC_DIAGNOSES = [
  { letter: "A", code: "M54.50" },
  { letter: "B", code: "M25.551" },
  { letter: "C", code: "M62.81" },
  { letter: "D", code: "R26.89" },
  { letter: "E", code: "M54.16" },
  { letter: "F", code: "Z74.09" },
];

/** CPT, modifiers and pointer for each of the four lines billed per date. */
export const LINES_PER_DATE: Array<{ cpt: string; modifiers: string[]; pointer: string }> = [
  { cpt: "97110", modifiers: ["GP"], pointer: "ABCD" },
  { cpt: "97112", modifiers: ["GP"], pointer: "ABED" },
  { cpt: "97530", modifiers: ["GP"], pointer: "CEDF" },
  { cpt: "97140", modifiers: ["59", "GP"], pointer: "ABCD" },
];

export const SYNTHETIC_DATES = ["03 02 26", "03 04 26", "03 09 26", "03 11 26"];
export const SYNTHETIC_DATES_ISO = ["2026-03-02", "2026-03-04", "2026-03-09", "2026-03-11"];

function line(row: number, dateIdx: number, lineIdx: number): VisionServiceLine {
  const spec = LINES_PER_DATE[lineIdx];
  return {
    row,
    dateFrom: SYNTHETIC_DATES[dateIdx],
    dateTo: SYNTHETIC_DATES[dateIdx],
    placeOfService: "12",
    cpt: spec.cpt,
    modifiers: [...spec.modifiers],
    diagnosisPointer: spec.pointer,
    charge: 175,
    units: 1,
    unreadableFields: [],
  };
}

function header(pageNumber: number, totalCharge: number | null): Omit<VisionPage, "lines"> {
  return {
    pageNumber,
    continuationLabel: `continued - page ${pageNumber} of 3`,
    patientName: "TESTPATIENT, ALEX",
    patientDob: "01 15 1970",
    insuredId: "SYN000111",
    patientAccountNumber: "SYN-ACCT-0001",
    claimNumber: "SYNCIC0001",
    billingNpi: "0000000000",
    insuredGroupNumber: "SYN-GRP-1",
    signatureDate: "03 16 26",
    totalCharge,
    diagnoses: SYNTHETIC_DIAGNOSES.map(d => ({ ...d })),
  };
}

/** Flat order of the 16 (dateIdx, lineIdx) pairs as they print top to bottom. */
const ORDER: Array<[number, number]> = SYNTHETIC_DATES.flatMap((_, d) => LINES_PER_DATE.map((__, l) => [d, l] as [number, number]));

export function syntheticScannedPages(): VisionPage[] {
  const p1 = ORDER.slice(0, 6), p2 = ORDER.slice(6, 12), p3 = ORDER.slice(12, 16);
  return [
    { ...header(1, null), lines: p1.map(([d, l], i) => line(i + 1, d, l)) },
    { ...header(2, null), lines: p2.map(([d, l], i) => line(i + 1, d, l)) },
    { ...header(3, 2800), lines: p3.map(([d, l], i) => line(i + 1, d, l)) },
  ];
}

/** Expected diagnosis codes for a pointer string, in pointer order. */
export function expectedCodes(pointer: string): string {
  return pointer.split("").map(letter => SYNTHETIC_DIAGNOSES.find(d => d.letter === letter)!.code).join(", ");
}
