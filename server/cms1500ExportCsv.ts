/**
 * server/cms1500ExportCsv.ts — P4-P28
 *
 * Deterministic adapter for the billing system's invoice export uploaded
 * under Bulk Upload → CMS1500 (columns: CMS1500_EXPORT_HEADERS in
 * shared/claimCsvTemplates.ts). One CSV row is one invoice, and its multiline
 * Description holds any number of service blocks:
 *
 *   <payer label>
 *   1x 97530 - Therapeutic activities ($175.00)
 *   R29.6, R26.89, M62.81, M54.50
 *   1x 97112 - Neuromuscular reeducation ($175.00)
 *   R29.6, R26.89, M62.81
 *   Coinsurance: $350.00
 *
 * What is read, and from where:
 *   - invoice id       Invoice # (string; the document identity)
 *   - date of service  Service Date(s). Invoice Date(s) is never a service date.
 *   - CPT, units       the explicit code and "<n>x" of each service block
 *   - diagnosis codes  the ICD-10 line(s) directly under that block
 *   - patient          Patient, patient_guid (the billing system's own id, in
 *                      its own namespace), Birth Date (identity evidence only)
 *
 * What is never read: Total, Balance, the block's ($ price), coinsurance /
 * copay lines. They are the billing system's patient-invoice figures, not
 * payer data, so nothing here can become a payment or a reimbursement.
 *
 * Nothing is guessed. A code is taken only when it is printed in CPT/HCPCS
 * shape; a vague block ("1x Home visit") keeps its text as a note with the CPT
 * blank and flagged for review, and an invoice listing several service dates
 * leaves each line's date for the reviewer. The file itself is never trusted
 * to have stable row or block order: identity comes from the invoice id and
 * each block's own content (code, modifiers, units, diagnosis codes), plus an
 * occurrence only among blocks that are identical. A key match is still not
 * proof of the same service, so re-imports are also compared with what is saved
 * (exportLineIdentityProblem in shared/claimImport.ts).
 */
import { createHash } from "node:crypto";
import Papa from "papaparse";
import { CMS1500_EXPORT_HEADERS, CMS1500_EXPORT_REQUIRED, cleanCell, normalizeHeader, parseCsvDate } from "@shared/claimCsvTemplates";

export const BILLING_EXPORT_SOURCE_SYSTEM = "billing_invoice_export";

export interface ExportServiceLine {
  /** Stable within the invoice: "<code or X>.<content hash>.<occurrence among identical blocks>". */
  lineId: string;
  cptCode: string | null;
  modifiers: string | null;
  units: number | null;
  diagnosisCodes: string | null;
  /** Field names (Cms1500ImportLine) that must be reviewed: their values are null or partial. */
  unreadable: string[];
  notes: string | null;
}

export interface ExportInvoice {
  invoiceId: string;
  row: number;
  patientName: string | null;
  externalPatientId: string | null;
  birthDate: string | null;
  /** Every date listed in Service Date(s), in order, de-duplicated. */
  serviceDates: string[];
  /** The line's date when exactly one is listed; otherwise the reviewer picks one of serviceDates. */
  dateOfService: string | null;
  /** First Description line (payer / policy text). Shown to the reviewer, never saved. */
  payerLabel: string | null;
  services: ExportServiceLine[];
  warnings: string[];
}

export interface ExportRowError {
  row: number | null;
  claimId: string | null;
  message: string;
}

export interface ParsedExport {
  templateError: string | null;
  rowErrors: ExportRowError[];
  invoices: ExportInvoice[];
  blockedInvoiceIds: string[];
  dataRowCount: number;
  /** Columns present in the file that are not read at all (not in the known export). */
  unknownColumns: string[];
}

const CPT_RE = /^(?:\d{5}|\d{4}[A-Z]|[A-Z]\d{4})$/;
const ICD10_TOKEN_RE = /^[A-Z]\d[0-9A-Z](?:\.[0-9A-Z]{1,4})?$/;
/** "<label>: $12.34" summary lines: coinsurance, copay, deductible, totals. Never imported. */
const AMOUNT_LINE_RE = /^[A-Za-z][A-Za-z /-]*:\s*-?\$?[\d,]+(?:\.\d{1,2})?\s*$/;
const PRICE_SUFFIX_RE = /\s*\(\s*-?\$?[\d,]+(?:\.\d{1,2})?\s*\)\s*$/;

