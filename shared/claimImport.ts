/**
 * shared/claimImport.ts — P4-P24
 *
 * Pure types and decision rules for the CMS1500-first claim import workflow,
 * shared by the server (preview + commit re-validation) and the client
 * (review UI), so what a reviewer sees can never drift from what is saved.
 *
 * Field ownership
 *   CMS1500 owns the clinical service line: date of service, place of
 *   service, CPT, modifiers, units, line-specific diagnosis codes (Box 24E
 *   pointer resolved against Box 21), Box 31 date, Box 11 group number.
 *   It never writes a money column — Box 24F charge is read only to check
 *   the lines against Box 28, and every amount stays NULL ("unknown").
 *   The EOB owns billed / paid / patient responsibility / patient paid /
 *   claim status / claim #, check date and check/EFT #. It never writes a
 *   clinical field and can only land on a line that already has CMS1500
 *   provenance. Patient responsibility is stored as reported; it is never
 *   derived from billed minus paid, and never copied into patient paid.
 *
 * Line identity
 *   A source line is identified by (document SHA-256, sourceLineKey). Keys
 *   are assigned once, server-side, when the file is extracted (see
 *   server/claimImportKeys.ts) and are sent back unchanged on every commit
 *   and retry. They are never recomputed from a smaller retried subset.
 *   Across documents there is no positional identity: a CMS1500 line that
 *   lands on a date + CPT where another row already exists, or an EOB line
 *   with more than one compatible CMS1500 line, needs an explicit choice.
 *
 * The database enforces the same rules (commit_cms1500_line_with_audit /
 * apply_eob_line_with_audit); these functions decide what to show and
 * what to send, the RPCs decide what is allowed.
 */

export type ClaimImportKind = "cms1500" | "eob";

export const CLAIM_IMPORT_KEY_RE = /^[A-Za-z0-9:_.,-]{1,160}$/;

