/**
 * server/claimCsvImport.ts — P4-P26
 *
 * The CMS1500 CSV and Insurance Reimbursement CSV bulk uploads
 * (claims.csvImportPreview / claims.csvImportCommit in routers.ts). The
 * template definitions, cell rules and wrong-template messages live in
 * shared/claimCsvTemplates.ts.
 *
 * The client sends the CSV text on every preview AND every commit; the
 * server re-parses it each time, so provenance, line keys and line values
 * always come from the file — never from client-supplied fields. Reviewer
 * input is limited to patient choices/confirmations and per-line decisions,
 * and each decision is re-validated (see ClaimImportHints in
 * server/claimImport.ts).
 *
 * Every claim (cms1500_claim_id / reimbursement_id) becomes one import
 * document whose identity is derived from that id alone:
 *   document  sha256("claims-csv:v1:<kind>:<CLAIM ID>")
 *   line key  "<groupKey>:csv.<LINE ID>"
 * so the same claim in an edited, re-sorted or re-downloaded file resolves
 * to the same claim_import_documents row and the same source lines. That is
 * what makes a reimport or a partial retry a no-op for lines already saved
 * (unique (document, line key) indexes + the audited RPCs). These derived
 * hashes live in the same column as PDF content hashes; the "claims-csv:v1"
 * namespace means a CSV id can never equal a file's bytes hash.
 *
 * Persistence is the P4-P24 path unchanged: previewClaimImport /
 * commitClaimImport → commit_cms1500_line_with_audit /
 * apply_eob_line_with_audit (CMS1500-first, per-patient lock, atomic
 * row + audit). A claim with any invalid row is not imported at all (no
 * half-claims); the other claims in the file still are.
 */
import Papa from "papaparse";
import { z } from "zod";
import {
  CLAIM_CSV_MAX_BYTES,
  CLAIM_CSV_MAX_ROWS,
  CLAIM_CSV_TEMPLATES,
  EXAMPLE_ID_PREFIX,
  detectCsvTemplate,
  normalizeHeader,
  parseCsvCell,
  stripLeadingCommentLines,
  wrongTemplateMessage,
  type ClaimCsvKind,
} from "@shared/claimCsvTemplates";
import {
  CLAIM_IMPORT_KEY_RE,
  type Cms1500ImportLine,
  type EobCsvTarget,
  type EobImportLine,
  type ImportDocument,
  type ImportGroup,
  type UnresolvedClaimTotal,
} from "@shared/claimImport";
import { fuzzyNameMatch } from "@shared/nameMatch";
import { randomUUID } from "crypto";
import { groupKeyFor, sha256Hex } from "./claimImportKeys";
import {
  cms1500Decision,
  commitClaimImport,
  eobDecision,
  importCommitInput,
  importPreviewInput,
  previewClaimImport,
  resolveGroupPatient,
  type ClaimImportHints,
  type CommitGroupResult,
  type CommitLineResult,
  type PreviewGroup,
} from "./claimImport";
import { findClaimImportDocumentId, getAllPatients } from "./db";
import type { ActorContext } from "./actorIdentity";

// ─── Identity ────────────────────────────────────────────────────────────────

export function csvDocumentSha256(kind: ClaimCsvKind, claimId: string): string {
  return sha256Hex(Buffer.from(`claims-csv:v1:${kind}:${claimId}`, "utf8"));
}

export function csvGroupKey(kind: ClaimCsvKind, claimId: string): string {
  return groupKeyFor(`claims-csv:${kind}:${claimId}`);
}

