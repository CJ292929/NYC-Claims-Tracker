/**
 * server/claimImport.ts — P4-P24
 *
 * Preview and commit for CMS1500 and EOB / Insurance Reimbursement imports,
 * shared by the single-patient upload buttons and the two Claims-access bulk
 * uploads (claims.importPreview / claims.importCommit in routers.ts — both
 * claimsAccessProcedure).
 *
 * Preview never writes. Commit re-derives the patient decision and the
 * authorization period server-side, then writes each line through one
 * audited RPC call (commit_cms1500_line_with_audit /
 * apply_eob_line_with_audit), which re-checks ownership, CMS1500-first,
 * source-line uniqueness and existing money under a per-patient lock. A
 * line the database refuses comes back as review_required with the reason;
 * it never fails the rest of the file.
 */
import { z } from "zod";
import { randomUUID } from "crypto";
import { classifyPatientMatch, fuzzyNameMatch } from "@shared/nameMatch";
import {
  CLAIM_IMPORT_KEY_RE,
  SHA256_RE,
  UPLOAD_CMS1500_FIRST,
  classifyCms1500Line,
  classifyEobLine,
  resolveAuthPeriod,
  type Cms1500LineClassification,
  type EobLineClassification,
  type PeriodResolution,
} from "@shared/claimImport";
import {
  applyEobLine,
  ClaimImportRuleError,
  commitCms1500Line,
  findClaimImportDocumentId,
  getAllPatients,
  listPatientClaimLinesOnDates,
  listPatientVisitPeriodDates,
} from "./db";
import type { ActorContext } from "./actorIdentity";

// ─── Input validation ────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const key = z.string().regex(CLAIM_IMPORT_KEY_RE);
const money = z.number().finite().min(-10_000_000).max(10_000_000).nullable();
const shortText = (max: number) => z.string().trim().max(max).nullable();

const documentInput = z.object({
  sha256: z.string().regex(SHA256_RE),
  fileName: z.string().max(255),
  pageCount: z.number().int().min(1).max(500).nullable(),
});

const lineIdentity = {
  sourceLineKey: key,
  dateOfService: isoDate.nullable(),
  cptCodes: shortText(20),
  modifier: shortText(40),
  unitsBilled: z.number().int().min(1).max(999).nullable(),
};

const cms1500LineInput = z.object({
  ...lineIdentity,
  placeOfService: shortText(10),
  diagnosisCodes: shortText(200),
  claimSubmittedDate: isoDate.nullable(),
  insuranceBilled: shortText(60),
  unreadable: z.array(z.string().max(40)).max(20),
});

const CLAIM_STATUSES = ["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "needs_review"] as const;

const eobLineInput = z.object({
  ...lineIdentity,
  chargeAmount: money,
  insuranceReimbursement: money,
  patientAmountDue: money,
  patientAmountPaid: money,
  claimStatus: z.enum(CLAIM_STATUSES).nullable(),
  oaClaimNumber: shortText(80),
  checkDate: isoDate.nullable(),
  checkNumberVirtualCard: shortText(80),
});

const groupBase = {
  groupKey: key,
  patientName: shortText(200),
  /** Reviewer's patient choice; re-validated against the allowed set. */
  patientId: z.string().uuid().nullable().optional(),
};

const MAX_GROUPS = 100;
const MAX_LINES = 500;

export const importPreviewInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cms1500"),
    document: documentInput,
    contextPatientId: z.string().uuid().nullable().optional(),
    groups: z.array(z.object({ ...groupBase, lines: z.array(cms1500LineInput).max(MAX_LINES) })).min(1).max(MAX_GROUPS),
  }),
  z.object({
    kind: z.literal("eob"),
    document: documentInput,
    contextPatientId: z.string().uuid().nullable().optional(),
    groups: z.array(z.object({ ...groupBase, lines: z.array(eobLineInput).max(MAX_LINES) })).min(1).max(MAX_GROUPS),
  }),
]);

const cms1500Decision = z.object({
  action: z.enum(["create", "create_distinct", "associate", "skip"]),
  claimRecordId: z.string().uuid().nullable().optional(),
  authPeriod: z.number().int().min(1).max(1000).nullable().optional(),
  periodSource: z.enum(["resolved", "selected", "context"]).nullable().optional(),
  acknowledgeFlags: z.boolean().optional(),
});

const eobDecision = z.object({
  action: z.enum(["apply", "skip"]),
  claimRecordId: z.string().uuid().nullable().optional(),
  confirmReplace: z.boolean().optional(),
});