interface BlockHead {
  units: number | null;
  unitsUnreadable: boolean;
  cpt: string | null;
  modifiers: string | null;
  text: string;
}

/** "1x 97530 - Therapeutic activities ($175.00)" → its explicit parts, or null when the line is not a service block. */
function parseBlockHead(raw: string): BlockHead | null {
  const line = raw.trim();
  const qty = line.match(/^(\d+)\s*[xX×]\s+(.+)$/);
  const body = (qty ? qty[2] : line).trim();
  const coded = body.match(/^([A-Za-z0-9]{5})((?:[\s:-]+[A-Z0-9]{2})*)(?:\s*[-–:]\s+(.*))?$/);
  const code = coded?.[1].toUpperCase();
  if (coded && code && CPT_RE.test(code)) {
    const mods = (coded[2] ?? "").split(/[\s:-]+/).filter(Boolean);
    const units = qty ? Number(qty[1]) : null;
    const usable = units != null && units >= 1 && units <= 999;
    return {
      units: usable ? units : null,
      unitsUnreadable: !usable,
      cpt: code,
      modifiers: mods.length > 0 ? mods.join(", ") : null,
      text: (coded[3] ?? "").replace(PRICE_SUFFIX_RE, "").trim(),
    };
  }
  if (!qty && !PRICE_SUFFIX_RE.test(line)) return null;
  // A quantity or a price with no printed code: a service, but its CPT is not stated.
  const units = qty ? Number(qty[1]) : null;
  const usable = units != null && units >= 1 && units <= 999;
  return { units: usable ? units : null, unitsUnreadable: !usable, cpt: null, modifiers: null, text: body.replace(PRICE_SUFFIX_RE, "").trim() };
}

