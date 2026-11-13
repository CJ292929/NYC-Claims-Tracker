/**
 * shared/patientCsvImport.ts — P4-P29
 *
 * The ONE definition of the Patient Data CSV ("Bulk Upload Patients" on
 * Patient Records): the downloadable template, the header aliases the P4-P26
 * importer accepted, and the row parser/validator. Used by the client (template
 * download, field help) and by the server (server/patientCsvImport.ts), which
 * re-parses the file on every preview AND every save, so what is saved can
 * never differ from what was reviewed.
 *
 * Restored after P4-P28 removed it. What is different from the P4-P26 client
 * loop it replaces:
 *   - parsing and validation run on the server, and each new patient is saved
 *     with its sessions and audit rows in ONE transaction
 *     (import_patient_csv_group_with_audit);
 *   - a bad number or date is an error, never silently read as 0 or 1;
 *   - an existing patient is never modified, and repeated names in one file
 *     become ONE patient with several sessions;
 *   - claims templates and any financial/claims column are refused outright.
 *
 * This file never reads or writes money, claim status, CPT codes or any other
 * claims field. Claims data stays behind Claims access (shared/claimsAccess.ts).
 */
import Papa from "papaparse";
import {
  cleanCell,
  csvCell,
  detectCsvTemplate,
  normalizeHeader,
  parseCsvDate,
  stripLeadingCommentLines,
} from "./claimCsvTemplates";

export const PATIENT_CSV_FILE_NAME = "clinic_patient_template.csv";
export const PATIENT_CSV_MAX_BYTES = 2_000_000;
export const PATIENT_CSV_MAX_ROWS = 1000;
export const PATIENT_NAME_MAX = 200;

export type PatientCsvField =
  | "name"
  | "insurance"
  | "authorized"
  | "authDate"
  | "dateOfService"
  | "sessionNumber"
  | "remaining"
  | "newAuth"
  | "authSubmitted";

/** Template header, accepted aliases (normalized), and help text. The first entry is the template header. */
export const PATIENT_CSV_COLUMNS: Array<{ field: PatientCsvField; headers: string[]; required: boolean; help: string }> = [
  { field: "name", headers: ["Patient Name", "Name", "Patient"], required: true, help: "Patient name, e.g. DOE, JANE. Rows with the same name become one patient." },
  { field: "insurance", headers: ["Insurance", "Insurance Company"], required: false, help: "Must match a company in the insurance list. Leave blank if unknown." },
  { field: "authorized", headers: ["Authorized Sessions", "Total Authorized"], required: false, help: "Whole number, 0–999." },
  { field: "authDate", headers: ["Authorization Date"], required: false, help: "YYYY-MM-DD or MM/DD/YYYY." },
  { field: "dateOfService", headers: ["Date of Service"], required: false, help: "YYYY-MM-DD or MM/DD/YYYY." },
  { field: "sessionNumber", headers: ["Session Number"], required: false, help: "Whole number, 1–999." },
  { field: "remaining", headers: ["Sessions Remaining"], required: false, help: "Whole number, 0–999. Blank = same as Authorized Sessions." },
  { field: "newAuth", headers: ["New Authorization?"], required: false, help: "YES or NO. Blank = NO." },
  { field: "authSubmitted", headers: ["Date Authorization Submitted", "Date ASH Submitted"], required: false, help: "YYYY-MM-DD or MM/DD/YYYY." },
];

/** Synthetic sample rows only (no real person). */
const SAMPLE_ROWS: string[][] = [
  ["SAMPLE, PATIENT ONE", "", "12", "2026-04-21", "2026-04-22", "1", "11", "NO", ""],
  ["SAMPLE, PATIENT ONE", "", "12", "2026-04-21", "2026-04-24", "2", "10", "NO", ""],
  ["SAMPLE, PATIENT TWO", "", "15", "03/10/2026", "", "", "", "", ""],
];