export const importCommitInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cms1500"),
    document: documentInput,
    contextPatientId: z.string().uuid().nullable().optional(),
    contextAuthPeriod: z.number().int().min(1).max(1000).nullable().optional(),
    groups: z.array(z.object({
      ...groupBase,
      patientConfirmed: z.boolean().optional(),
      /** Every line key this group was extracted with (not just the ones being retried). */
      allLineKeys: z.array(key).max(MAX_LINES),
      lines: z.array(cms1500LineInput.extend({ decision: cms1500Decision })).max(MAX_LINES),
    })).min(1).max(MAX_GROUPS),
  }),
  z.object({
    kind: z.literal("eob"),
    document: documentInput,
    contextPatientId: z.string().uuid().nullable().optional(),
    contextAuthPeriod: z.number().int().min(1).max(1000).nullable().optional(),
    groups: z.array(z.object({
      ...groupBase,
      patientConfirmed: z.boolean().optional(),
      allLineKeys: z.array(key).max(MAX_LINES),
      lines: z.array(eobLineInput.extend({ decision: eobDecision })).max(MAX_LINES),
    })).min(1).max(MAX_GROUPS),
  }),
]);

export type ImportPreviewInput = z.infer<typeof importPreviewInput>;
export type ImportCommitInput = z.infer<typeof importCommitInput>;
type Cms1500PreviewGroup = Extract<ImportPreviewInput, { kind: "cms1500" }>["groups"][number];
type EobPreviewGroup = Extract<ImportPreviewInput, { kind: "eob" }>["groups"][number];
type Cms1500CommitGroup = Extract<ImportCommitInput, { kind: "cms1500" }>["groups"][number];
type EobCommitGroup = Extract<ImportCommitInput, { kind: "eob" }>["groups"][number];

// ─── Patient decision ───────────────────────────────────────────────────────

export type GroupPatientStatus = "matched" | "candidates" | "unreadable" | "unmatched" | "other_patient";

export interface GroupPatientResolution {
  status: GroupPatientStatus;
  /** The patient the group will be saved to, or null until a reviewer chooses. */
  patientId: string | null;
  patientName: string | null;
  candidates: Array<{ id: string; name: string }>;
  /** Patient ids a reviewer may choose for this group. */
  allowedIds: string[];
  /** True when the reviewer must explicitly confirm the choice before saving. */
  requiresConfirmation: boolean;
}

/**
 * Who a group belongs to. Never guessed:
 *   - a safe name match resolves on its own;
 *   - a near match (middle name, duplicate record) or an unreadable name
 *     needs an explicit reviewer choice from an allowed set;
 *   - in single-patient mode only the open patient is allowed, and a group
 *     that names someone else is reported, not imported.
 * Patients carry no date of birth or member ID in this app, so matching is
 * by name only (documented limitation).
 */
export function resolveGroupPatient(params: {
  patientName: string | null;
  requestedPatientId: string | null | undefined;
  contextPatient: { id: string; name: string } | null;
  allPatients: Array<{ id: string; name: string }>;
}): GroupPatientResolution {
  const { patientName, requestedPatientId, contextPatient, allPatients } = params;
  const pick = (allowed: string[]) => (requestedPatientId && allowed.includes(requestedPatientId) ? requestedPatientId : null);
  const nameOf = (id: string | null) => (id ? allPatients.find(p => p.id === id)?.name ?? contextPatient?.name ?? null : null);

  if (contextPatient) {
    const allowed = [contextPatient.id];
    if (!patientName) {
      const id = pick(allowed);
      return { status: "unreadable", patientId: id, patientName: nameOf(id), candidates: [contextPatient], allowedIds: allowed, requiresConfirmation: true };
    }
    if (fuzzyNameMatch(patientName, contextPatient.name)) {
      return { status: "matched", patientId: contextPatient.id, patientName: contextPatient.name, candidates: [], allowedIds: allowed, requiresConfirmation: false };
    }
    const { candidates } = classifyPatientMatch(patientName, [contextPatient]);
    if (candidates.length > 0) {
      const id = pick(allowed);
      return { status: "candidates", patientId: id, patientName: nameOf(id), candidates: [contextPatient], allowedIds: allowed, requiresConfirmation: true };
    }
    return { status: "other_patient", patientId: null, patientName: null, candidates: [], allowedIds: [], requiresConfirmation: false };
  }

  if (!patientName) {
    const allowed = allPatients.map(p => p.id);
    const id = pick(allowed);
    return { status: "unreadable", patientId: id, patientName: nameOf(id), candidates: [], allowedIds: allowed, requiresConfirmation: true };
  }
  const { confirmed, candidates } = classifyPatientMatch(patientName, allPatients);
  if (confirmed) {
    return { status: "matched", patientId: confirmed.id, patientName: confirmed.name, candidates: [], allowedIds: [confirmed.id], requiresConfirmation: false };
  }
  if (candidates.length > 0) {
    const allowed = candidates.map(c => c.id);
    const id = pick(allowed);
    return {
      status: "candidates", patientId: id, patientName: nameOf(id),
      candidates: candidates.map(c => ({ id: c.id, name: c.name })), allowedIds: allowed, requiresConfirmation: true,
    };
  }
  return { status: "unmatched", patientId: null, patientName: null, candidates: [], allowedIds: [], requiresConfirmation: false };
}