export function csvLineKey(kind: ClaimCsvKind, claimId: string, lineId: string): string {
  const key = `${csvGroupKey(kind, claimId)}:csv.${lineId}`;
  if (!CLAIM_IMPORT_KEY_RE.test(key)) throw new Error(`Generated CSV line key is invalid: ${key}`);
  return key;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

export interface CsvRowError {
  /** Spreadsheet row number (the header is row 1 after any # lines above it). */
  row: number | null;
  claimId: string | null;
  message: string;
}

type Values = Record<string, string | number | null>;

interface CmsRef { claimId: string; lineId: string }

export interface CsvClaim {
  kind: ClaimCsvKind;
  claimId: string;
  sha256: string;
  groupKey: string;
  patientName: string;
  patientId: string | null;
  rows: number[];
  lines: Array<Cms1500ImportLine | EobImportLine>;
  /** CMS1500: auth_period the row states. EOB: the period restriction. */
  periods: Record<string, number>;
  /** EOB: the CMS1500 CSV line each row references. */
  refs: Record<string, CmsRef>;
  warnings: string[];
  unresolvedClaimTotals: UnresolvedClaimTotal[];
}

export interface ParsedClaimCsv {
  kind: ClaimCsvKind;
  /** The whole file was refused (wrong template, bad header, too large). Nothing else is set. */
  templateError: string | null;
  rowErrors: CsvRowError[];
  claims: CsvClaim[];
  /** Claims left out because one of their rows has an error. */
  blockedClaimIds: string[];
  dataRowCount: number;
}

const refused = (kind: ClaimCsvKind, templateError: string): ParsedClaimCsv =>
  ({ kind, templateError, rowErrors: [], claims: [], blockedClaimIds: [], dataRowCount: 0 });

const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function parseClaimCsv(kind: ClaimCsvKind, text: string): ParsedClaimCsv {
  const template = CLAIM_CSV_TEMPLATES[kind];
  if (Buffer.byteLength(text, "utf8") > CLAIM_CSV_MAX_BYTES) return refused(kind, `The file is larger than ${CLAIM_CSV_MAX_BYTES / 1_000_000} MB. Split it into smaller files.`);

  const { body, skippedLines } = stripLeadingCommentLines(text);
  const parsed = Papa.parse<string[]>(body, { skipEmptyLines: false });
  const table = parsed.data;
  if (table.length === 0 || table[0].every(c => !c.trim())) return refused(kind, `The file is empty. Download ${template.fileName} and add one row per line.`);

  const headers = table[0].map(normalizeHeader);
  const wrong = wrongTemplateMessage(kind, detectCsvTemplate(headers));
  if (wrong) return refused(kind, wrong);

  const known = new Map(template.fields.map(f => [f.header, f]));
  const named = headers.filter(Boolean);
  const dupes = named.filter((h, i) => named.indexOf(h) !== i);
  if (dupes.length) return refused(kind, `Column ${Array.from(new Set(dupes)).join(", ")} appears more than once.`);
  const unknown = named.filter(h => !known.has(h));
  if (unknown.length) return refused(kind, `Unknown column(s): ${unknown.join(", ")}. Use the header row from ${template.fileName}.`);
  const missing = template.fields.filter(f => f.required && !headers.includes(f.header)).map(f => f.header);
  if (missing.length) return refused(kind, `Missing required column(s): ${missing.join(", ")}.`);

  const rowErrors: CsvRowError[] = [];
  const quoteErrorRows = new Set(parsed.errors.filter(e => e.row != null).map(e => e.row!));
  const rows: Array<{ row: number; values: Values }> = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    if (cells.every(c => !c.trim())) continue;
    const row = skippedLines + i + 1;
    const errs: string[] = [];
    if (quoteErrorRows.has(i)) errs.push("Unbalanced quotes in this row.");
    // Spreadsheets pad the header row too, so a row longer than the header is
    // always a shifted row (typically an unquoted "GP, 59").
    if (cells.length > headers.length || cells.some((c, j) => !headers[j] && c.trim())) {
      errs.push("More cells than columns — a cell with several codes (modifiers, diagnosis codes) is probably missing its surrounding quotes.");
    }
    const values: Values = {};
    for (const field of template.fields) {
      const j = headers.indexOf(field.header);
      const r = parseCsvCell(field, j >= 0 ? cells[j] : "");
      if (r.ok) values[field.header] = r.value;
      else errs.push(r.error);
    }
    const claimId = values[template.claimIdHeader] as string | null;
    if (claimId && claimId.startsWith(EXAMPLE_ID_PREFIX)) errs.push("This is an example row from the template. Delete it before importing.");
    if (kind === "eob" && (values.cms1500_claim_id == null) !== (values.cms1500_line_id == null)) {
      errs.push("Fill both cms1500_claim_id and cms1500_line_id, or leave both blank.");
    }
    for (const message of errs) rowErrors.push({ row, claimId, message });
    rows.push({ row, values: errs.length ? { ...values, __invalid: 1 } : values });
  }
  if (rows.length === 0) return refused(kind, "The file has a header row but no data rows.");
  if (rows.length > CLAIM_CSV_MAX_ROWS) return refused(kind, `The file has ${rows.length} rows; the limit is ${CLAIM_CSV_MAX_ROWS}. Split it into smaller files.`);

  // Group by claim id; a row without a valid claim id cannot belong to any claim.
  const byClaim = new Map<string, Array<{ row: number; values: Values }>>();
  for (const r of rows) {
    const id = r.values[template.claimIdHeader] as string | null;
    if (!id) continue;
    byClaim.set(id, [...(byClaim.get(id) ?? []), r]);
  }

  const claims: CsvClaim[] = [];
  const blockedClaimIds: string[] = [];
  for (const [claimId, claimRows] of Array.from(byClaim.entries())) {
    const errs: CsvRowError[] = [];
    const first = claimRows[0].values;
    const name = String(first.patient_name ?? "");
    for (const r of claimRows) {
      if (r.values.patient_name != null && normName(String(r.values.patient_name)) !== normName(name)) {
        errs.push({ row: r.row, claimId, message: `patient_name differs from row ${claimRows[0].row} of the same claim. One claim belongs to one patient.` });
      }
      if ((r.values.patient_id ?? null) !== (first.patient_id ?? null)) {
        errs.push({ row: r.row, claimId, message: `patient_id differs from row ${claimRows[0].row} of the same claim.` });
      }
    }
    const lineIds = claimRows.map(r => r.values[template.lineIdHeader] as string | null);
    claimRows.forEach((r, i) => {
      const id = lineIds[i];
      if (id && lineIds.indexOf(id) !== i) {
        errs.push({ row: r.row, claimId, message: `${template.lineIdHeader} "${id}" is used twice in this claim (also row ${claimRows[lineIds.indexOf(id)].row}). Give each line its own ID — identical CPT lines included.` });
      }
    });

    const groupKey = csvGroupKey(kind, claimId);
    const periods: Record<string, number> = {};
    const refs: Record<string, CmsRef> = {};
    const lines = claimRows.map(({ row, values: v }) => {
      const lineId = v[template.lineIdHeader] as string | null;
      const sourceLineKey = lineId ? csvLineKey(kind, claimId, lineId) : `${groupKey}:invalid.${row}`;
      if (v.auth_period != null) periods[sourceLineKey] = v.auth_period as number;
      if (kind === "cms1500") {
        const line: Cms1500ImportLine = {
          sourceLineKey, page: null, slot: null,
          dateOfService: v.date_of_service as string | null,
          placeOfService: v.place_of_service as string | null,
          cptCodes: v.cpt_code as string | null,
          modifier: v.modifiers as string | null,
          unitsBilled: v.units as number | null,
          diagnosisPointer: null,
          diagnosisCodes: v.diagnosis_codes as string | null,
          claimSubmittedDate: v.claim_submitted_date as string | null,
          insuranceBilled: v.insurance_billed as string | null,
          visitNumber: v.visit_number as number | null,
          lineChargeForValidation: null,
          unreadable: [], notes: null, sourceRow: row,
        };
        return line;
      }
      if (v.cms1500_claim_id != null && v.cms1500_line_id != null) refs[sourceLineKey] = { claimId: v.cms1500_claim_id as string, lineId: v.cms1500_line_id as string };
      const line: EobImportLine = {
        sourceLineKey, page: null,
        dateOfService: v.date_of_service as string | null,
        cptCodes: v.cpt_code as string | null,
        modifier: v.modifiers as string | null,
        unitsBilled: v.units as number | null,
        chargeAmount: v.billed_charge as number | null,
        insuranceReimbursement: v.insurance_paid as number | null,
        patientAmountDue: v.patient_responsibility as number | null,
        patientAmountPaid: v.patient_paid as number | null,
        claimStatus: v.claim_status as string | null,
        oaClaimNumber: v.payer_claim_number as string | null,
        checkDate: v.payment_date as string | null,
        checkNumberVirtualCard: v.check_or_eft_number as string | null,
        notes: null, sourceRow: row,
      };
      return line;
    });

    const warnings: string[] = [];
    const unresolvedClaimTotals: UnresolvedClaimTotal[] = [];
    if (kind === "eob") {
      const total = (col: string) => {
        const vals = Array.from(new Set(claimRows.map(r => r.values[col]).filter(x => x != null))) as number[];
        if (vals.length > 1) errs.push({ row: null, claimId, message: `${col} has different values on rows of the same claim (${vals.join(", ")}). Give the claim total once, the same on every row.` });
        return vals.length === 1 ? vals[0] : null;
      };
      const paid = total("claim_total_paid");
      const resp = total("claim_total_patient_responsibility");
      if (paid != null || resp != null) {
        const eobLines = lines as EobImportLine[];
        const dates = Array.from(new Set(eobLines.map(l => l.dateOfService)));
        unresolvedClaimTotals.push({
          dateOfService: dates.length === 1 ? dates[0] : null,
          cptCodes: Array.from(new Set(eobLines.map(l => l.cptCodes).filter(Boolean))).join(", "),
          planPaid: paid,
          patientResponsibility: resp,
          cptCount: eobLines.length,
        });
        const linePaid = eobLines.map(l => l.insuranceReimbursement);
        if (paid != null && paid > 0 && eobLines.length > 1 && linePaid.every(p => p === paid)) {
          errs.push({ row: null, claimId, message: `insurance_paid repeats the claim total (${paid.toFixed(2)}) on every line. Enter each line's own payment, or leave insurance_paid blank and keep the total only in claim_total_paid.` });
        } else if (paid != null && linePaid.every(p => p != null)) {
          const sum = Math.round(linePaid.reduce((a, b) => a! + b!, 0)! * 100) / 100;
          if (Math.abs(sum - paid) > 0.004) warnings.push(`Line payments add up to $${sum.toFixed(2)}, but claim_total_paid is $${paid.toFixed(2)}. Review the remittance.`);
        }
        warnings.push("The claim total is shown for review only. It is not saved to, divided between or copied onto any line.");
      }
    }

    if (errs.length > 0 || claimRows.some(r => r.values.__invalid)) {
      rowErrors.push(...errs);
      blockedClaimIds.push(claimId);
      continue;
    }
    claims.push({
      kind, claimId, sha256: csvDocumentSha256(kind, claimId), groupKey,
      patientName: name, patientId: (first.patient_id as string | null) ?? null,
      rows: claimRows.map(r => r.row), lines, periods, refs, warnings, unresolvedClaimTotals,
    });
  }

  rowErrors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
  return { kind, templateError: null, rowErrors, claims, blockedClaimIds, dataRowCount: rows.length };
}