/** claim_status values an import may write (claims_records CHECK + import RPCs). */
export const CLAIM_IMPORT_STATUSES = ["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "needs_review"] as const;
export type ClaimImportStatus = (typeof CLAIM_IMPORT_STATUSES)[number];
export const SHA256_RE = /^[0-9a-f]{64}$/;

/** One CMS1500 Box 24 service line, as extracted. */
export interface Cms1500ImportLine {
  sourceLineKey: string;
  page: number | null;
  /** Printed Box 24 row (1-6) on that page. Source position only — never a visit number. */
  slot: number | null;
  dateOfService: string | null; // YYYY-MM-DD
  placeOfService: string | null;
  cptCodes: string | null;
  modifier: string | null; // "59, GP"
  unitsBilled: number | null;
  diagnosisPointer: string | null; // as printed, e.g. "ABCD"
  diagnosisCodes: string | null; // pointer-resolved, in pointer order
  claimSubmittedDate: string | null;
  insuranceBilled: string | null;
  /** P4-P26: only from a CMS1500 CSV row that states it. Never derived; absent for PDFs. */
  visitNumber?: number | null;
  /** Box 24F — used for the Box 28 total check only, never persisted. */
  lineChargeForValidation: number | null;
  /** Fields the extractor could not read. Their values are null, never guessed. */
  unreadable: string[];
  notes: string | null;
  /** P4-P26: spreadsheet row in the uploaded CSV. Display only — never part of the line's identity. */
  sourceRow?: number | null;
}

/** One EOB / remittance service line, as extracted. */
export interface EobImportLine {
  sourceLineKey: string;
  page: number | null;
  dateOfService: string | null;
  cptCodes: string | null;
  modifier: string | null;
  unitsBilled: number | null;
  chargeAmount: number | null; // billed
  insuranceReimbursement: number | null; // paid by plan
  patientAmountDue: number | null; // patient responsibility, as reported
  patientAmountPaid: number | null; // only when the EOB explicitly prints it
  claimStatus: string | null;
  oaClaimNumber: string | null;
  checkDate: string | null;
  checkNumberVirtualCard: string | null;
  notes: string | null;
  /** P4-P26: spreadsheet row in the uploaded CSV. Display only. */
  sourceRow?: number | null;
}

export type ImportLine = Cms1500ImportLine | EobImportLine;

/** A payer amount reported once for several lines. Never written to any line. */
export interface UnresolvedClaimTotal {
  dateOfService: string | null;
  cptCodes: string | null;
  /** Null when only a patient-responsibility total was reported (CSV claim_total_* columns). */
  planPaid: number | null;
  patientResponsibility: number | null;
  cptCount: number;
}

export interface ImportGroup<L extends ImportLine = ImportLine> {
  /** Stable per-document group id (no patient identifiers in it). */
  groupKey: string;
  patientName: string | null;
  /** Pages this group was read from, when the extractor reports pages. */
  pages: number[] | null;
  /** Patient account # / claim # printed on the document, when present. */
  claimIdentifier: string | null;
  lines: L[];
  warnings: string[];
  unresolvedClaimTotals: UnresolvedClaimTotal[];
}

export interface ImportDocument<L extends ImportLine = ImportLine> {
  kind: ClaimImportKind;
  sha256: string;
  fileName: string;
  pageCount: number | null;
  extractionMethod: string;
  groups: ImportGroup<L>[];
  warnings: string[];
}

// ─── Authorization period ────────────────────────────────────────────────────

export type PeriodResolution =
  | { status: "resolved"; authPeriod: number; basis: "visit_date" | "period_range" | "single_period" | "file" }
  | { status: "uncertain"; options: number[]; note?: string };

/**
 * Which authorization period a date of service belongs to, from the
 * patient's own visit records. Never "the latest period": a date that
 * matches a recorded visit, or falls inside exactly one period's recorded
 * date range, resolves; anything else is uncertain and needs a choice.
 */
export function resolveAuthPeriod(
  visits: Array<{ authPeriod: number; dateOfService: string | null }>,
  dateOfService: string | null
): PeriodResolution {
  const periods = Array.from(new Set(visits.map(v => v.authPeriod))).sort((a, b) => a - b);
  const options = periods.length > 0 ? periods : [1];
  if (!dateOfService) return { status: "uncertain", options };

  const exact = Array.from(new Set(visits.filter(v => v.dateOfService === dateOfService).map(v => v.authPeriod)));
  if (exact.length === 1) return { status: "resolved", authPeriod: exact[0], basis: "visit_date" };
  if (exact.length > 1) return { status: "uncertain", options: exact.sort((a, b) => a - b) };

  const inRange = periods.filter(p => {
    const dates = visits.filter(v => v.authPeriod === p && v.dateOfService).map(v => v.dateOfService!).sort();
    return dates.length > 0 && dates[0] <= dateOfService && dateOfService <= dates[dates.length - 1];
  });
  if (inRange.length === 1) return { status: "resolved", authPeriod: inRange[0], basis: "period_range" };
  if (inRange.length > 1) return { status: "uncertain", options: inRange };

  const anyDated = visits.some(v => v.dateOfService);
  if (periods.length === 1 && !anyDated) return { status: "resolved", authPeriod: periods[0], basis: "single_period" };
  return { status: "uncertain", options };
}

/**
 * P4-P26: the period for a CMS1500 CSV row that states one. The file's
 * period is used when it is one of the patient's periods and the visit
 * dates either agree or cannot decide; a file period that contradicts the
 * visit dates, or is not one of the patient's periods, needs a choice.
 */
export function resolveAuthPeriodWithFilePeriod(
  visits: Array<{ authPeriod: number; dateOfService: string | null }>,
  dateOfService: string | null,
  filePeriod: number
): PeriodResolution {
  const base = resolveAuthPeriod(visits, dateOfService);
  const known = Array.from(new Set(visits.map(v => v.authPeriod))).sort((a, b) => a - b);
  const allowed = known.length > 0 ? known : [1];
  if (!allowed.includes(filePeriod)) {
    return {
      status: "uncertain",
      options: base.status === "uncertain" ? base.options : allowed,
      note: `The file says period ${filePeriod}, which is not one of this patient's authorization periods (${allowed.join(", ")}). Choose the period.`,
    };
  }
  if (base.status === "resolved") {
    if (base.authPeriod === filePeriod) return base;
    return {
      status: "uncertain",
      options: [base.authPeriod, filePeriod].sort((a, b) => a - b),
      note: `The file says period ${filePeriod}, but the visit dates place this date of service in period ${base.authPeriod}. Choose the period.`,
    };
  }
  if (base.options.includes(filePeriod)) return { status: "resolved", authPeriod: filePeriod, basis: "file" };
  return {
    status: "uncertain",
    options: Array.from(new Set([...base.options, filePeriod])).sort((a, b) => a - b),
    note: `The file says period ${filePeriod}, but the visit dates point to period ${base.options.join(" or ")}. Choose the period.`,
  };
}

// ─── Existing rows a source line could correspond to ─────────────────────────

export interface ExistingClaimLine {
  id: string;
  authPeriod: number;
  dateOfService: string | null;
  cptCodes: string | null;
  modifier: string | null;
  unitsBilled: number | null;
  diagnosisCodes: string | null;
  chargeAmount: number | null;
  insuranceReimbursement: number | null;
  patientAmountDue: number | null;
  patientAmountPaid: number | null;
  claimStatus: string | null;
  cms1500DocumentId: string | null;
  cms1500LineKey: string | null;
  eobDocumentId: string | null;
  eobLineKey: string | null;
}

export function normalizeModifierSet(modifier: string | null | undefined): string {
  if (!modifier) return "";
  return Array.from(new Set(modifier.toUpperCase().split(/[\s,;/|]+/).filter(Boolean))).sort().join(",");
}

export function formatModifiers(modifiers: Array<string | null | undefined>): string | null {
  const list: string[] = [];
  for (const m of modifiers) {
    const v = (m ?? "").trim().toUpperCase();
    if (v && !list.includes(v)) list.push(v);
  }
  return list.length > 0 ? list.join(", ") : null;
}

function sameDateCpt(row: ExistingClaimLine, dos: string, cpt: string): boolean {
  return row.dateOfService === dos && (row.cptCodes ?? "").trim() === cpt;
}

// ─── CMS1500 line classification ─────────────────────────────────────────────

export type Cms1500LineStatus = "ready_new" | "already_saved" | "needs_selection" | "period_required" | "invalid";

export interface Cms1500LineClassification {
  status: Cms1500LineStatus;
  /** Row this source line was already saved to (status already_saved). */
  existingClaimId?: string;
  /** Rows the reviewer must choose between (status needs_selection). */
  candidates: ExistingClaimLine[];
  /** Candidates that may be associated (no CMS1500 provenance yet). */
  associableIds: string[];
  period: PeriodResolution;
  reason?: string;
}

export function classifyCms1500Line(params: {
  line: Pick<Cms1500ImportLine, "sourceLineKey" | "dateOfService" | "cptCodes" | "unreadable">;
  documentId: string | null;
  siblingLineKeys: string[];
  existing: ExistingClaimLine[];
  period: PeriodResolution;
}): Cms1500LineClassification {
  const { line, documentId, siblingLineKeys, existing, period } = params;
  const dos = line.dateOfService;
  const cpt = (line.cptCodes ?? "").trim();
  if (!dos || !cpt || line.unreadable.includes("dateOfService") || line.unreadable.includes("cptCodes")) {
    return { status: "invalid", candidates: [], associableIds: [], period, reason: "Date of service and CPT must both be readable." };
  }

  const saved = documentId
    ? existing.find(r => r.cms1500DocumentId === documentId && r.cms1500LineKey === line.sourceLineKey)
    : undefined;
  if (saved) return { status: "already_saved", existingClaimId: saved.id, candidates: [], associableIds: [], period };

  const siblings = new Set(siblingLineKeys);
  const conflicting = existing.filter(r =>
    sameDateCpt(r, dos, cpt) &&
    !(documentId && r.cms1500DocumentId === documentId && r.cms1500LineKey && siblings.has(r.cms1500LineKey))
  );
  if (conflicting.length > 0) {
    return {
      status: "needs_selection",
      candidates: conflicting,
      associableIds: conflicting.filter(r => !r.cms1500DocumentId).map(r => r.id),
      period,
      reason: conflicting.some(r => !r.cms1500DocumentId)
        ? "An existing claim line (saved before CMS1500 tracking, or entered manually) is on this date and CPT. Associate this CMS1500 line with it, or save it as a separate line."
        : "Another CMS1500 line is already saved on this date and CPT. Save this one only if it is a separate service line.",
    };
  }
  if (period.status === "uncertain") {
    return { status: "period_required", candidates: [], associableIds: [], period, reason: period.note ?? "Choose the authorization period for this date of service." };
  }
  return { status: "ready_new", candidates: [], associableIds: [], period };
}

// ─── EOB line classification ────────────────────────────────────────────────

export type EobLineStatus = "matched" | "already_saved" | "needs_selection" | "needs_confirmation" | "cms1500_required" | "invalid";

export interface EobLineClassification {
  status: EobLineStatus;
  /** The single target row (matched / already_saved / needs_confirmation). */
  targetClaimId?: string;
  candidates: ExistingClaimLine[];
  reason?: string;
}

export const UPLOAD_CMS1500_FIRST = "Upload the matching CMS1500 first.";

const MONEY_KEYS = ["chargeAmount", "insuranceReimbursement", "patientAmountDue", "patientAmountPaid"] as const;

/** Money fields the EOB reports that differ from a non-null value already on the row. */
export function conflictingMoneyFields(row: ExistingClaimLine, line: Pick<EobImportLine, (typeof MONEY_KEYS)[number]>): string[] {
  return MONEY_KEYS.filter(k => {
    const have = row[k];
    const incoming = line[k];
    return have != null && incoming != null && Math.abs(Number(have) - Number(incoming)) > 0.004;
  });
}

export function classifyEobLine(params: {
  line: Pick<EobImportLine, "sourceLineKey" | "dateOfService" | "cptCodes" | "modifier" | "unitsBilled" | (typeof MONEY_KEYS)[number]>;
  documentId: string | null;
  existing: ExistingClaimLine[];
}): EobLineClassification {
  const { line, documentId, existing } = params;
  const dos = line.dateOfService;
  const cpt = (line.cptCodes ?? "").trim();
  if (!dos || !cpt) return { status: "invalid", candidates: [], reason: "Date of service and CPT must both be readable." };

  const saved = documentId
    ? existing.find(r => r.eobDocumentId === documentId && r.eobLineKey === line.sourceLineKey)
    : undefined;
  if (saved) return { status: "already_saved", targetClaimId: saved.id, candidates: [] };

  const sameKey = existing.filter(r => sameDateCpt(r, dos, cpt));
  const cmsBacked = sameKey.filter(r => r.cms1500DocumentId);
  if (cmsBacked.length === 0) {
    return {
      status: "cms1500_required",
      candidates: [],
      reason: sameKey.length > 0
        ? `${UPLOAD_CMS1500_FIRST} A claim line exists on this date and CPT but has no CMS1500 yet — upload its CMS1500 and associate it before applying this payment.`
        : UPLOAD_CMS1500_FIRST,
    };
  }

  // Modifiers and units narrow the choice only when both sides print them.
  const lineMods = normalizeModifierSet(line.modifier);
  const narrowed = cmsBacked.filter(r => {
    const rowMods = normalizeModifierSet(r.modifier);
    if (lineMods && rowMods && lineMods !== rowMods) return false;
    if (line.unitsBilled != null && r.unitsBilled != null && Number(line.unitsBilled) !== Number(r.unitsBilled)) return false;
    return true;
  });
  const pool = narrowed.length > 0 ? narrowed : cmsBacked;

  if (pool.length > 1) {
    return {
      status: "needs_selection",
      candidates: pool,
      reason: narrowed.length > 0
        ? "More than one CMS1500 line matches this date and CPT. Choose the line this payment belongs to."
        : "Modifiers or units differ from every CMS1500 line on this date and CPT. Choose the line this payment belongs to.",
    };
  }

  const target = pool[0];
  if (narrowed.length === 0) {
    return { status: "needs_selection", targetClaimId: target.id, candidates: pool, reason: "Modifiers or units differ from the CMS1500 line on this date and CPT. Confirm this is the right line." };
  }
  if (target.eobDocumentId) {
    return { status: "needs_confirmation", targetClaimId: target.id, candidates: [target], reason: "This line already has a payment from another EOB line. Applying replaces it." };
  }
  const conflicts = conflictingMoneyFields(target, line);
  if (conflicts.length > 0) {
    return { status: "needs_confirmation", targetClaimId: target.id, candidates: [target], reason: `This line already has different amounts (${conflicts.join(", ")}). Applying replaces them.` };
  }
  return { status: "matched", targetClaimId: target.id, candidates: [target] };
}

/**
 * P4-P26: what an Insurance Reimbursement CSV row may be applied to.
 * cms1500Ref (both CMS1500 CSV ids filled) pins the row to exactly that
 * CMS1500 line; authPeriod limits candidates to one period. Without either
 * this is classifyEobLine. The same function decides the preview and
 * re-validates the reviewer's chosen target on commit.
 */
export interface EobCsvTarget {
  cms1500Ref?: { documentId: string | null; lineKey: string; label: string } | null;
  authPeriod?: number | null;
}

export function classifyEobLineForTarget(params: Parameters<typeof classifyEobLine>[0] & { target: EobCsvTarget }): EobLineClassification {
  const { line, documentId, existing, target } = params;
  const dos = line.dateOfService;
  const cpt = (line.cptCodes ?? "").trim();
  if (!dos || !cpt) return { status: "invalid", candidates: [], reason: "Date of service and CPT must both be readable." };
  const saved = documentId ? existing.find(r => r.eobDocumentId === documentId && r.eobLineKey === line.sourceLineKey) : undefined;
  if (saved) return { status: "already_saved", targetClaimId: saved.id, candidates: [] };

  const period = target.authPeriod ?? null;
  let pool = period != null ? existing.filter(r => r.authPeriod === period) : existing;
  const ref = target.cms1500Ref;
  if (ref) {
    const row = ref.documentId ? existing.find(r => r.cms1500DocumentId === ref.documentId && r.cms1500LineKey === ref.lineKey) : undefined;
    if (!row) {
      return { status: "cms1500_required", candidates: [], reason: `${UPLOAD_CMS1500_FIRST} CMS1500 line ${ref.label} is not saved for this patient on this date of service.` };
    }
    if ((row.cptCodes ?? "").trim() !== cpt) {
      return { status: "invalid", candidates: [], reason: `CMS1500 line ${ref.label} is CPT ${row.cptCodes ?? "—"}, not ${cpt}. Fix the CMS1500 reference in the file.` };
    }
    if (period != null && row.authPeriod !== period) {
      return { status: "invalid", candidates: [], reason: `CMS1500 line ${ref.label} is in period ${row.authPeriod}, not period ${period}. Fix auth_period in the file.` };
    }
    pool = [row];
  }
  const result = classifyEobLine({ line, documentId, existing: pool });
  if (result.status === "cms1500_required" && period != null && pool.length !== existing.length) {
    return { ...result, reason: `${result.reason} (No CMS1500 line on this date and CPT in period ${period}.)` };
  }
  return result;
}

/** Claim rows a reviewer may apply this line to — the commit-side check for a CSV row. */
export function allowedEobTargets(c: EobLineClassification): string[] {
  if (c.status === "invalid" || c.status === "cms1500_required") return [];
  return Array.from(new Set([...(c.targetClaimId ? [c.targetClaimId] : []), ...c.candidates.map(x => x.id)]));
}

// ─── Totals that must not turn "unknown" into $0.00 ─────────────────────────

/** Sum of the known values; total is null when every value is unknown. */
export function sumKnownMoney(values: Array<number | string | null | undefined>): { total: number | null; unknownCount: number } {
  let total: number | null = null;
  let unknownCount = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === "") {
      unknownCount++;
      continue;
    }
    const n = typeof v === "number" ? v : parseFloat(v);
    if (Number.isNaN(n)) {
      unknownCount++;
      continue;
    }
    total = (total ?? 0) + n;
  }
  return { total, unknownCount };
}