// ─── Preview ────────────────────────────────────────────────────────────────

export type PreviewLine =
  | ({ sourceLineKey: string; kind: "cms1500" } & Cms1500LineClassification)
  | ({ sourceLineKey: string; kind: "eob" } & EobLineClassification)
  | { sourceLineKey: string; kind: "cms1500" | "eob"; status: "patient_required"; candidates: []; reason: string };

export interface PreviewGroup {
  groupKey: string;
  patient: GroupPatientResolution;
  lines: PreviewLine[];
  /** The patient's known authorization periods (for the period selector). */
  periodOptions: number[];
}

async function loadPatients(contextPatientId: string | null | undefined) {
  const allPatients = (await getAllPatients()).map(p => ({ id: p.id, name: p.name }));
  const contextPatient = contextPatientId ? allPatients.find(p => p.id === contextPatientId) ?? null : null;
  if (contextPatientId && !contextPatient) throw new ClaimImportRuleError("not_found", "The selected patient no longer exists.");
  return { allPatients, contextPatient };
}

export async function previewClaimImport(input: ImportPreviewInput): Promise<{ documentId: string | null; groups: PreviewGroup[] }> {
  const { allPatients, contextPatient } = await loadPatients(input.contextPatientId);
  const documentId = await findClaimImportDocumentId(input.kind, input.document.sha256);

  const groups: PreviewGroup[] = [];
  for (const group of input.groups) {
    const patient = resolveGroupPatient({ patientName: group.patientName, requestedPatientId: group.patientId, contextPatient, allPatients });
    if (!patient.patientId) {
      groups.push({
        groupKey: group.groupKey,
        patient,
        periodOptions: [],
        lines: group.lines.map(l => ({
          sourceLineKey: l.sourceLineKey, kind: input.kind, status: "patient_required" as const, candidates: [] as [],
          reason: patient.status === "other_patient"
            ? "This part of the file names a different patient. Upload it from that patient's page or with the bulk upload."
            : patient.status === "unmatched"
              ? "No dashboard patient matches this name."
              : "Confirm which patient this belongs to.",
        })),
      });
      continue;
    }

    const existing = await listPatientClaimLinesOnDates(patient.patientId, group.lines.map(l => l.dateOfService ?? ""));
    let periodOptions: number[] = [];
    let lines: PreviewLine[];
    if (input.kind === "cms1500") {
      const visits = await listPatientVisitPeriodDates(patient.patientId);
      periodOptions = periodOptionsFor(visits);
      const g = group as Cms1500PreviewGroup;
      const siblings = g.lines.map(l => l.sourceLineKey);
      lines = g.lines.map(l => ({
        sourceLineKey: l.sourceLineKey,
        kind: "cms1500" as const,
        ...classifyCms1500Line({ line: l, documentId, siblingLineKeys: siblings, existing, period: resolveAuthPeriod(visits, l.dateOfService) }),
      }));
    } else {
      lines = (group as EobPreviewGroup).lines.map(l => ({
        sourceLineKey: l.sourceLineKey,
        kind: "eob" as const,
        ...classifyEobLine({ line: l, documentId, existing }),
      }));
    }
    groups.push({ groupKey: group.groupKey, patient, lines, periodOptions });
  }
  return { documentId, groups };
}

function periodOptionsFor(visits: Array<{ authPeriod: number }>): number[] {
  const set = Array.from(new Set(visits.map(v => v.authPeriod))).sort((a, b) => a - b);
  return set.length > 0 ? set : [1];
}