// ─── Roster checks (need the database) ────────────────────────────────────

type Roster = Array<{ id: string; name: string }>;

/** A patient_id in the file must be a real patient whose name matches patient_name. */
function checkFilePatient(claim: CsvClaim, roster: Roster): string | null {
  if (!claim.patientId) return null;
  const p = roster.find(r => r.id === claim.patientId);
  if (!p) return `patient_id ${claim.patientId} is not a patient on the dashboard. Leave it blank to match by name.`;
  if (!fuzzyNameMatch(claim.patientName, p.name)) return `patient_id ${claim.patientId} belongs to ${p.name}, not ${claim.patientName}.`;
  const resolved = resolveGroupPatient({ patientName: claim.patientName, requestedPatientId: claim.patientId, contextPatient: null, allPatients: roster });
  if (resolved.patientId && resolved.patientId !== claim.patientId) return `patient_name ${claim.patientName} matches a different patient than patient_id ${claim.patientId}.`;
  return null;
}

async function loadAndCheck(kind: ClaimCsvKind, csvText: string) {
  const parsed = parseClaimCsv(kind, csvText);
  if (parsed.templateError) return { parsed, roster: [] as Roster, claims: [] as CsvClaim[] };
  const roster = (await getAllPatients()).map(p => ({ id: p.id, name: p.name }));
  const claims: CsvClaim[] = [];
  for (const c of parsed.claims) {
    const problem = checkFilePatient(c, roster);
    if (problem) {
      parsed.rowErrors.push({ row: c.rows[0], claimId: c.claimId, message: problem });
      parsed.blockedClaimIds.push(c.claimId);
    } else {
      claims.push(c);
    }
  }
  return { parsed, roster, claims };
}

