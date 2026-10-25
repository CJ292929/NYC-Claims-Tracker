/**
 * shared/claimCsvTemplates.ts — P4-P26
 *
 * The ONE definition of the two claims CSV templates offered in Bulk Upload:
 *
 *   cms1500-import-template.csv                  one row per CMS1500 service line
 *   insurance-reimbursement-import-template.csv  one row per adjudicated line
 *
 * Used by the downloaded template (buildClaimCsvTemplate), the in-app field
 * help, the server parser (server/claimCsvImport.ts) and the wrong-template
 * checks on every CSV upload (detectCsvTemplate), so a header, a format rule
 * or a help sentence can never differ between them.
 *
 * Identity: each row carries the file's OWN stable claim id + line id
 * (cms1500_claim_id / cms1500_line_id, reimbursement_id /
 * reimbursement_line_id). The server derives the import document and source
 * line key from those ids only — never from the file bytes, the row order or
 * the other cells — so re-importing an edited or re-sorted file maps every
 * row back to the line it created the first time.
 *
 * Cell rules (parseCsvCell):
 *   - every value is read as text; nothing is coerced through a number, so
 *     identifiers like "000123" and place of service "02" keep leading zeros;
 *   - a blank cell is "unknown" (null) and never overwrites a stored value;
 *     an explicit 0 is a real zero;
 *   - several codes in one cell (modifiers, diagnosis codes) are separated by
 *     commas inside ONE quoted cell: "GP, 59".
 */
import Papa from "papaparse";

export type ClaimCsvKind = "cms1500" | "eob";
export type DetectedCsvTemplate = ClaimCsvKind | "patient" | "unknown";