export function buildPatientCsvTemplate(): string {
  const header = PATIENT_CSV_COLUMNS.map(c => c.headers[0]);
  const rows = SAMPLE_ROWS.map(r => r.map(csvCell).join(","));
  return [header.join(","), ...rows].join("\r\n") + "\r\n";
}

/**
 * Order-insensitive patient name key — the same rule as the database's
 * import_patient_name_key (P4-P28 migration), which is what the save path
 * actually enforces: upper-case, apostrophes removed, commas/periods/hyphens/
 * whitespace as separators, tokens sorted.
 */
export function patientNameKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/['’]/g, "")
    .replace(/[,.\s-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ");
}

// ─── Wrong files ────────────────────────────────────────────────────────────

/**
 * Any header that looks like claims or money data. The patient import never
 * stores these, so a file carrying them is refused instead of silently dropping
 * them (which would hide that someone uploaded the wrong file).
 */
const FINANCIAL_HEADER_RE =
  /(amount|paid|payment|pay\b|charge|reimburs|balance|copay|co-pay|coinsurance|deductible|\bdue\b|billed|price|\bfee|\$|cpt|hcpcs|diagnos|icd|modifier|\bunits?\b|claim|invoice|eob|remit|check|eft|payer|adjust|\btotal\b(?! authorized))/i;

export function financialHeaders(headers: string[]): string[] {
  return headers.filter(h => FINANCIAL_HEADER_RE.test(normalizeHeader(h)));
}

export interface PatientCsvFileError {
  code: "too_large" | "empty" | "claims_template" | "financial_columns" | "missing_name_column" | "too_many_rows";
  message: string;
}

// ─── Rows ───────────────────────────────────────────────────────────────────

export interface PatientCsvVisit {
  sessionsAuthorized: number | null;
  sessionsRemaining: number | null;
  sessionNumber: number | null;
  dateOfService: string | null;
  newAuth: "YES" | "NO";
  dateAuthSubmitted: string | null;
}

export interface PatientCsvRow {
  /** 1-based line number in the file as a spreadsheet shows it. */
  line: number;
  name: string;
  nameKey: string;
  insurance: string;
  authDate: string | null;
  /** null when the row carries no session data (patient only). */
  visit: PatientCsvVisit | null;
  errors: string[];
}

export interface ParsedPatientCsv {
  fileError: PatientCsvFileError | null;
  rows: PatientCsvRow[];
  /** Header names that are not part of the template and were ignored. */
  ignoredColumns: string[];
}

function intCell(v: string, min: number, max: number, label: string, errors: string[]): number | null {
  if (!v) return null;
  if (!/^\d+$/.test(v)) {
    errors.push(`${label} "${v}" must be a whole number.`);
    return null;
  }
  const n = Number(v);
  if (n < min || n > max) {
    errors.push(`${label} "${v}" must be between ${min} and ${max}.`);
    return null;
  }
  return n;
}

function dateCell(v: string, label: string, errors: string[]): string | null {
  const r = parseCsvDate(v);
  if (!r.ok) {
    errors.push(`${label}: ${r.error}`);
    return null;
  }
  return r.value;
}

/** Parses and validates the whole file. Never throws; never touches the database. */
export function parsePatientCsv(text: string): ParsedPatientCsv {
  const empty = (fileError: PatientCsvFileError): ParsedPatientCsv => ({ fileError, rows: [], ignoredColumns: [] });

  if (new TextEncoder().encode(text).length > PATIENT_CSV_MAX_BYTES) {
    return empty({ code: "too_large", message: `The file is larger than ${PATIENT_CSV_MAX_BYTES / 1_000_000} MB. Split it into smaller files.` });
  }

  const { body, skippedLines } = stripLeadingCommentLines(text);
  const parsed = Papa.parse<string[]>(body, { skipEmptyLines: "greedy" });
  const [headerRow, ...dataRows] = parsed.data;
  if (!headerRow || headerRow.every(h => !h.trim())) {
    return empty({ code: "empty", message: "The file is empty. Download the template and add one row per patient session." });
  }

  const headers = headerRow.map(normalizeHeader);
  const detected = detectCsvTemplate(headers);
  if (detected === "cms1500" || detected === "eob" || detected === "cms1500_export") {
    return empty({
      code: "claims_template",
      message: "This is a claims file (CMS1500 or Insurance Reimbursement), not the patient template. Nothing was imported. Claims files are uploaded under Bulk Upload by a Clinic Admin or the Owner.",
    });
  }
  const money = financialHeaders(headerRow);
  if (money.length > 0) {
    return empty({
      code: "financial_columns",
      message: `The patient import does not accept claims or payment columns (${money.map(h => `"${h.trim()}"`).join(", ")}). Remove them, or use the patient template. Nothing was imported.`,
    });
  }

  const index = new Map<PatientCsvField, number>();
  const known = new Set<number>();
  for (const col of PATIENT_CSV_COLUMNS) {
    for (const alias of col.headers) {
      const i = headers.indexOf(normalizeHeader(alias));
      if (i >= 0 && !index.has(col.field)) {
        index.set(col.field, i);
        known.add(i);
      }
    }
  }
  if (!index.has("name")) {
    return empty({ code: "missing_name_column", message: `The file has no "Patient Name" column. Download ${PATIENT_CSV_FILE_NAME} and use its header row.` });
  }
  if (dataRows.length === 0) {
    return empty({ code: "empty", message: "The file has a header row but no patients." });
  }
  if (dataRows.length > PATIENT_CSV_MAX_ROWS) {
    return empty({ code: "too_many_rows", message: `The file has ${dataRows.length} rows; the limit is ${PATIENT_CSV_MAX_ROWS}. Split it into smaller files.` });
  }

  const ignoredColumns = headerRow.filter((h, i) => h.trim() && !known.has(i)).map(h => h.trim());
  const get = (cells: string[], f: PatientCsvField) => {
    const i = index.get(f);
    return i === undefined ? "" : cleanCell(cells[i]);
  };

  // Header line in the file = skippedLines + 1; data row k (0-based) = skippedLines + 2 + k.
  // greedy skipEmptyLines can shift this for blank lines inside the data; acceptable for messages.
  const rows: PatientCsvRow[] = dataRows.map((cells, k) => {
    const errors: string[] = [];
    const name = get(cells, "name").replace(/\s+/g, " ");
    if (!name) errors.push("Patient Name is required.");
    else if (name.length > PATIENT_NAME_MAX) errors.push(`Patient Name is longer than ${PATIENT_NAME_MAX} characters.`);
    else if (/^[=+@]/.test(name)) errors.push("Patient Name cannot start with =, + or @.");

    const insurance = get(cells, "insurance").replace(/\s+/g, " ");
    if (insurance.length > 120) errors.push("Insurance is longer than 120 characters.");

    const authorized = intCell(get(cells, "authorized"), 0, 999, "Authorized Sessions", errors);
    const sessionNumber = intCell(get(cells, "sessionNumber"), 1, 999, "Session Number", errors);
    const remainingRaw = intCell(get(cells, "remaining"), 0, 999, "Sessions Remaining", errors);
    const authDate = dateCell(get(cells, "authDate"), "Authorization Date", errors);
    const dateOfService = dateCell(get(cells, "dateOfService"), "Date of Service", errors);
    const dateAuthSubmitted = dateCell(get(cells, "authSubmitted"), "Date Authorization Submitted", errors);

    const newAuthRaw = get(cells, "newAuth").toUpperCase();
    let newAuth: "YES" | "NO" = "NO";
    if (newAuthRaw === "YES" || newAuthRaw === "Y") newAuth = "YES";
    else if (newAuthRaw && newAuthRaw !== "NO" && newAuthRaw !== "N") errors.push(`New Authorization? "${newAuthRaw}" must be YES or NO.`);

    const remaining = remainingRaw ?? authorized;
    if (authorized !== null && remaining !== null && remaining > authorized) {
      errors.push(`Sessions Remaining (${remaining}) is more than Authorized Sessions (${authorized}).`);
    }

    const hasVisit = authorized !== null || sessionNumber !== null || remainingRaw !== null || dateOfService !== null
      || dateAuthSubmitted !== null || newAuthRaw !== "";
    return {
      line: skippedLines + 2 + k,
      name,
      nameKey: name ? patientNameKey(name) : "",
      insurance,
      authDate,
      visit: hasVisit
        ? { sessionsAuthorized: authorized, sessionsRemaining: remaining, sessionNumber, dateOfService, newAuth, dateAuthSubmitted }
        : null,
      errors,
    };
  });

  return { fileError: null, rows, ignoredColumns };
}

// ─── Groups (one per patient) ───────────────────────────────────────────────

export type PatientGroupStatus =
  /** Will be created with its sessions when saved. */
  | "new"
  /** A patient with this name is already on the dashboard; nothing is changed. */
  | "existing"
  /** Similar to an existing patient (e.g. a middle initial or suffix). Not saved unless the reviewer ticks it. */
  | "possible_duplicate"
  /** One or more rows have errors; nothing for this patient is saved. */
  | "invalid";

export interface PatientCsvGroup {
  key: string;
  name: string;
  insurance: string;
  authDate: string | null;
  lines: number[];
  visits: PatientCsvVisit[];
  /** Lines dropped because they repeat another line of this patient exactly. */
  duplicateLines: number[];
  status: PatientGroupStatus;
  errors: string[];
  /** Name of the existing dashboard patient this matches, if any. */
  matchedName: string | null;
}

/** Groups validated rows by patient (same name key), merging insurance / authorization date and de-duplicating sessions. */
export function groupPatientRows(rows: PatientCsvRow[]): PatientCsvGroup[] {
  const groups = new Map<string, PatientCsvGroup>();
  const invalidNoName: PatientCsvGroup[] = [];
  for (const row of rows) {
    if (!row.nameKey) {
      invalidNoName.push({
        key: `line-${row.line}`, name: "", insurance: "", authDate: null, lines: [row.line], visits: [], duplicateLines: [],
        status: "invalid", errors: row.errors.map(e => `Line ${row.line}: ${e}`), matchedName: null,
      });
      continue;
    }
    let g = groups.get(row.nameKey);
    if (!g) {
      g = { key: row.nameKey, name: row.name, insurance: "", authDate: null, lines: [], visits: [], duplicateLines: [], status: "new", errors: [], matchedName: null };
      groups.set(row.nameKey, g);
    }
    g.lines.push(row.line);
    for (const e of row.errors) g.errors.push(`Line ${row.line}: ${e}`);
    if (row.insurance) {
      if (g.insurance && g.insurance.toLowerCase() !== row.insurance.toLowerCase()) {
        g.errors.push(`Line ${row.line}: Insurance "${row.insurance}" differs from "${g.insurance}" on an earlier line for this patient.`);
      } else g.insurance = row.insurance;
    }
    if (row.authDate) {
      if (g.authDate && g.authDate !== row.authDate) {
        g.errors.push(`Line ${row.line}: Authorization Date ${row.authDate} differs from ${g.authDate} on an earlier line for this patient.`);
      } else g.authDate = row.authDate;
    }
    if (row.visit) {
      const same = g.visits.find(v => JSON.stringify(v) === JSON.stringify(row.visit));
      if (same) g.duplicateLines.push(row.line);
      else g.visits.push(row.visit);
    }
  }
  const out = [...Array.from(groups.values()), ...invalidNoName];
  for (const g of out) if (g.errors.length > 0) g.status = "invalid";
  return out;
}