/** Server-only hints for one claim: the file's periods and (EOB) CMS1500 references. */
async function hintsFor(claim: CsvClaim, roster: Roster, cmsDocIds: Map<string, string | null>): Promise<ClaimImportHints> {
  if (claim.kind === "cms1500") return { filePeriods: claim.periods, roster };
  const eobTargets: Record<string, EobCsvTarget> = {};
  for (const line of claim.lines) {
    const ref = claim.refs[line.sourceLineKey];
    let cms1500Ref: EobCsvTarget["cms1500Ref"] = null;
    if (ref) {
      const sha = csvDocumentSha256("cms1500", ref.claimId);
      if (!cmsDocIds.has(sha)) cmsDocIds.set(sha, await findClaimImportDocumentId("cms1500", sha));
      cms1500Ref = { documentId: cmsDocIds.get(sha) ?? null, lineKey: csvLineKey("cms1500", ref.claimId, ref.lineId), label: `${ref.claimId} / line ${ref.lineId}` };
    }
    // Every CSV reimbursement line gets a target entry, so commit always re-validates its chosen row.
    eobTargets[line.sourceLineKey] = { cms1500Ref, authPeriod: claim.periods[line.sourceLineKey] ?? null };
  }
  return { eobTargets, roster };
}

function lineInput(kind: ClaimCsvKind, l: Cms1500ImportLine | EobImportLine) {
  if (kind === "cms1500") {
    const c = l as Cms1500ImportLine;
    return {
      sourceLineKey: c.sourceLineKey, dateOfService: c.dateOfService, cptCodes: c.cptCodes, modifier: c.modifier,
      unitsBilled: c.unitsBilled, placeOfService: c.placeOfService, diagnosisCodes: c.diagnosisCodes,
      claimSubmittedDate: c.claimSubmittedDate, insuranceBilled: c.insuranceBilled, visitNumber: c.visitNumber ?? null, unreadable: [],
    };
  }
  const e = l as EobImportLine;
  return {
    sourceLineKey: e.sourceLineKey, dateOfService: e.dateOfService, cptCodes: e.cptCodes, modifier: e.modifier,
    unitsBilled: e.unitsBilled, chargeAmount: e.chargeAmount, insuranceReimbursement: e.insuranceReimbursement,
    patientAmountDue: e.patientAmountDue, patientAmountPaid: e.patientAmountPaid, claimStatus: e.claimStatus,
    oaClaimNumber: e.oaClaimNumber, checkDate: e.checkDate, checkNumberVirtualCard: e.checkNumberVirtualCard,
  };
}

