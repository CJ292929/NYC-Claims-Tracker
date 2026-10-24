/**
 * client/src/lib/claimImportReview.ts — P4-P24
 *
 * Pure state helpers for the CMS1500 / EOB import review dialog
 * (client/src/components/claims/ClaimImportDialog.tsx), kept out of the
 * component so the rules are unit-tested:
 *
 *   - which decision a previewed line starts with (only when the preview
 *     leaves nothing to choose — an ambiguous match, an uncertain period in
 *     bulk mode, or a payment replacement always waits for the reviewer);
 *   - what a Save / Retry click sends: only lines that are not already
 *     saved, unchanged or skipped, each with the source key it was given at
 *     extraction (never re-derived), plus the group's full key list so the
 *     server can tell a retried repeat line from a duplicate;
 *   - bounded concurrency for per-file extraction.
 */
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import type { Cms1500ImportLine, EobImportLine, ImportDocument } from "@shared/claimImport";

type Outputs = inferRouterOutputs<AppRouter>;
type Inputs = inferRouterInputs<AppRouter>;
export type PreviewResult = Outputs["claims"]["importPreview"];
export type PreviewGroup = PreviewResult["groups"][number];
export type PreviewLine = PreviewGroup["lines"][number];
export type CommitResult = Outputs["claims"]["importCommit"];
export type CommitLineResult = CommitResult["groups"][number]["lines"][number];
export type CommitInput = Inputs["claims"]["importCommit"];

export type Cms1500Decision = {
  action: "create" | "create_distinct" | "associate" | "skip";
  claimRecordId?: string | null;
  authPeriod?: number | null;
  periodSource?: "resolved" | "selected" | "context" | null;
  acknowledgeFlags?: boolean;
};
export type EobDecision = { action: "apply" | "skip"; claimRecordId?: string | null; confirmReplace?: boolean };
export type LineDecision = Cms1500Decision | EobDecision;

export type ReviewMode = "single" | "bulk";

/** The decision a line starts with, or null when the reviewer must choose. */
export function initialDecision(params: {
  kind: "cms1500" | "eob";
  line: PreviewLine;
  mode: ReviewMode;
  contextAuthPeriod: number | null;
}): LineDecision | null {
  const { kind, line, mode, contextAuthPeriod } = params;
  if (kind === "eob") {
    if ((line.status === "matched" || line.status === "already_saved") && "targetClaimId" in line && line.targetClaimId) {
      return { action: "apply", claimRecordId: line.targetClaimId };
    }
    return null;
  }
  if (line.status === "already_saved") return { action: "create" };
  if (line.status === "ready_new" && "period" in line && line.period.status === "resolved") {
    return { action: "create", authPeriod: line.period.authPeriod, periodSource: "resolved" };
  }
  if (line.status === "period_required" && "period" in line && line.period.status === "uncertain" && mode === "single"
    && contextAuthPeriod != null && line.period.options.includes(contextAuthPeriod)) {
    // Uploaded from a specific period's section: that is the reviewer's choice for an uncertain date.
    return { action: "create", authPeriod: contextAuthPeriod, periodSource: "context" };
  }
  return null;
}

export const DONE_STATUSES = new Set(["saved", "unchanged", "skipped"]);

export function isLineDone(result: CommitLineResult | undefined): boolean {
  return !!result && DONE_STATUSES.has(result.status);
}

/** Whether a decision is complete enough to send. A CMS1500 create may omit
 *  the period: the server uses the resolved one, re-applies an already-saved
 *  line without one, and refuses a new line it cannot place. */
export function decisionReady(kind: "cms1500" | "eob", decision: LineDecision | null | undefined, unreadable: string[]): boolean {
  if (!decision) return false;
  if (decision.action === "skip") return true;
  if (kind === "eob") return !!(decision as EobDecision).claimRecordId;
  const d = decision as Cms1500Decision;
  if (d.action === "associate" && !d.claimRecordId) return false;
  if (unreadable.length > 0 && !d.acknowledgeFlags) return false;
  return true;
}

export type LineEdits = Partial<Pick<Cms1500ImportLine, "dateOfService" | "cptCodes" | "modifier" | "unitsBilled" | "diagnosisCodes" | "placeOfService">>;

/** A line with the reviewer's edits applied; an edited field is no longer "unreadable". */
export function applyLineEdits<L extends Cms1500ImportLine>(line: L, edits: LineEdits | undefined): L {
  if (!edits || Object.keys(edits).length === 0) return line;
  const unreadable = line.unreadable.filter(f => !(f in edits));
  return { ...line, ...edits, unreadable };
}

export interface FileReviewState {
  doc: ImportDocument;
  patientChoice: Record<string, string | undefined>;
  patientConfirmed: Record<string, boolean | undefined>;
  decisions: Record<string, LineDecision | null | undefined>;
  edits: Record<string, LineEdits | undefined>;
  results: Record<string, CommitLineResult | undefined>;
}

/**
 * The commit request for one file: every group with at least one line that
 * is not done and has a complete decision. Returns null when nothing is
 * ready. Lines already saved / unchanged / skipped are never resent.
 */