// ─── Commit ────────────────────────────────────────────────────────────────

export type CommitLineStatus = "saved" | "unchanged" | "skipped" | "review_required" | "failed";

export interface CommitLineResult {
  sourceLineKey: string;
  status: CommitLineStatus;
  outcome?: "created" | "associated" | "updated" | "saved";
  claimId?: string;
  authPeriod?: number;
  reason?: string;
  message?: string;
}

export interface CommitGroupResult {
  groupKey: string;
  patientId: string | null;
  lines: CommitLineResult[];
}

const REVIEW_MESSAGES: Record<string, string> = {
  needs_selection: "An existing claim line already sits on this date and CPT. Choose to associate with it or save as a separate line.",
  cms1500_required: UPLOAD_CMS1500_FIRST,
  already_reconciled: "This claim line already has a payment from another EOB line. Confirm replacing it.",
  source_line_already_saved: "This source line is already saved to a different claim line.",
  already_has_cms1500: "That claim line already has a CMS1500 line associated.",
  incompatible: "The chosen claim line has a different date of service or CPT.",
  existing_financials: "The chosen claim line already has different amounts. Confirm replacing them.",
  patient_mismatch: "The chosen claim line belongs to a different patient.",
  not_found: "The chosen claim line no longer exists.",
  invalid_input: "This line is missing required values.",
  period_required: "Choose the authorization period for this date of service.",
};

function reviewResult(sourceLineKey: string, reason: string, message?: string): CommitLineResult {
  return { sourceLineKey, status: "review_required", reason, message: message ?? REVIEW_MESSAGES[reason] ?? reason };
}

async function writeLine(sourceLineKey: string, write: () => Promise<{ status: string; claimId: string; authPeriod: number }>): Promise<CommitLineResult> {
  try {
    const r = await write();
    if (r.status === "unchanged") return { sourceLineKey, status: "unchanged", claimId: r.claimId, authPeriod: r.authPeriod };
    return { sourceLineKey, status: "saved", outcome: r.status as CommitLineResult["outcome"], claimId: r.claimId, authPeriod: r.authPeriod };
  } catch (err) {
    if (err instanceof ClaimImportRuleError) return reviewResult(sourceLineKey, err.reason);
    console.error("[ClaimImport] line write failed:", err);
    return { sourceLineKey, status: "failed", reason: "error", message: "Could not save this line. Nothing was changed for it — retry." };
  }
}

/** Which period a new CMS1500 line goes to, or why it can't be decided. */
export function decideAuthPeriod(params: {
  resolution: PeriodResolution;
  allowedPeriods: number[];
  requested: number | null | undefined;
  source: "resolved" | "selected" | "context" | null | undefined;
}): { ok: true; authPeriod: number } | { ok: false; reason: "period_required" | "period_mismatch" } {
  const { resolution, allowedPeriods, requested, source } = params;
  if (resolution.status === "resolved") {
    if (requested == null || requested === resolution.authPeriod) return { ok: true, authPeriod: resolution.authPeriod };
    if (source === "selected" && allowedPeriods.includes(requested)) return { ok: true, authPeriod: requested };
    return { ok: false, reason: "period_mismatch" };
  }
  if (requested != null && (source === "selected" || source === "context") && allowedPeriods.includes(requested)) {
    return { ok: true, authPeriod: requested };
  }
  return { ok: false, reason: "period_required" };
}