/** The review document the client renders: one group per claim. Its sha256 is display-only. */
function toImportDocument(kind: ClaimCsvKind, fileName: string, csvText: string, claims: CsvClaim[]): ImportDocument {
  return {
    kind,
    sha256: sha256Hex(Buffer.from(csvText, "utf8")),
    fileName,
    pageCount: null,
    extractionMethod: `CSV template (${CLAIM_CSV_TEMPLATES[kind].fileName})`,
    warnings: [],
    groups: claims.map((c): ImportGroup => ({
      groupKey: c.groupKey,
      patientName: c.patientName,
      pages: null,
      claimIdentifier: c.claimId,
      lines: c.lines,
      warnings: c.warnings,
      unresolvedClaimTotals: c.unresolvedClaimTotals,
    })),
  };
}

// ─── Preview ────────────────────────────────────────────────────────────────

const groupKey = z.string().regex(CLAIM_IMPORT_KEY_RE);
const csvFileInput = {
  kind: z.enum(["cms1500", "eob"]),
  fileName: z.string().trim().min(1).max(255),
  csvText: z.string().max(CLAIM_CSV_MAX_BYTES),
};

export const csvImportPreviewInput = z.object({
  ...csvFileInput,
  /** Reviewer's patient choice per claim (groupKey) — only used when the file has no patient_id. */
  patientChoices: z.record(groupKey, z.string().uuid()).optional(),
});

export interface CsvPreviewResult {
  templateError: string | null;
  rowErrors: CsvRowError[];
  blockedClaimIds: string[];
  dataRowCount: number;
  document: ImportDocument | null;
  preview: { documentId: null; groups: PreviewGroup[] } | null;
}

export async function previewClaimCsvImport(input: z.infer<typeof csvImportPreviewInput>): Promise<CsvPreviewResult> {
  const { parsed, roster, claims } = await loadAndCheck(input.kind, input.csvText);
  const base = { templateError: parsed.templateError, rowErrors: parsed.rowErrors, blockedClaimIds: parsed.blockedClaimIds, dataRowCount: parsed.dataRowCount };
  if (parsed.templateError) return { ...base, document: null, preview: null };

  const cmsDocIds = new Map<string, string | null>();
  const groups: PreviewGroup[] = [];
  for (const c of claims) {
    const request = importPreviewInput.parse({
      kind: input.kind,
      document: { sha256: c.sha256, fileName: input.fileName, pageCount: null },
      contextPatientId: null,
      groups: [{
        groupKey: c.groupKey,
        patientName: c.patientName,
        patientId: c.patientId ?? input.patientChoices?.[c.groupKey] ?? null,
        lines: c.lines.map(l => lineInput(input.kind, l)),
      }],
    });
    const r = await previewClaimImport(request, await hintsFor(c, roster, cmsDocIds));
    groups.push(...r.groups);
  }
  return { ...base, document: toImportDocument(input.kind, input.fileName, input.csvText, claims), preview: { documentId: null, groups } };
}