/** Mirrors the claim_status values the import RPC accepts (shared/claimImport.ts CLAIM_IMPORT_STATUSES). */
export const CLAIM_CSV_STATUS_VALUES = ["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "needs_review"] as const;

export type CsvFieldType =
  | "claim_id" // stable document id: 1-80 chars, case-insensitive
  | "line_id" // stable line id: letters, digits, . _ - (1-40)
  | "patient_name"
  | "uuid"
  | "period"
  | "date"
  | "pos"
  | "cpt"
  | "modifiers"
  | "units"
  | "diagnosis"
  | "visit_number"
  | "money"
  | "status"
  | "text";

export interface CsvField {
  header: string;
  required: boolean;
  type: CsvFieldType;
  /** Max length for free-text fields. */
  maxLength?: number;
  help: string;
}

export const CSV_DATE_FORMATS = "YYYY-MM-DD or MM/DD/YYYY";
export const CSV_MONEY_FORMAT = "Dollars with up to 2 decimals, e.g. 125 or 125.50 (a leading $ is allowed; no negatives). Blank = unknown / leave unchanged. 0 = zero.";

const F = (header: string, required: boolean, type: CsvFieldType, help: string, maxLength?: number): CsvField =>
  ({ header, required, type, help, ...(maxLength ? { maxLength } : {}) });

const PATIENT_FIELDS = [
  F("patient_name", true, "patient_name", "Patient name as it appears on the dashboard, e.g. DOE, JANE."),
  F("patient_id", false, "uuid", "Dashboard patient ID, only if you copied it from the dashboard. Never make one up — leave blank to match by name."),
];

const SERVICE_FIELDS = [
  F("date_of_service", true, "date", `Date of service (${CSV_DATE_FORMATS}).`),
];

export const CMS1500_CSV_FIELDS: CsvField[] = [
  F("cms1500_claim_id", true, "claim_id", "Your stable ID for this CMS1500 claim form (e.g. the patient account no. in Box 26). Same value on every line of the form and on every re-import. One patient per ID."),
  F("cms1500_line_id", true, "line_id", "Stable ID of this service line within the claim, e.g. 1, 2, 3. Keep it the same on re-import. Two identical CPT lines need two different IDs."),
  ...PATIENT_FIELDS,
  F("auth_period", false, "period", "Authorization period number (1, 2, …). Blank = decided from the patient's visit dates; a mismatch asks you to choose."),
  ...SERVICE_FIELDS,
  F("place_of_service", false, "pos", "Box 24B place-of-service code, 2 digits (e.g. 11, 02)."),
  F("cpt_code", true, "cpt", "One CPT/HCPCS code (Box 24D), e.g. 97110."),
  F("modifiers", false, "modifiers", "Up to 4 modifiers in ONE quoted cell, comma-separated, e.g. \"GP, 59\"."),
  F("units", false, "units", "Units (Box 24G), whole number 1–999."),
  F("diagnosis_codes", false, "diagnosis", "ICD-10 codes for this line in pointer order, in ONE quoted cell, comma-separated, e.g. \"M54.50, M25.561\"."),
  F("visit_number", false, "visit_number", "Visit number, only if known from your records. Never calculated."),
  F("claim_submitted_date", false, "date", `Date the claim was submitted / Box 31 date (${CSV_DATE_FORMATS}).`),
  F("insurance_billed", false, "text", "Value for the Insurance Billed column, e.g. the Box 11 insured group number.", 60),
];

export const EOB_CSV_FIELDS: CsvField[] = [
  F("reimbursement_id", true, "claim_id", "Your stable ID for this adjudicated claim on the EOB / remittance (e.g. the payer claim number). Same value on every line of that claim and on every re-import. One patient per ID."),
  F("reimbursement_line_id", true, "line_id", "Stable ID of this payment line within the claim, e.g. 1, 2, 3. Keep it the same on re-import."),
  F("cms1500_claim_id", false, "claim_id", "Recommended: the cms1500_claim_id of the CMS1500 CSV row this payment belongs to. Fill both CMS1500 columns or neither."),
  F("cms1500_line_id", false, "line_id", "Recommended: the cms1500_line_id of that CMS1500 row. With both, the payment is applied to exactly that line."),
  ...PATIENT_FIELDS,
  F("auth_period", false, "period", "Authorization period number. When filled, only CMS1500 lines in that period are considered."),
  ...SERVICE_FIELDS,
  F("cpt_code", true, "cpt", "CPT/HCPCS code of the adjudicated line, e.g. 97110."),
  F("modifiers", false, "modifiers", "Modifiers in ONE quoted cell, comma-separated, e.g. \"GP, 59\"."),
  F("units", false, "units", "Units, whole number 1–999."),
  F("billed_charge", false, "money", "Billed charge for this line."),
  F("insurance_paid", false, "money", "Amount the insurance plan paid for THIS line. Never put a claim total here."),
  F("patient_responsibility", false, "money", "What the EOB says the patient owes for this line (deductible, copay, coinsurance). This is not a payment."),
  F("patient_paid", false, "money", "What the patient has actually paid for this line. Leave blank if unknown — it is never calculated from other amounts."),
  F("claim_status", false, "status", `Adjudication status: ${CLAIM_CSV_STATUS_VALUES.join(", ")}.`),
  F("payment_date", false, "date", `Check / payment date (${CSV_DATE_FORMATS}).`),
  F("payer_claim_number", false, "text", "Payer's claim number (OA claim #).", 80),
  F("check_or_eft_number", false, "text", "Check, EFT or virtual card number. Leading zeros are kept.", 80),
  F("claim_total_paid", false, "money", "Only when the EOB prints one plan payment for the whole claim: that total, same value on every row of the claim. It is NOT saved to any line — it is shown for manual review."),
  F("claim_total_patient_responsibility", false, "money", "Only when the EOB prints one patient-responsibility total for the whole claim. Not saved to any line; shown for review."),
];

export interface ClaimCsvTemplate {
  kind: ClaimCsvKind;
  fileName: string;
  title: string;
  /** Header of the stable claim-id / line-id columns for this template. */
  claimIdHeader: string;
  lineIdHeader: string;
  fields: CsvField[];
  /** Synthetic rows — every claim id starts with EXAMPLE and is refused on import. */
  sampleRows: Array<Record<string, string>>;
  /** Short usage notes (also written as # lines at the top of the file). */
  notes: string[];
}

/** Claim ids starting with this are template examples and are never imported. */
export const EXAMPLE_ID_PREFIX = "EXAMPLE";

const SAMPLE_PATIENT = "SAMPLE, PATIENT";

export const CLAIM_CSV_TEMPLATES: Record<ClaimCsvKind, ClaimCsvTemplate> = {
  cms1500: {
    kind: "cms1500",
    fileName: "cms1500-import-template.csv",
    title: "CMS1500",
    claimIdHeader: "cms1500_claim_id",
    lineIdHeader: "cms1500_line_id",
    fields: CMS1500_CSV_FIELDS,
    sampleRows: [
      { cms1500_claim_id: "EXAMPLE-CMS-1001", cms1500_line_id: "1", patient_name: SAMPLE_PATIENT, auth_period: "1", date_of_service: "2026-01-05", place_of_service: "11", cpt_code: "97110", modifiers: "GP", units: "2", diagnosis_codes: "M54.50, M25.561", claim_submitted_date: "2026-01-10", insurance_billed: "SYN-GRP-0042" },
      { cms1500_claim_id: "EXAMPLE-CMS-1001", cms1500_line_id: "2", patient_name: SAMPLE_PATIENT, auth_period: "1", date_of_service: "2026-01-05", place_of_service: "11", cpt_code: "97110", modifiers: "GP", units: "2", diagnosis_codes: "M54.50, M25.561", claim_submitted_date: "2026-01-10", insurance_billed: "SYN-GRP-0042" },
      { cms1500_claim_id: "EXAMPLE-CMS-1001", cms1500_line_id: "3", patient_name: SAMPLE_PATIENT, date_of_service: "01/05/2026", place_of_service: "02", cpt_code: "97140", modifiers: "GP, 59", units: "1", diagnosis_codes: "M54.50", visit_number: "4", claim_submitted_date: "01/10/2026" },
    ],
    notes: [
      "CMS1500 import template. One row per CMS1500 service line (Box 24). Import this BEFORE the Insurance Reimbursement CSV.",
      "Amounts are not part of this template: billed and paid amounts come from the Insurance Reimbursement CSV.",
      "Repeated identical CPT lines are kept as separate lines - give each its own cms1500_line_id.",
      `Dates: ${CSV_DATE_FORMATS}. Put several modifiers or diagnosis codes in ONE quoted cell separated by commas.`,
      "Delete the EXAMPLE rows before importing - they are refused. Lines starting with # above the header are ignored.",
    ],
  },
  eob: {
    kind: "eob",
    fileName: "insurance-reimbursement-import-template.csv",
    title: "Insurance Reimbursement",
    claimIdHeader: "reimbursement_id",
    lineIdHeader: "reimbursement_line_id",
    fields: EOB_CSV_FIELDS,
    sampleRows: [
      { reimbursement_id: "EXAMPLE-ERA-5001", reimbursement_line_id: "1", cms1500_claim_id: "EXAMPLE-CMS-1001", cms1500_line_id: "1", patient_name: SAMPLE_PATIENT, date_of_service: "2026-01-05", cpt_code: "97110", modifiers: "GP", units: "2", billed_charge: "150.00", insurance_paid: "80.00", patient_responsibility: "20.00", claim_status: "approved", payment_date: "2026-02-01", payer_claim_number: "SYN-PAYER-0001", check_or_eft_number: "000123" },
      { reimbursement_id: "EXAMPLE-ERA-5001", reimbursement_line_id: "2", cms1500_claim_id: "EXAMPLE-CMS-1001", cms1500_line_id: "2", patient_name: SAMPLE_PATIENT, date_of_service: "2026-01-05", cpt_code: "97110", modifiers: "GP", units: "2", billed_charge: "150.00", insurance_paid: "80.00", patient_responsibility: "20.00", patient_paid: "0", claim_status: "approved", payment_date: "2026-02-01", payer_claim_number: "SYN-PAYER-0001", check_or_eft_number: "000123" },
      { reimbursement_id: "EXAMPLE-ERA-5001", reimbursement_line_id: "3", cms1500_claim_id: "EXAMPLE-CMS-1001", cms1500_line_id: "3", patient_name: SAMPLE_PATIENT, date_of_service: "01/05/2026", cpt_code: "97140", modifiers: "GP, 59", units: "1", billed_charge: "95.00", insurance_paid: "0", claim_status: "denied", payment_date: "02/01/2026", payer_claim_number: "SYN-PAYER-0001", check_or_eft_number: "000123" },
    ],
    notes: [
      "Insurance Reimbursement import template. One row per adjudicated service line. Import the matching CMS1500 CSV FIRST.",
      "Each row is applied only to an existing CMS1500 line. Fill cms1500_claim_id + cms1500_line_id to point at the exact line.",
      "patient_responsibility (what the patient owes) and patient_paid (what the patient actually paid) are different - neither is calculated.",
      "Blank amount = unknown / leave unchanged. 0 = zero. Claim totals go only in claim_total_* columns and are never saved to a line.",
      `Dates: ${CSV_DATE_FORMATS}. claim_status: ${CLAIM_CSV_STATUS_VALUES.join(" / ")}.`,
      "Delete the EXAMPLE rows before importing - they are refused. Lines starting with # above the header are ignored.",
    ],
  },
};

export const CLAIM_CSV_MAX_ROWS = 1000;
export const CLAIM_CSV_MAX_BYTES = 2_000_000;

// ─── Writing ────────────────────────────────────────────────────────────────

/** One CSV cell, always quoted so multi-code cells, commas and leading zeros survive. */
export function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function requiredSummary(fields: CsvField[]): string[] {
  return [
    `Required columns: ${fields.filter(f => f.required).map(f => f.header).join(" ")}`,
    `Optional columns: ${fields.filter(f => !f.required).map(f => f.header).join(" ")}`,
  ];
}

/** The downloadable template: # instruction lines, the header row, the synthetic sample rows. CRLF line endings. */
export function buildClaimCsvTemplate(kind: ClaimCsvKind): string {
  const t = CLAIM_CSV_TEMPLATES[kind];
  // Instruction lines contain no commas, so a spreadsheet shows each one in a single cell.
  const comments = [...t.notes, ...requiredSummary(t.fields)].map(n => `# ${n.replace(/,/g, ";")}`);
  const header = t.fields.map(f => f.header).join(",");
  const rows = t.sampleRows.map(r => t.fields.map(f => csvCell(r[f.header] ?? "")).join(","));
  return [...comments, header, ...rows].join("\r\n") + "\r\n";
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** Removes the # instruction lines that precede the header (only there — a data row is never skipped). */
export function stripLeadingCommentLines(text: string): { body: string; skippedLines: number } {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  let i = 0;
  while (i < lines.length && (/^\s*"?#/.test(lines[i]) || lines[i].trim() === "" || /^[,\s]*$/.test(lines[i]))) i++;
  return { body: lines.slice(i).join("\n"), skippedLines: i };
}

export function normalizeHeader(h: string): string {
  return h.replace(/^﻿/, "").trim().toLowerCase();
}

/** The header row of a CSV (after leading # lines), normalized. */
export function readCsvHeaders(text: string): string[] {
  const { body } = stripLeadingCommentLines(text);
  const firstLine = Papa.parse<string[]>(body, { preview: 1, skipEmptyLines: true });
  return (firstLine.data[0] ?? []).map(normalizeHeader).filter(Boolean);
}

/** Which template a header row belongs to. The two claims templates are told apart by their id columns. */
export function detectCsvTemplate(headers: string[]): DetectedCsvTemplate {
  const h = new Set(headers.map(normalizeHeader));
  if (h.has("reimbursement_id") || h.has("reimbursement_line_id")) return "eob";
  if (h.has("cms1500_claim_id") || h.has("cms1500_line_id")) return "cms1500";
  if (h.has("patient name") || h.has("authorized sessions")) return "patient";
  return "unknown";
}

export function detectCsvTemplateFromText(text: string): DetectedCsvTemplate {
  return detectCsvTemplate(readCsvHeaders(text));
}

const UPLOAD_LOCATION: Record<DetectedCsvTemplate, string> = {
  cms1500: "Bulk Upload → CMS1500",
  eob: "Bulk Upload → Insurance Reimbursement",
  patient: "Bulk Upload → Patient Data",
  unknown: "",
};

/** The message for a file uploaded under the wrong option, or null when it is the expected template. */
export function wrongTemplateMessage(expected: DetectedCsvTemplate, detected: DetectedCsvTemplate): string | null {
  if (detected === expected) return null;
  const expectedName = expected === "patient" ? "Patient Data" : CLAIM_CSV_TEMPLATES[expected as ClaimCsvKind]?.title ?? expected;
  if (detected === "unknown") {
    return expected === "patient"
      ? null
      : `This file is not the ${expectedName} CSV template. Download ${CLAIM_CSV_TEMPLATES[expected as ClaimCsvKind].fileName} and use its header row.`;
  }
  const detectedName = detected === "patient" ? "Patient Data" : CLAIM_CSV_TEMPLATES[detected].title;
  return `This is the ${detectedName} CSV template, not ${expectedName}. Nothing was imported. Upload it under ${UPLOAD_LOCATION[detected]}.`;
}

// ─── Cells ──────────────────────────────────────────────────────────────────

export type CellResult<T> = { ok: true; value: T | null } | { ok: false; error: string };

const ok = <T>(value: T | null): CellResult<T> => ({ ok: true, value });
const bad = (error: string): CellResult<never> => ({ ok: false, error });

/** Trims, and unwraps a spreadsheet text literal (="000123") so leading zeros survive Excel. */
export function cleanCell(raw: string | undefined | null): string {
  if (raw == null) return "";
  let v = String(raw).trim();
  const literal = v.match(/^="(.*)"$/);
  if (literal) v = literal[1].trim();
  return v;
}

/** Strict calendar date: YYYY-MM-DD or MM/DD/YYYY (4-digit year). Never guessed. */
export function parseCsvDate(v: string): CellResult<string> {
  if (!v) return ok(null);
  let y: number, m: number, d: number;
  let match = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) { y = +match[1]; m = +match[2]; d = +match[3]; }
  else if ((match = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { m = +match[1]; d = +match[2]; y = +match[3]; }
  else return bad(`"${v}" is not a date in ${CSV_DATE_FORMATS} format.`);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1900 || y > 2100) {
    return bad(`"${v}" is not a real calendar date.`);
  }
  return ok(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}

export function parseCsvMoney(v: string): CellResult<number> {
  if (!v) return ok(null);
  const s = v.replace(/^\$/, "").trim();
  if (/^-/.test(s) || /^\(.*\)$/.test(s)) return bad(`"${v}": negative amounts are not accepted. Leave blank if unknown.`);
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) return bad(`"${v}" is not an amount (use e.g. 125.50).`);
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n) || n > 10_000_000) return bad(`"${v}" is out of range.`);
  return ok(Math.round(n * 100) / 100);
}

function parseInteger(v: string, min: number, max: number, label: string): CellResult<number> {
  if (!v) return ok(null);
  if (!/^\d+$/.test(v)) return bad(`${label} "${v}" must be a whole number.`);
  const n = Number(v);
  if (n < min || n > max) return bad(`${label} "${v}" must be between ${min} and ${max}.`);
  return ok(n);
}

function splitCodes(v: string): string[] {
  return v.toUpperCase().split(/[\s,;]+/).filter(Boolean);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ICD10_RE = /^[A-Z][0-9][0-9A-Z](\.?[0-9A-Z]{1,4})?$/;

/** Validates and normalizes one cell for its field. Blank → null (unknown), never an error for an optional field. */
export function parseCsvCell(field: CsvField, raw: string | undefined | null): CellResult<string | number> {
  const v = cleanCell(raw);
  if (!v) return field.required ? bad(`${field.header} is required.`) : ok(null);
  switch (field.type) {
    case "claim_id": {
      const id = v.replace(/\s+/g, " ").toUpperCase();
      if (id.length > 80) return bad(`${field.header} is longer than 80 characters.`);
      if (/^[#=+@]/.test(id)) return bad(`${field.header} "${v}" cannot start with #, =, + or @.`);
      return ok(id);
    }
    case "line_id": {
      const id = v.toUpperCase();
      if (!/^[A-Z0-9._-]{1,40}$/.test(id)) return bad(`${field.header} "${v}" may only contain letters, digits, ".", "_" and "-" (max 40).`);
      return ok(id);
    }
    case "patient_name":
      return v.length > 200 ? bad("patient_name is longer than 200 characters.") : ok(v.replace(/\s+/g, " "));
    case "uuid":
      return UUID_RE.test(v) ? ok(v.toLowerCase()) : bad(`${field.header} "${v}" is not a dashboard patient ID. Leave it blank to match by name.`);
    case "period":
      return parseInteger(v, 1, 1000, field.header);
    case "date":
      return parseCsvDate(v);
    case "pos":
      if (/^\d$/.test(v)) return bad(`place_of_service "${v}" must be 2 digits (e.g. 0${v}) — the spreadsheet may have dropped a leading zero.`);
      return /^\d{2}$/.test(v) ? ok(v) : bad(`place_of_service "${v}" must be a 2-digit code.`);
    case "cpt": {
      const c = v.toUpperCase();
      return /^[A-Z0-9]{5}$/.test(c) ? ok(c) : bad(`cpt_code "${v}" must be one 5-character CPT/HCPCS code (one code per row).`);
    }
    case "modifiers": {
      const mods = splitCodes(v);
      if (mods.length > 4) return bad(`modifiers "${v}": at most 4 modifiers.`);
      const badMod = mods.find(m => !/^[A-Z0-9]{2}$/.test(m));
      if (badMod) return bad(`modifiers "${v}": "${badMod}" is not a 2-character modifier.`);
      return ok(Array.from(new Set(mods)).join(", "));
    }
    case "units":
      return parseInteger(v, 1, 999, field.header);
    case "visit_number":
      return parseInteger(v, 1, 10000, field.header);
    case "diagnosis": {
      const codes = splitCodes(v);
      if (codes.length > 12) return bad("diagnosis_codes: at most 12 codes.");
      const badCode = codes.find(c => !ICD10_RE.test(c));
      if (badCode) return bad(`diagnosis_codes "${v}": "${badCode}" is not an ICD-10 code.`);
      return ok(codes.join(", "));
    }
    case "money":
      return parseCsvMoney(v);
    case "status": {
      const s = v.toLowerCase().replace(/\s+/g, "_");
      return (CLAIM_CSV_STATUS_VALUES as readonly string[]).includes(s)
        ? ok(s)
        : bad(`claim_status "${v}" must be one of: ${CLAIM_CSV_STATUS_VALUES.join(", ")}.`);
    }
    case "text":
      return v.length > (field.maxLength ?? 200) ? bad(`${field.header} is longer than ${field.maxLength ?? 200} characters.`) : ok(v);
  }
}