export async function commitClaimImport(input: ImportCommitInput, actor: ActorContext): Promise<{ importBatchId: string; groups: CommitGroupResult[] }> {
  const { allPatients, contextPatient } = await loadPatients(input.contextPatientId);
  // One id for this save click: every audit row it writes is linked by it,
  // and every row carries the source document id in its provenance columns.
  const importBatchId = randomUUID();
  const source = { sha256: input.document.sha256, fileName: input.document.fileName, pageCount: input.document.pageCount };
  const results: CommitGroupResult[] = [];

  for (const group of input.groups) {
    const patient = resolveGroupPatient({ patientName: group.patientName, requestedPatientId: group.patientId, contextPatient, allPatients });
    const confirmed = patient.patientId && (!patient.requiresConfirmation || group.patientConfirmed === true);
    if (!confirmed) {
      results.push({
        groupKey: group.groupKey,
        patientId: null,
        lines: group.lines.map(l => reviewResult(l.sourceLineKey, "patient_unconfirmed",
          patient.status === "other_patient" ? "This part of the file names a different patient." : "Confirm which patient this belongs to before saving.")),
      });
      continue;
    }
    const patientId = patient.patientId!;
    const lineResults: CommitLineResult[] = [];

    if (input.kind === "cms1500") {
      const visits = await listPatientVisitPeriodDates(patientId);
      const allowedPeriods = periodOptionsFor(visits);
      const g = group as Cms1500CommitGroup;
      const siblings = Array.from(new Set([...g.allLineKeys, ...g.lines.map(l => l.sourceLineKey)]));
      for (const line of g.lines) {
        const d = line.decision;
        if (d.action === "skip") { lineResults.push({ sourceLineKey: line.sourceLineKey, status: "skipped" }); continue; }
        if (!line.dateOfService || !line.cptCodes) { lineResults.push(reviewResult(line.sourceLineKey, "invalid_input")); continue; }
        if (line.unreadable.length > 0 && !d.acknowledgeFlags) {
          lineResults.push(reviewResult(line.sourceLineKey, "flags_unacknowledged", "This line has unreadable values left blank. Review and acknowledge them before saving."));
          continue;
        }
        if (d.action === "associate" && !d.claimRecordId) { lineResults.push(reviewResult(line.sourceLineKey, "needs_selection")); continue; }

        // Period for a NEW line only. With none decidable, null goes to the
        // RPC: re-applying an already-saved source line needs no period, and
        // a new insert without one is refused there (period_required).
        let authPeriod: number | null = null;
        if (d.action !== "associate") {
          const requested = d.authPeriod ?? (d.periodSource === "context" ? input.contextAuthPeriod ?? null : null);
          const resolution = resolveAuthPeriod(visits, line.dateOfService);
          if (requested == null) {
            authPeriod = resolution.status === "resolved" ? resolution.authPeriod : null;
          } else {
            const decided = decideAuthPeriod({ resolution, allowedPeriods, requested, source: d.periodSource });
            if (!decided.ok) {
              lineResults.push(reviewResult(line.sourceLineKey, decided.reason, decided.reason === "period_required"
                ? REVIEW_MESSAGES.period_required
                : "The chosen period does not match the period this date of service belongs to. Select it explicitly to override."));
              continue;
            }
            authPeriod = decided.authPeriod;
          }
        }

        lineResults.push(await writeLine(line.sourceLineKey, () => commitCms1500Line({
          patientId,
          authPeriod,
          source,
          lineKey: line.sourceLineKey,
          siblingLineKeys: siblings,
          targetClaimId: d.action === "associate" ? d.claimRecordId! : null,
          allowNewDistinct: d.action === "create_distinct",
          data: {
            date_of_service: line.dateOfService,
            cpt_codes: line.cptCodes,
            place_of_service: line.placeOfService,
            modifier: line.modifier,
            units_billed: line.unitsBilled,
            diagnosis_codes: line.diagnosisCodes,
            claim_submitted_date: line.claimSubmittedDate,
            insurance_billed: line.insuranceBilled,
          },
          actor,
          importBatchId,
        })));
      }
    } else {
      for (const line of (group as EobCommitGroup).lines) {
        const d = line.decision;
        if (d.action === "skip") { lineResults.push({ sourceLineKey: line.sourceLineKey, status: "skipped" }); continue; }
        if (!line.dateOfService || !line.cptCodes) { lineResults.push(reviewResult(line.sourceLineKey, "invalid_input")); continue; }
        if (!d.claimRecordId) { lineResults.push(reviewResult(line.sourceLineKey, "cms1500_required")); continue; }
        lineResults.push(await writeLine(line.sourceLineKey, () => applyEobLine({
          patientId,
          source,
          lineKey: line.sourceLineKey,
          targetClaimId: d.claimRecordId!,
          match: { date_of_service: line.dateOfService!, cpt_codes: line.cptCodes! },
          confirmReplace: d.confirmReplace === true,
          data: {
            charge_amount: line.chargeAmount,
            insurance_reimbursement: line.insuranceReimbursement,
            payment_received: line.insuranceReimbursement,
            patient_amount_due: line.patientAmountDue,
            patient_amount_paid: line.patientAmountPaid,
            claim_status: line.claimStatus,
            oa_claim_number: line.oaClaimNumber,
            check_date: line.checkDate,
            check_number_virtual_card: line.checkNumberVirtualCard,
          },
          actor,
          importBatchId,
        })));
      }
    }
    results.push({ groupKey: group.groupKey, patientId, lines: lineResults });
  }
  return { importBatchId, groups: results };
}