// ─── Commit ─────────────────────────────────────────────────────────────────

const commitGroup = <D extends z.ZodTypeAny>(decision: D) => z.object({
  groupKey,
  patientId: z.string().uuid().nullable().optional(),
  patientConfirmed: z.boolean().optional(),
  lines: z.array(z.object({ sourceLineKey: groupKey, decision })).min(1).max(500),
});

export const csvImportCommitInput = z.discriminatedUnion("kind", [
  z.object({ ...csvFileInput, kind: z.literal("cms1500"), groups: z.array(commitGroup(cms1500Decision)).min(1).max(100) }),
  z.object({ ...csvFileInput, kind: z.literal("eob"), groups: z.array(commitGroup(eobDecision)).min(1).max(100) }),
]);

/** Thrown when the file itself is refused at commit (it changed since preview). Nothing is written. */
export class CsvTemplateError extends Error {}

export async function commitClaimCsvImport(input: z.infer<typeof csvImportCommitInput>, actor: ActorContext): Promise<{ importBatchId: string; groups: CommitGroupResult[] }> {
  const { parsed, roster, claims } = await loadAndCheck(input.kind, input.csvText);
  if (parsed.templateError) throw new CsvTemplateError(parsed.templateError);
  const byKey = new Map(claims.map(c => [c.groupKey, c]));
  const blocked = new Set(parsed.blockedClaimIds.map(id => csvGroupKey(input.kind, id)));
  const importBatchId = randomUUID();
  const cmsDocIds = new Map<string, string | null>();
  const results: CommitGroupResult[] = [];

  for (const g of input.groups) {
    const claim = byKey.get(g.groupKey);
    const notInFile = (sourceLineKey: string, message: string): CommitLineResult => ({ sourceLineKey, status: "review_required", reason: "not_in_file", message });
    if (!claim) {
      const message = blocked.has(g.groupKey)
        ? "This claim has errors in the file. Fix them and upload the file again."
        : "This claim is not in the file any more.";
      results.push({ groupKey: g.groupKey, patientId: null, lines: g.lines.map(l => notInFile(l.sourceLineKey, message)) });
      continue;
    }
    const fileLines = new Map(claim.lines.map(l => [l.sourceLineKey, l]));
    const requested = new Map<string, (typeof g.lines)[number]>();
    for (const l of g.lines) if (!requested.has(l.sourceLineKey)) requested.set(l.sourceLineKey, l);
    const missing = Array.from(requested.keys()).filter(k => !fileLines.has(k));
    const present = Array.from(requested.values()).filter(l => fileLines.has(l.sourceLineKey));

    let committed: CommitLineResult[] = [];
    let patientId: string | null = null;
    if (present.length > 0) {
      const request = importCommitInput.parse({
        kind: input.kind,
        document: { sha256: claim.sha256, fileName: input.fileName, pageCount: null },
        contextPatientId: null,
        contextAuthPeriod: null,
        groups: [{
          groupKey: claim.groupKey,
          patientName: claim.patientName,
          // A patient_id in the file wins over a reviewer choice; confirmation rules still apply.
          patientId: claim.patientId ?? g.patientId ?? null,
          patientConfirmed: g.patientConfirmed,
          allLineKeys: claim.lines.map(l => l.sourceLineKey),
          lines: present.map(l => ({ ...lineInput(input.kind, fileLines.get(l.sourceLineKey)!), decision: l.decision })),
        }],
      });
      const r = await commitClaimImport(request, actor, { ...(await hintsFor(claim, roster, cmsDocIds)), importBatchId });
      committed = r.groups[0].lines;
      patientId = r.groups[0].patientId;
    }
    results.push({
      groupKey: g.groupKey,
      patientId,
      lines: [...committed, ...missing.map(k => notInFile(k, "This line is not in the file any more."))],
    });
  }
  return { importBatchId, groups: results };
}