export function buildCommitInput(params: {
  state: FileReviewState;
  contextPatientId: string | null;
  contextAuthPeriod: number | null;
}): CommitInput | null {
  const { state, contextPatientId, contextAuthPeriod } = params;
  const kind = state.doc.kind;
  const groups: any[] = [];
  for (const group of state.doc.groups) {
    const pending = (group.lines as Array<Cms1500ImportLine | EobImportLine>).filter(l => {
      if (isLineDone(state.results[l.sourceLineKey])) return false;
      const unreadable = kind === "cms1500" ? applyLineEdits(l as Cms1500ImportLine, state.edits[l.sourceLineKey]).unreadable : [];
      return decisionReady(kind, state.decisions[l.sourceLineKey], unreadable);
    });
    if (pending.length === 0) continue;
    groups.push({
      groupKey: group.groupKey,
      patientName: group.patientName,
      patientId: state.patientChoice[group.groupKey] ?? null,
      patientConfirmed: state.patientConfirmed[group.groupKey] === true,
      allLineKeys: group.lines.map(l => l.sourceLineKey),
      lines: pending.map(l => {
        const decision = state.decisions[l.sourceLineKey]!;
        if (kind === "cms1500") {
          const e = applyLineEdits(l as Cms1500ImportLine, state.edits[l.sourceLineKey]);
          return {
            sourceLineKey: e.sourceLineKey, dateOfService: e.dateOfService, cptCodes: e.cptCodes, modifier: e.modifier,
            unitsBilled: e.unitsBilled, placeOfService: e.placeOfService, diagnosisCodes: e.diagnosisCodes,
            claimSubmittedDate: e.claimSubmittedDate, insuranceBilled: e.insuranceBilled, unreadable: e.unreadable,
            decision,
          };
        }
        const e = l as EobImportLine;
        return {
          sourceLineKey: e.sourceLineKey, dateOfService: e.dateOfService, cptCodes: e.cptCodes, modifier: e.modifier,
          unitsBilled: e.unitsBilled, chargeAmount: e.chargeAmount, insuranceReimbursement: e.insuranceReimbursement,
          patientAmountDue: e.patientAmountDue, patientAmountPaid: e.patientAmountPaid,
          claimStatus: normalizeClaimStatus(e.claimStatus), oaClaimNumber: e.oaClaimNumber, checkDate: e.checkDate,
          checkNumberVirtualCard: e.checkNumberVirtualCard, decision,
        };
      }),
    });
  }
  if (groups.length === 0) return null;
  return {
    kind,
    document: { sha256: state.doc.sha256, fileName: state.doc.fileName, pageCount: state.doc.pageCount },
    contextPatientId,
    contextAuthPeriod,
    groups,
  } as CommitInput;
}

const STATUSES = ["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "needs_review"] as const;
export function normalizeClaimStatus(s: string | null | undefined): (typeof STATUSES)[number] | null {
  const v = (s ?? "").trim().toLowerCase();
  return (STATUSES as readonly string[]).includes(v) ? (v as (typeof STATUSES)[number]) : null;
}

/** The preview request for one file (current edits and patient choices applied). */
export function buildPreviewInput(params: {
  state: Pick<FileReviewState, "doc" | "patientChoice" | "edits">;
  contextPatientId: string | null;
}) {
  const { state, contextPatientId } = params;
  const kind = state.doc.kind;
  return {
    kind,
    document: { sha256: state.doc.sha256, fileName: state.doc.fileName, pageCount: state.doc.pageCount },
    contextPatientId,
    groups: state.doc.groups.map(g => ({
      groupKey: g.groupKey,
      patientName: g.patientName,
      patientId: state.patientChoice[g.groupKey] ?? null,
      lines: (g.lines as Array<Cms1500ImportLine | EobImportLine>).map(l => {
        if (kind === "cms1500") {
          const e = applyLineEdits(l as Cms1500ImportLine, state.edits[l.sourceLineKey]);
          return {
            sourceLineKey: e.sourceLineKey, dateOfService: e.dateOfService, cptCodes: e.cptCodes, modifier: e.modifier,
            unitsBilled: e.unitsBilled, placeOfService: e.placeOfService, diagnosisCodes: e.diagnosisCodes,
            claimSubmittedDate: e.claimSubmittedDate, insuranceBilled: e.insuranceBilled, unreadable: e.unreadable,
          };
        }
        const e = l as EobImportLine;
        return {
          sourceLineKey: e.sourceLineKey, dateOfService: e.dateOfService, cptCodes: e.cptCodes, modifier: e.modifier,
          unitsBilled: e.unitsBilled, chargeAmount: e.chargeAmount, insuranceReimbursement: e.insuranceReimbursement,
          patientAmountDue: e.patientAmountDue, patientAmountPaid: e.patientAmountPaid, claimStatus: normalizeClaimStatus(e.claimStatus),
          oaClaimNumber: e.oaClaimNumber, checkDate: e.checkDate, checkNumberVirtualCard: e.checkNumberVirtualCard,
        };
      }),
    })),
  } as Inputs["claims"]["importPreview"];
}

/** Summary counts for one file after (re)commits. */
export function summarizeResults(state: Pick<FileReviewState, "doc" | "results">) {
  const all = state.doc.groups.flatMap(g => g.lines.map(l => state.results[l.sourceLineKey]));
  return {
    total: all.length,
    saved: all.filter(r => r?.status === "saved").length,
    unchanged: all.filter(r => r?.status === "unchanged").length,
    skipped: all.filter(r => r?.status === "skipped").length,
    review: all.filter(r => r?.status === "review_required").length,
    failed: all.filter(r => r?.status === "failed").length,
    pending: all.filter(r => !r || !DONE_STATUSES.has(r.status)).length,
  };
}

/** Runs `worker` over `items` with at most `limit` in flight. Never rejects; returns settled results in order. */
export async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await worker(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(lanes);
  return results;
}
