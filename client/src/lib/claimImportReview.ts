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
import { CLAIM_IMPORT_STATUSES, type Cms1500ImportLine, type ClaimImportStatus, type EobImportLine, type ImportDocument } from "@shared/claimImport";

type Outputs = inferRouterOutputs<AppRouter>;
type Inputs = inferRouterInputs<AppRouter>;
export type PreviewResult = Outputs["claims"]["importPreview"];
export type PreviewGroup = PreviewResult["groups"][number];
export type PreviewLine = PreviewGroup["lines"][number];
export type CommitResult = Outputs["claims"]["importCommit"];
export type CommitLineResult = CommitResult["groups"][number]["lines"][number];
export type CommitInput = Inputs["claims"]["importCommit"];
export type CsvPreviewResult = Outputs["claims"]["csvImportPreview"];
export type CsvRowError = CsvPreviewResult["rowErrors"][number];
export type CsvCommitInput = Inputs["claims"]["csvImportCommit"];

export type Cms1500Decision = {
  action: "create" | "create_distinct" | "associate" | "skip";
  claimRecordId?: string | null;
  authPeriod?: number | null;
  periodSource?: "resolved" | "selected" | "context" | null;
  acknowledgeFlags?: boolean;
};
export type EobDecision = { action: "apply" | "skip" | "hold"; claimRecordId?: string | null; confirmReplace?: boolean };
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
    // P4-P28: saving keeps this reviewed line pending; nothing is paid until its CMS1500 exists.
    if (line.status === "cms1500_required") return { action: "hold" };
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

export const DONE_STATUSES = new Set(["saved", "unchanged", "skipped", "held"]);

export function isLineDone(result: CommitLineResult | undefined): boolean {
  return !!result && DONE_STATUSES.has(result.status);
}

/** Whether a decision is complete enough to send. A CMS1500 create may omit
 *  the period: the server uses the resolved one, re-applies an already-saved
 *  line without one, and refuses a new line it cannot place. */
