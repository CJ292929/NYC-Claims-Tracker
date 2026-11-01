/**
 * server/pendingEob.ts — P4-P28
 *
 * Reviewed EOB lines waiting for their CMS1500 line (pending_eob_lines). A
 * line lands here only when a reviewer saved it while no CMS1500 line matched;
 * it has written nothing to any claim row.
 *
 * Listing re-classifies each line against the patient's current claim rows
 * with the same rules a normal EOB save uses (classifyEobLine /
 * classifyEobLineForTarget), so a line turns applicable as soon as its CMS1500
 * is saved. Applying is always a reviewer action, re-validated here and then
 * written by apply_eob_line_with_audit (via
 * apply_pending_eob_line_with_audit), so CMS1500-first and double-payment
 * rules are the same ones every EOB goes through.
 */
import { randomUUID } from "crypto";
import { z } from "zod";
import {
  allowedEobTargets,
  classifyEobLine,
  classifyEobLineForTarget,
  type EobCsvTarget,
  type EobLineClassification,
} from "@shared/claimImport";
import {
  applyPendingEobLine,
  ClaimImportRuleError,
  dismissPendingEobLine,
  findClaimImportDocumentId,
  listPatientClaimLinesOnDates,
  listPendingEobLines,
  PENDING_EOB_LIST_LIMIT,
  type PendingEobRow,
} from "./db";
import type { ActorContext } from "./actorIdentity";

export interface PendingEobItem {
  id: string;
  patientId: string;
  patientName: string;
  fileName: string | null;
  dateOfService: string;
  cptCodes: string;
  modifier: string | null;
  unitsBilled: number | null;
  chargeAmount: number | null;
  insuranceReimbursement: number | null;
  patientAmountDue: number | null;
  patientAmountPaid: number | null;
  claimStatus: string | null;
  createdAt: string;
  classification: EobLineClassification;
}

const numberOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function lineOf(row: PendingEobRow) {
  return {
    sourceLineKey: row.lineKey,
    dateOfService: row.dateOfService,
    cptCodes: row.cptCodes,
    modifier: row.modifier,
    unitsBilled: row.unitsBilled,
    chargeAmount: numberOrNull(row.data.charge_amount),
    insuranceReimbursement: numberOrNull(row.data.insurance_reimbursement),
    patientAmountDue: numberOrNull(row.data.patient_amount_due),
    patientAmountPaid: numberOrNull(row.data.patient_amount_paid),
  };
}

async function classifyRow(row: PendingEobRow, cache: Map<string, string | null>): Promise<EobLineClassification> {
  const existing = await listPatientClaimLinesOnDates(row.patientId, [row.dateOfService]);
  const t = row.target;
  if (!t) return classifyEobLine({ line: lineOf(row), documentId: row.documentId, existing });
  const sha = t.cms1500_sha256 as string | null;
  let documentId: string | null = null;
  if (sha) {
    if (!cache.has(sha)) cache.set(sha, await findClaimImportDocumentId("cms1500", sha));
    documentId = cache.get(sha) ?? null;
  }
  const target: EobCsvTarget = {
    cms1500Ref: sha && t.line_key ? { documentId, lineKey: String(t.line_key), label: String(t.label ?? t.line_key) } : null,
    authPeriod: t.auth_period == null ? null : Number(t.auth_period),
  };
  return classifyEobLineForTarget({ line: lineOf(row), documentId: row.documentId, existing, target });
}

export async function listPendingEob(): Promise<{ items: PendingEobItem[]; truncated: boolean }> {
  const rows = await listPendingEobLines();
  const cache = new Map<string, string | null>();
  const items: PendingEobItem[] = [];
  for (const row of rows) {
    items.push({
      id: row.id,
      patientId: row.patientId,
      patientName: row.patientName,
      fileName: row.fileName,
      dateOfService: row.dateOfService,
      cptCodes: row.cptCodes,
      modifier: row.modifier,
      unitsBilled: row.unitsBilled,
      chargeAmount: numberOrNull(row.data.charge_amount),
      insuranceReimbursement: numberOrNull(row.data.insurance_reimbursement),
      patientAmountDue: numberOrNull(row.data.patient_amount_due),
      patientAmountPaid: numberOrNull(row.data.patient_amount_paid),
      claimStatus: (row.data.claim_status as string | undefined) ?? null,
      createdAt: row.createdAt,
      classification: await classifyRow(row, cache),
    });
  }
  return { items, truncated: rows.length >= PENDING_EOB_LIST_LIMIT };
}

export const pendingEobApplyInput = z.object({
  items: z.array(z.object({
    pendingId: z.string().uuid(),
    claimRecordId: z.string().uuid(),
    confirmReplace: z.boolean().optional(),
  })).min(1).max(100),
});

export interface PendingEobApplyResult {
  pendingId: string;
  status: "saved" | "unchanged" | "review_required" | "failed";
  message?: string;
}

const APPLY_MESSAGES: Record<string, string> = {
  cms1500_required: "The matching CMS1500 line is not saved yet.",
  already_reconciled: "That claim line already has a payment from another EOB line. Confirm replacing it.",
  existing_financials: "That claim line already has different amounts. Confirm replacing them.",
  source_line_already_saved: "This line is already applied to a different claim line.",
  incompatible: "That claim line has a different date of service or CPT.",
  patient_mismatch: "That claim line belongs to a different patient.",
  not_found: "This line or its claim line no longer exists.",
  pending_not_needed: "This line was already resolved.",
};

export async function applyPendingEob(input: z.infer<typeof pendingEobApplyInput>, actor: ActorContext): Promise<{ importBatchId: string; results: PendingEobApplyResult[] }> {
  const importBatchId = randomUUID();
  const rows = new Map((await listPendingEobLines()).map(r => [r.id, r]));
  const cache = new Map<string, string | null>();
  const results: PendingEobApplyResult[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.pendingId)) continue;
    seen.add(item.pendingId);
    const row = rows.get(item.pendingId);
    if (row) {
      const c = await classifyRow(row, cache);
      if (!allowedEobTargets(c).includes(item.claimRecordId)) {
        results.push({ pendingId: item.pendingId, status: "review_required", message: c.reason ?? "This line cannot be applied to that claim line. Re-check and choose again." });
        continue;
      }
    }
    // A line no longer open (double click, stale list) falls through to the
    // RPC, which reports it as unchanged instead of applying it twice.
    try {
      const r = await applyPendingEobLine({ pendingId: item.pendingId, targetClaimId: item.claimRecordId, confirmReplace: item.confirmReplace === true, actor, importBatchId });
      results.push({ pendingId: item.pendingId, status: r.status === "unchanged" ? "unchanged" : "saved" });
    } catch (err) {
      if (err instanceof ClaimImportRuleError) {
        results.push({ pendingId: item.pendingId, status: "review_required", message: APPLY_MESSAGES[err.reason] ?? err.reason });
      } else {
        console.error("[PendingEob] apply failed:", err);
        results.push({ pendingId: item.pendingId, status: "failed", message: "Could not apply this line. Nothing was changed for it — retry." });
      }
    }
  }
  return { importBatchId, results };
}

export const pendingEobDismissInput = z.object({ pendingId: z.string().uuid() });

export async function dismissPendingEob(input: z.infer<typeof pendingEobDismissInput>, actor: ActorContext): Promise<void> {
  await dismissPendingEobLine(input.pendingId, actor);
}