function diagnosisTokens(raw: string): string[] | null {
  const tokens = raw.toUpperCase().split(/[\s,;]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  // A line is a diagnosis line only when its tokens look like codes (mostly);
  // a sentence with one code-shaped word stays an unrecognized line.
  const good = tokens.filter(t => ICD10_TOKEN_RE.test(t));
  return good.length * 2 > tokens.length ? tokens : null;
}

/** Parses one Description cell. Throws nothing: anything unrecognized becomes a flagged line. */
export function parseExportDescription(description: string): { payerLabel: string | null; services: ExportServiceLine[]; warnings: string[] } {
  const lines = description.split(/\r\n|\n|\r/).map(l => l.trim()).filter(Boolean);
  const warnings: string[] = [];
  let payerLabel: string | null = null;

  type Block = BlockHead & { dx: string[]; dxBad: string[]; extra: string[]; rawText: string };
  const blocks: Block[] = [];
  const open = (head: BlockHead, rawText: string) => blocks.push({ ...head, dx: [], dxBad: [], extra: [], rawText });

  lines.forEach((line, i) => {
    if (AMOUNT_LINE_RE.test(line)) return;
    const head = parseBlockHead(line);
    if (head) { open(head, line); return; }
    const dx = diagnosisTokens(line);
    if (dx) {
      const block = blocks[blocks.length - 1];
      if (!block) { warnings.push("Diagnosis codes appear before any service in the description and were not used."); return; }
      for (const t of dx) {
        if (!ICD10_TOKEN_RE.test(t)) block.dxBad.push(t);
        else if (!block.dx.includes(t)) block.dx.push(t);
      }
      return;
    }
    if (i === 0) { payerLabel = line; return; }
    // Unrecognized text is never dropped: it is a service the reviewer resolves or skips.
    open({ units: null, unitsUnreadable: true, cpt: null, modifiers: null, text: line }, line);
  });

  const seen = new Map<string, number>();
  const services = blocks.map((b): ExportServiceLine => {
    // Diagnosis order is kept: the first code is the primary one. A printed price is not part of the service.
    const content = [b.cpt ?? b.rawText.toUpperCase(), b.modifiers, b.units, b.dx.join(","), b.dxBad.join(",")].join("|");
    const stem = `${b.cpt ?? "X"}.${createHash("sha256").update(content).digest("hex").slice(0, 10)}`;
    const n = seen.get(stem) ?? 0;
    seen.set(stem, n + 1);
    const unreadable: string[] = [];
    const notes: string[] = [];
    if (!b.cpt) {
      unreadable.push("cptCodes");
      notes.push(`No CPT code is printed for "${b.text.slice(0, 120)}". Enter the code from your records, or skip this line.`);
    }
    if (b.unitsUnreadable) {
      unreadable.push("unitsBilled");
      notes.push("Units are not stated for this service.");
    }
    if (b.dx.length === 0 || b.dxBad.length > 0) {
      unreadable.push("diagnosisCodes");
      notes.push(b.dxBad.length > 0 ? `Diagnosis value(s) ${b.dxBad.join(", ")} are not ICD-10 codes.` : "No diagnosis codes are listed under this service.");
    }
    return {
      lineId: `${stem}.${n}`,
      cptCode: b.cpt,
      modifiers: b.modifiers,
      units: b.units,
      diagnosisCodes: b.dxBad.length > 0 || b.dx.length === 0 ? null : b.dx.join(", "),
      unreadable,
      notes: notes.length > 0 ? notes.join(" ") : null,
    };
  });
  return { payerLabel, services, warnings };
}

function parseServiceDates(raw: string): { dates: string[]; bad: string[] } {
  const parts = raw.split(/[,;\n]|\s+to\s+/i).map(s => s.trim()).filter(Boolean);
  const dates: string[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    const r = parseCsvDate(p);
    if (r.ok && r.value) { if (!dates.includes(r.value)) dates.push(r.value); }
    else bad.push(p);
  }
  return { dates, bad };
}

/**
 * Parses the export's text (leading # lines already removed). Invoices with an
 * unusable invoice id or no service are row errors; every other gap becomes a
 * flagged value that the review screen resolves.
 */
export function parseCms1500Export(body: string, skippedLines: number, maxRows: number): ParsedExport {
  const base = { rowErrors: [] as ExportRowError[], invoices: [] as ExportInvoice[], blockedInvoiceIds: [] as string[], dataRowCount: 0, unknownColumns: [] as string[] };
  const parsed = Papa.parse<string[]>(body, { skipEmptyLines: false });
  const table = parsed.data;
  const headers = (table[0] ?? []).map(normalizeHeader);

  const missing = CMS1500_EXPORT_REQUIRED.filter(h => !headers.includes(h));
  if (missing.length > 0) {
    return { ...base, templateError: `This invoice export is missing required column(s): ${missing.join(", ")}. Nothing was imported. Export it again with those columns, or use the CMS1500 CSV template.` };
  }
  const col = (h: string) => headers.indexOf(h);
  const known = new Set<string>(CMS1500_EXPORT_HEADERS);
  const unknownColumns = headers.filter(h => h && !known.has(h));

  const quoteErrorRows = new Set(parsed.errors.filter(e => e.row != null).map(e => e.row!));
  const rowErrors: ExportRowError[] = [];
  type Row = { row: number; invoiceId: string; cells: string[] };
  const rows: Row[] = [];
  let dataRowCount = 0;
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    if (cells.every(c => !c.trim())) continue;
    dataRowCount++;
    const row = skippedLines + i + 1;
    const invoiceId = cleanCell(cells[col("invoice #")]).replace(/\s+/g, " ").toUpperCase();
    const errs: string[] = [];
    if (quoteErrorRows.has(i)) errs.push("Unbalanced quotes in this row.");
    if (cells.length !== headers.length) errs.push(`This row has ${cells.length} cells, but the header has ${headers.length} columns. Export the file again without editing it.`);
    if (!invoiceId) errs.push("Invoice # is empty. Each invoice needs its number so that re-importing it cannot create duplicates.");
    else if (invoiceId.length > 80) errs.push("Invoice # is longer than 80 characters.");
    else if (/^[#=+@]/.test(invoiceId)) errs.push(`Invoice # "${invoiceId}" cannot start with #, =, + or @.`);
    if (errs.length > 0) {
      for (const message of errs) rowErrors.push({ row, claimId: invoiceId || null, message });
      if (invoiceId && invoiceId.length <= 80) base.blockedInvoiceIds.push(invoiceId);
      continue;
    }
    rows.push({ row, invoiceId, cells });
  }
  if (dataRowCount === 0) return { ...base, templateError: "The file has a header row but no data rows." };
  if (dataRowCount > maxRows) return { ...base, templateError: `The file has ${dataRowCount} rows; the limit is ${maxRows}. Split it into smaller files.` };

  // The same invoice twice: an exact repeat is one invoice; a different repeat cannot be told apart safely.
  const fingerprint = (cells: string[]) => cells.map(c => c.trim()).join("\u0000");
  const byInvoice = new Map<string, Row>();
  for (const r of rows) {
    const first = byInvoice.get(r.invoiceId);
    if (!first) { byInvoice.set(r.invoiceId, r); continue; }
    if (fingerprint(first.cells) !== fingerprint(r.cells)) {
      rowErrors.push({ row: r.row, claimId: r.invoiceId, message: `Invoice # ${r.invoiceId} is also on row ${first.row} with different values. Correct the file so each invoice number appears once.` });
      base.blockedInvoiceIds.push(r.invoiceId);
    }
  }

  const invoices: ExportInvoice[] = [];
  for (const [invoiceId, r] of Array.from(byInvoice.entries())) {
    if (base.blockedInvoiceIds.includes(invoiceId)) continue;
    const cell = (h: string) => (col(h) >= 0 ? cleanCell(r.cells[col(h)]) : "");
    const { payerLabel, services, warnings } = parseExportDescription(r.cells[col("description")] ?? "");
    if (services.length === 0) {
      rowErrors.push({ row: r.row, claimId: invoiceId, message: "No service lines were found in Description." });
      base.blockedInvoiceIds.push(invoiceId);
      continue;
    }
    const { dates, bad } = parseServiceDates(cell("service date(s)"));
    if (dates.length === 0) warnings.push(bad.length > 0 ? `Service Date(s) "${bad.join(", ")}" could not be read. Enter each line's date of service.` : "Service Date(s) is empty. Enter each line's date of service.");
    else if (dates.length > 1) warnings.push(`This invoice lists ${dates.length} service dates and does not say which service was on which date. Choose the date for each line.`);
    if (dates.length > 0 && bad.length > 0) warnings.push(`Part of Service Date(s) could not be read: ${bad.join(", ")}.`);

    const dobCell = cell("birth date");
    const dob = dobCell ? parseCsvDate(dobCell) : null;
    if (dob && !dob.ok) warnings.push("Birth Date could not be read, so it was not used to check the patient's identity.");
    const name = cell("patient").replace(/\s+/g, " ");
    const guid = cell("patient_guid");
    invoices.push({
      invoiceId,
      row: r.row,
      patientName: name && name.length <= 200 ? name : null,
      externalPatientId: guid && guid.length <= 120 ? guid : null,
      birthDate: dob && dob.ok ? dob.value : null,
      serviceDates: dates,
      dateOfService: dates.length === 1 ? dates[0] : null,
      payerLabel,
      services,
      warnings,
    });
  }

  rowErrors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
  return { templateError: null, rowErrors, invoices, blockedInvoiceIds: Array.from(new Set(base.blockedInvoiceIds)), dataRowCount, unknownColumns };
}

/** File-level identity contradictions, keyed by invoice id: reviewed before any patient is matched or created. */
export function exportIdentityConflicts(invoices: ExportInvoice[]): Map<string, string> {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z ]+/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
  const byGuid = new Map<string, ExportInvoice[]>();
  const byName = new Map<string, ExportInvoice[]>();
  for (const inv of invoices) {
    if (inv.externalPatientId) byGuid.set(inv.externalPatientId, [...(byGuid.get(inv.externalPatientId) ?? []), inv]);
    if (inv.patientName) byName.set(norm(inv.patientName), [...(byName.get(norm(inv.patientName)) ?? []), inv]);
  }
  const conflicts = new Map<string, string>();
  const flag = (list: ExportInvoice[], message: string) => { for (const inv of list) conflicts.set(inv.invoiceId, message); };
  for (const list of Array.from(byGuid.values())) {
    if (new Set(list.map(i => i.birthDate).filter(Boolean)).size > 1) flag(list, "One patient_guid in this file has more than one Birth Date.");
    else if (new Set(list.map(i => (i.patientName ? norm(i.patientName) : null)).filter(Boolean)).size > 1) flag(list, "One patient_guid in this file has more than one patient name.");
  }
  for (const list of Array.from(byName.values())) {
    const guids = new Set(list.map(i => i.externalPatientId).filter(Boolean));
    const dobs = new Set(list.map(i => i.birthDate).filter(Boolean));
    if (guids.size > 1) flag(list, "This patient name appears with more than one patient_guid in this file, so these may be different people.");
    else if (dobs.size > 1) flag(list, "This patient name appears with more than one Birth Date in this file, so these may be different people.");
  }
  return conflicts;
}