export function decisionReady(kind: "cms1500" | "eob", decision: LineDecision | null | undefined, unreadable: string[]): boolean {
  if (!decision) return false;
  if (decision.action === "skip") return true;
  if (kind === "eob") return decision.action === "hold" || !!(decision as EobDecision).claimRecordId;
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

export type PatientCreateRequest = { name: string; distinctConfirmed?: boolean };

export interface FileReviewState {
  doc: ImportDocument;
  patientChoice: Record<string, string | undefined>;
  patientConfirmed: Record<string, boolean | undefined>;
  /** P4-P28: groups whose patient is created on save, by groupKey. */
  patientCreate?: Record<string, PatientCreateRequest | undefined>;
  /** P4-P28: what saving did to each group's patient, for the result counts. */
  patientOutcomes?: Record<string, "created" | "existing" | null | undefined>;
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
      patientIdentity: group.patientIdentity && group.patientIdentity.strength === "account" ? group.patientIdentity : null,
      createPatient: state.patientCreate?.[group.groupKey] ?? null,
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

export function normalizeClaimStatus(s: string | null | undefined): ClaimImportStatus | null {
  const v = (s ?? "").trim().toLowerCase();
  return (CLAIM_IMPORT_STATUSES as readonly string[]).includes(v) ? (v as ClaimImportStatus) : null;
}

/** The preview request for one file (current edits and patient choices applied). */
export function buildPreviewInput(params: {
  state: Pick<FileReviewState, "doc" | "patientChoice" | "edits" | "patientCreate">;
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
      patientIdentity: g.patientIdentity && g.patientIdentity.strength === "account" ? g.patientIdentity : null,
      createPatient: state.patientCreate?.[g.groupKey] ?? null,
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

// ─── P4-P26: claims CSV uploads ──────────────────────────────────────────────
// The CSV text itself goes with every request and the server re-parses it, so
// these send only the reviewer's input: patient choices / confirmations and
// one decision per line key. Line values and keys are never sent.

export interface CsvFileSource {
  kind: "cms1500" | "eob";
  fileName: string;
  csvText: string;
}

export function buildCsvPreviewInput(params: { source: CsvFileSource; state: Pick<FileReviewState, "patientChoice" | "patientCreate" | "edits"> }) {
  const patientChoices: Record<string, string> = {};
  for (const [k, v] of Object.entries(params.state.patientChoice)) if (v) patientChoices[k] = v;
  const patientCreates: Record<string, PatientCreateRequest> = {};
  for (const [k, v] of Object.entries(params.state.patientCreate ?? {})) if (v) patientCreates[k] = v;
  const lineEdits: Record<string, LineEdits> = {};
  for (const [k, v] of Object.entries(params.state.edits ?? {})) if (v) lineEdits[k] = v;
  return { ...params.source, patientChoices, patientCreates, lineEdits: lineEdits as CsvLineEdits };
}

type CsvLineEdits = NonNullable<Inputs["claims"]["csvImportPreview"]["lineEdits"]>;

/**
 * The CSV commit requests for one file, split so no request carries more than
 * `maxLines` lines (a claim is never split across requests). Built from the
 * same pending-line rule as buildCommitInput, so done lines are never resent.
 */
export function buildCsvCommitInputs(params: { source: CsvFileSource; state: FileReviewState; maxLines?: number }): CsvCommitInput[] {
  const { source, state, maxLines = 150 } = params;
  const full = buildCommitInput({ state, contextPatientId: null, contextAuthPeriod: null });
  if (!full) return [];
  const batches: CsvCommitInput[] = [];
  let current: any[] = [];
  let count = 0;
  for (const g of full.groups as any[]) {
    if (current.length > 0 && (count + g.lines.length > maxLines || current.length >= 100)) {
      batches.push({ ...source, groups: current } as CsvCommitInput);
      current = [];
      count = 0;
    }
    current.push({
      groupKey: g.groupKey,
      patientId: g.patientId,
      patientConfirmed: g.patientConfirmed,
      createPatient: g.createPatient,
      lines: g.lines.map((l: any) => ({ sourceLineKey: l.sourceLineKey, decision: l.decision, ...(state.edits[l.sourceLineKey] ? { edits: state.edits[l.sourceLineKey] } : {}) })),
    });
    count += g.lines.length;
  }
  if (current.length > 0) batches.push({ ...source, groups: current } as CsvCommitInput);
  return batches;
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
    /** P4-P28: kept pending until the matching CMS1500 is saved. */
    held: all.filter(r => r?.status === "held").length,
    pending: all.filter(r => !r || !DONE_STATUSES.has(r.status)).length,
  };
}

/** P4-P28: new and existing patients a file's saves touched, counted once per patient. */
export function summarizePatients(state: Pick<FileReviewState, "doc" | "patientOutcomes" | "results">, clusterOf: (groupKey: string) => string | undefined): { created: number; existing: number } {
  const created = new Set<string>();
  const existing = new Set<string>();
  for (const g of state.doc.groups) {
    const outcome = state.patientOutcomes?.[g.groupKey];
    if (!outcome || !g.lines.some(l => isLineDone(state.results[l.sourceLineKey]))) continue;
    (outcome === "created" ? created : existing).add(clusterOf(g.groupKey) ?? g.groupKey);
  }
  // A patient created by one invoice and reused by the next counts as new only.
  for (const k of Array.from(created)) existing.delete(k);
  return { created: created.size, existing: existing.size };
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

// ─── P4-P27: PDF-first bulk uploads ─────────────────────────────────────────

export type FileStage = "queued" | "extracting" | "checking" | "review" | "failed";

/**
 * Per-dialog progress across files: how many were read, are waiting, failed,
 * and — once reviewed — whether every line is saved or some still need review.
 * A file counts as "saved" only when it has lines and every one is done.
 */
export function summarizeFiles(entries: Array<{ stage: FileStage; review?: Pick<FileReviewState, "doc" | "results"> }>) {
  let reading = 0, failed = 0, saved = 0, needsReview = 0;
  for (const e of entries) {
    if (e.stage === "queued" || e.stage === "extracting" || e.stage === "checking") reading++;
    else if (e.stage === "failed") failed++;
    else if (e.review) {
      const s = summarizeResults(e.review);
      if (s.total > 0 && s.pending === 0) saved++;
      else needsReview++;
    }
  }
  return { total: entries.length, read: entries.length - reading, reading, failed, saved, needsReview };
}

/** Identity used to skip the same file being added twice to one dialog. */
export function fileIdentity(f: { name: string; size: number; lastModified: number }): string {
  return `${f.name}\u0000${f.size}\u0000${f.lastModified}`;
}

/** Splits a picked set into PDFs and everything else (by type or extension). */
export function splitPdfFiles<F extends { name: string; type: string }>(files: F[]): { pdfs: F[]; rejected: F[] } {
  const pdfs: F[] = [];
  const rejected: F[] = [];
  for (const f of files) (f.type === "application/pdf" || /\.pdf$/i.test(f.name) ? pdfs : rejected).push(f);
  return { pdfs, rejected };
}
