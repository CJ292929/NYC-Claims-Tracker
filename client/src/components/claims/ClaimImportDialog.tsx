/**
 * client/src/components/claims/ClaimImportDialog.tsx — P4-P24
 *
 * The one review screen for CMS1500 and EOB / Insurance Reimbursement
 * uploads, used by both entry points:
 *   - single-patient: the "CMS1500 Upload" / "Insurance Reimbursement
 *     Upload" buttons on a patient's authorization period (contextPatient +
 *     contextAuthPeriod set; only that patient can be written);
 *   - bulk: "Bulk CMS1500 Upload" / "Bulk Insurance Reimbursement Upload"
 *     (Claims-access roles only), many files, many patients per file.
 *   - P4-P26 csv: Bulk Upload → CMS1500 / Insurance Reimbursement CSV
 *     templates (source="csv"). Same review and save rules; the CSV text is
 *     re-parsed by the server on every preview and save
 *     (server/claimCsvImport.ts), one review group per claim in the file.
 *   - P4-P27: Bulk Upload → CMS1500 → "Upload CMS1500 PDFs" and Insurance
 *     Reimbursement → "Upload EOB PDFs" open this dialog in bulk document
 *     mode with the picked PDFs (the primary path; CSV is the alternative).
 *   - P4-P28: each group is marked Existing patient / New patient / Needs
 *     confirmation. A new patient is created by Save, in one transaction with
 *     that group's lines. A choice made for one person applies to every group
 *     of that person in the file. An EOB line with no CMS1500 yet is kept
 *     pending by Save (PendingEobPanel lists them), never paid.
 *
 * Every file is extracted (at most 2 at a time), previewed, reviewed, and
 * saved on its own: one failed file never clears another's preview, and a
 * Save / Retry only sends lines that are not already saved. Nothing is
 * written before an explicit Save. Rules live in shared/claimImport.ts
 * (server and client) and client/src/lib/claimImportReview.ts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileUp, Loader2, RefreshCw, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { createRequestGuard, createSingleFlightGuard, type RequestGuard, type SingleFlightGuard } from "@/lib/concurrencyGuards";
import {
  applyLineEdits,
  buildCommitInput,
  buildCsvCommitInputs,
  buildCsvPreviewInput,
  buildPreviewInput,
  fileIdentity,
  initialDecision,
  isLineDone,
  runWithConcurrency,
  summarizeFiles,
  summarizePatients,
  summarizeResults,
  type Cms1500Decision,
  type CommitResult,
  type CsvRowError,
  type EobDecision,
  type FileReviewState,
  type FileStage,
  type LineDecision,
  type LineEdits,
  type PatientCreateRequest,
  type PreviewGroup,
  type PreviewLine,
  type PreviewResult,
  type ReviewMode,
} from "@/lib/claimImportReview";
import { CLAIM_UPLOAD_MAX_BYTES, CLAIM_UPLOAD_MAX_LABEL, type Cms1500ImportLine, type EobImportLine, type ExistingClaimLine, type ImportDocument } from "@shared/claimImport";
import { formatCalendarDate } from "@/lib/date";
import { CLAIM_CSV_MAX_BYTES, CLAIM_CSV_TEMPLATES } from "@shared/claimCsvTemplates";
import { downloadClaimCsvTemplate } from "./ClaimCsvTemplatePanel";

type Kind = "cms1500" | "eob";

type Stage = FileStage;

interface FileEntry {
  id: string;
  file: File;
  stage: Stage;
  error?: string;
  review?: FileReviewState;
  preview?: PreviewResult;
  saving?: boolean;
  checking?: boolean;
  /** Set together with a state change that needs a fresh preview; consumed by an effect. */
  recheck?: boolean;
  /** P4-P26 (source="csv"): the file text, re-sent on every preview/save, and its row errors. */
  csvText?: string;
  rowErrors?: CsvRowError[];
}

export interface ClaimImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: Kind;
  mode: ReviewMode;
  contextPatient?: { id: string; name: string } | null;
  contextAuthPeriod?: number | null;
  /** Files to start with (the single-patient buttons pass the picked file). */
  initialFiles?: File[];
  onSaved?: () => void;
  /** P4-P26: "csv" = the CMS1500 / Insurance Reimbursement CSV templates (always bulk). */
  source?: "document" | "csv";
}

const MAX_PARALLEL_EXTRACTIONS = 2;
/** Above the deployed function's 90 s limit, so the server's own timeout answer arrives first. */
const EXTRACT_TIMEOUT_MS = 110_000;
/** Lines per CSV save request — keeps each request well inside the server time limit. */
const CSV_LINES_PER_REQUEST = 150;

const money = (n: number | null | undefined) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);
const dateText = (d: string | null | undefined) => (d ? formatCalendarDate(d) : "—");

const STAGE_LABEL: Record<Stage, string> = {
  queued: "Waiting",
  extracting: "Reading file…",
  checking: "Checking against saved claims…",
  review: "Ready for review",
  failed: "Failed",
};

const LINE_STATUS_LABEL: Record<string, string> = {
  ready_new: "New line",
  already_saved: "Saved earlier",
  needs_selection: "Choose",
  period_required: "Choose period",
  identity_review: "Needs review",
  invalid: "Not readable",
  matched: "Matched",
  needs_confirmation: "Confirm",
  cms1500_required: "Pending CMS1500",
  patient_required: "Patient needed",
};

const RESULT_LABEL: Record<string, string> = {
  saved: "Saved",
  unchanged: "Already up to date",
  skipped: "Skipped",
  held: "Pending CMS1500",
  review_required: "Needs review",
  failed: "Failed",
};

function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "saved" || status === "unchanged" || status === "matched" || status === "ready_new" || status === "already_saved") return "secondary";
  if (status === "failed" || status === "invalid") return "destructive";
  return "outline";
}

function candidateLabel(c: ExistingClaimLine): string {
  const paid = c.insuranceReimbursement != null ? `paid ${money(c.insuranceReimbursement)}` : "no payment yet";
  const prov = c.cms1500DocumentId ? "from CMS1500" : "saved before CMS1500 tracking";
  return `Period ${c.authPeriod} · ${c.cptCodes ?? "—"} ${c.modifier ?? ""} · ${c.unitsBilled ?? "?"}u · ${paid} · ${prov}`;
}

const selectClass = "h-8 max-w-full rounded-md border border-input bg-background px-2 text-xs";
const inputClass = "h-7 w-24 rounded-md border border-amber-400 bg-amber-50 px-1.5 text-xs";

export function ClaimImportDialog(props: ClaimImportDialogProps) {
  const { open, onOpenChange, kind, contextPatient = null, contextAuthPeriod = null, initialFiles, onSaved, source = "document" } = props;
  const csv = source === "csv";
  const mode: ReviewMode = csv ? "bulk" : props.mode;
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const entriesRef = useRef<FileEntry[]>([]);
  entriesRef.current = entries;
  // A new dialog session invalidates every in-flight response from the previous one.
  const sessionRef = useRef(0);
  const previewGuards = useRef(new Map<string, RequestGuard>());
  const saveGuards = useRef(new Map<string, SingleFlightGuard>());
  // P4-P27: one extraction per file at a time; a superseded response is dropped.
  const extractGuards = useRef(new Map<string, RequestGuard>());
  const extracting = useRef(new Set<string>());
  const saveAllGuard = useRef(createSingleFlightGuard());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const preview = trpc.claims.importPreview.useMutation();
  const commit = trpc.claims.importCommit.useMutation();
  const csvPreview = trpc.claims.csvImportPreview.useMutation();
  const csvCommit = trpc.claims.csvImportCommit.useMutation();
  const needsRoster = mode === "bulk";
  const { data: roster = [] } = trpc.patients.list.useQuery(undefined, { enabled: open && needsRoster });
  const utils = trpc.useUtils();

  const contextPatientId = contextPatient?.id ?? null;
  const uploadType = kind === "eob" ? "reimbursement" : "cms1500";
  const title = csv
    ? `${CLAIM_CSV_TEMPLATES[kind].title} CSV Upload`
    : mode === "bulk"
      ? kind === "cms1500" ? "Upload CMS1500 PDFs" : "Upload EOB PDFs"
      : kind === "cms1500" ? "CMS1500 Upload" : "Insurance Reimbursement Upload";

  const update = (id: string, fn: (e: FileEntry) => FileEntry) => {
    setEntries(prev => prev.map(e => (e.id === id ? fn(e) : e)));
  };
  const isLive = (id: string, session: number) => session === sessionRef.current && entriesRef.current.some(e => e.id === id);

  // Reset on open; start any initial files.
  useEffect(() => {
    if (!open) return;
    sessionRef.current += 1;
    previewGuards.current.clear();
    saveGuards.current.clear();
    extractGuards.current.clear();
    extracting.current.clear();
    const fresh = (initialFiles ?? []).map(f => ({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file: f, stage: "queued" as Stage }));
    entriesRef.current = fresh;
    setEntries(fresh);
    if (fresh.length > 0) void processFiles(fresh.map(f => f.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const seen = new Set(entriesRef.current.map(e => fileIdentity(e.file)));
    const list = mode === "single" ? Array.from(files) : Array.from(files).filter(f => {
      const k = fileIdentity(f);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (list.length < files.length) toast(`${files.length - list.length} file(s) were already added and were skipped.`);
    if (list.length === 0) return;
    const added = (mode === "single" ? list.slice(0, 1) : list).map(f => ({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file: f, stage: "queued" as Stage }));
    const next = mode === "single" ? added : [...entriesRef.current, ...added];
    entriesRef.current = next;
    setEntries(next);
    void processFiles(added.map(a => a.id));
  };

  async function processFiles(ids: string[]) {
    const session = sessionRef.current;
    await runWithConcurrency(ids, MAX_PARALLEL_EXTRACTIONS, id => processOne(id, session));
  }

  async function processOne(id: string, session: number) {
    const entry = entriesRef.current.find(e => e.id === id);
    if (!entry || !isLive(id, session)) return;
    // A double-clicked Retry must not start a second extraction of the same file.
    if (extracting.current.has(id)) return;
    extracting.current.add(id);
    const guard = extractGuards.current.get(id) ?? createRequestGuard();
    extractGuards.current.set(id, guard);
    const attempt = guard.start();
    const live = () => isLive(id, session) && guard.isCurrent(attempt);
    try {
      await extractOne(id, session, entry.file, live);
    } finally {
      extracting.current.delete(id);
    }
  }

  async function extractOne(id: string, session: number, file: File, live: () => boolean) {
    update(id, e => ({ ...e, stage: "extracting", error: undefined, rowErrors: undefined, review: undefined, preview: undefined }));
    if (csv) return processCsv(id, session, file, live);
    try {
      if (file.size > CLAIM_UPLOAD_MAX_BYTES) throw new Error(`This file is larger than ${CLAIM_UPLOAD_MAX_LABEL}, the upload limit. Nothing was read or saved. Split it into smaller PDFs and upload them together.`);
      const form = new FormData();
      form.append("file", file);
      form.append("uploadType", uploadType);
      let res: Response;
      try {
        res = await fetch("/api/claims/upload-extract", { method: "POST", credentials: "include", body: form, signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS) });
      } catch (err: any) {
        throw new Error(err?.name === "TimeoutError" ? "The server took too long reading this file. Nothing was saved. Try again, or split it into smaller files." : "The file could not be sent to the server. Check your connection and try again.");
      }
      const raw = await res.text();
      let json: any;
      try {
        json = JSON.parse(raw);
      } catch {
        // Platform limits answer before the app does, so these have no JSON body.
        throw new Error(res.status === 504 ? "The server took too long reading this file. Nothing was saved. Try again, or split it into smaller files."
          : res.status === 413 ? `This file is larger than the upload limit (${CLAIM_UPLOAD_MAX_LABEL}). Nothing was read or saved. Split it into smaller PDFs.`
          : `Unexpected server response (status ${res.status}). Nothing was saved.`);
      }
      if (!res.ok) throw new Error(json.error ?? "Extraction failed.");
      const doc = json.importDocument as ImportDocument | undefined;
      if (!doc) throw new Error("The server did not return reviewable lines for this file.");
      if (doc.groups.every(g => g.lines.length === 0)) throw new Error(json.extractionNotes || "No service lines were found in this file.");
      if (!live()) return;
      const review: FileReviewState = { doc, patientChoice: {}, patientConfirmed: {}, patientCreate: {}, patientOutcomes: {}, decisions: {}, edits: {}, results: {} };
      update(id, e => ({ ...e, stage: "checking", review }));
      await runPreview(id, session, review, true);
    } catch (err: any) {
      if (live()) update(id, e => ({ ...e, stage: "failed", error: err?.message ?? "Failed to read this file." }));
    }
  }

  /** P4-P26: the first CSV preview is also the parse — the server reads the file. */
  async function processCsv(id: string, session: number, file: File, live: () => boolean) {
    try {
      if (file.size > CLAIM_CSV_MAX_BYTES) throw new Error(`The file is larger than ${CLAIM_CSV_MAX_BYTES / 1_000_000} MB. Split it into smaller files.`);
      const csvText = await file.text();
      if (!csvText.trim()) throw new Error("This file is empty. Nothing was imported.");
      const result = await csvPreview.mutateAsync({ kind, fileName: file.name, csvText, patientChoices: {} });
      if (!live()) return;
      if (result.templateError) throw new Error(result.templateError);
      if (!result.document || !result.preview || result.document.groups.length === 0) {
        update(id, e => ({ ...e, csvText, rowErrors: result.rowErrors, stage: "failed", error: "No claim in this file can be imported until the problems below are fixed." }));
        return;
      }
      const review: FileReviewState = { doc: result.document, patientChoice: {}, patientConfirmed: {}, patientCreate: {}, patientOutcomes: {}, decisions: {}, edits: {}, results: {} };
      update(id, e => ({ ...e, csvText, rowErrors: result.rowErrors, stage: "checking", review }));
      applyPreview(id, result.preview as PreviewResult);
    } catch (err: any) {
      if (live()) update(id, e => ({ ...e, stage: "failed", error: err?.message ?? "Failed to read this file." }));
    }
  }

  async function requestPreview(id: string, review: FileReviewState): Promise<PreviewResult> {
    if (!csv) return preview.mutateAsync(buildPreviewInput({ state: review, contextPatientId }));
    const e = entry(id)!;
    const result = await csvPreview.mutateAsync(buildCsvPreviewInput({ source: { kind, fileName: e.file.name, csvText: e.csvText! }, state: review }));
    if (result.templateError || !result.preview) throw new Error(result.templateError ?? "The file could not be re-checked.");
    return result.preview as PreviewResult;
  }

  /** Stores a preview, keeping reviewer decisions that are still valid. */
  function applyPreview(id: string, result: PreviewResult) {
    update(id, e => {
      if (!e.review) return e;
      const decisions = { ...e.review.decisions };
      const patientChoice = { ...e.review.patientChoice };
      const patientCreate = { ...e.review.patientCreate };
      for (const g of result.groups) {
        if (g.patient.patientId && !patientChoice[g.groupKey]) patientChoice[g.groupKey] = g.patient.patientId;
        // A group marked new starts by creating its patient on save, under the file's name.
        if (g.patient.identityStatus === "new" && !patientCreate[g.groupKey] && g.patient.creatingName) patientCreate[g.groupKey] = { name: g.patient.creatingName };
        // Someone else's save (or this one) created or linked this patient: it is existing now.
        if (g.patient.identityStatus === "existing") delete patientCreate[g.groupKey];
        for (const line of g.lines) {
          const existing = decisions[line.sourceLineKey];
          if (!existing || !decisionStillValid(kind, existing, line)) {
            decisions[line.sourceLineKey] = initialDecision({ kind, line, mode, contextAuthPeriod });
          }
        }
      }
      return { ...e, stage: "review", checking: false, preview: result, review: { ...e.review, decisions, patientChoice, patientCreate } };
    });
  }

  /** (Re)classifies a file's lines. Keeps reviewer decisions that are still valid. */
  async function runPreview(id: string, session: number, review: FileReviewState, first = false) {
    const guard = previewGuards.current.get(id) ?? createRequestGuard();
    previewGuards.current.set(id, guard);
    const requestId = guard.start();
    update(id, e => ({ ...e, checking: true }));
    try {
      const result = await requestPreview(id, review);
      if (!isLive(id, session) || !guard.isCurrent(requestId)) return;
      applyPreview(id, result);
    } catch (err: any) {
      if (!isLive(id, session) || !guard.isCurrent(requestId)) return;
      update(id, e => (first ? { ...e, stage: "failed", checking: false, error: `Could not check this file: ${err?.message ?? "error"}` } : { ...e, checking: false }));
      if (!first) toast.error(`Could not re-check ${entry(id)?.file.name ?? "the file"}: ${err?.message ?? "error"}`);
    }
  }

  const entry = (id: string) => entriesRef.current.find(e => e.id === id);

  function setReview(id: string, fn: (r: FileReviewState) => FileReviewState, recheck = false) {
    setEntries(prev => prev.map(e => (e.id === id && e.review ? { ...e, review: fn(e.review), recheck: e.recheck || recheck } : e)));
  }

  // Runs the preview for entries flagged for a re-check, against the
  // committed state (never a stale closure).
  useEffect(() => {
    const due = entries.filter(e => e.recheck && e.review && !e.checking && !e.saving);
    if (due.length === 0) return;
    setEntries(prev => prev.map(e => (due.some(d => d.id === e.id) ? { ...e, recheck: false } : e)));
    for (const e of due) void runPreview(e.id, sessionRef.current, e.review!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  const setDecision = (id: string, key: string, decision: LineDecision | null) =>
    setReview(id, r => ({ ...r, decisions: { ...r.decisions, [key]: decision } }));

  async function saveFile(id: string): Promise<void> {
    const guard = saveGuards.current.get(id) ?? createSingleFlightGuard();
    saveGuards.current.set(id, guard);
    if (!guard.tryEnter()) return;
    const session = sessionRef.current;
    try {
      const current = entry(id);
      if (!current?.review) return;
      const input = csv ? null : buildCommitInput({ state: current.review, contextPatientId, contextAuthPeriod });
      const csvInputs = csv
        ? buildCsvCommitInputs({ source: { kind, fileName: current.file.name, csvText: current.csvText! }, state: current.review, maxLines: CSV_LINES_PER_REQUEST })
        : [];
      if (!input && csvInputs.length === 0) {
        toast("Nothing in this file is ready to save yet.");
        return;
      }
      update(id, e => ({ ...e, saving: true }));
      let result: CommitResult;
      if (input) {
        result = await commit.mutateAsync(input);
      } else {
        // Sequential batches. A failed batch stops the rest; lines from
        // batches that already returned keep their results.
        result = { importBatchId: "", groups: [] };
        for (const batch of csvInputs) {
          let r: CommitResult;
          try {
            r = await csvCommit.mutateAsync(batch);
          } catch (err: any) {
            if (result.groups.length === 0) throw err;
            toast.error(`Part of ${current.file.name} could not be saved: ${err?.message ?? "error"}. Saved lines are kept — retry the rest.`);
            break;
          }
          result = { importBatchId: r.importBatchId, groups: [...result.groups, ...r.groups] };
        }
      }
      if (!isLive(id, session)) return;
      // Every other open file is re-checked too: lines this save created can
      // change how another file's lines match (e.g. an overlapping CMS1500).
      setEntries(prev => prev.map(e => {
        if (e.id !== id) return e.review && e.stage === "review" ? { ...e, recheck: true } : e;
        if (!e.review) return e;
        const results = { ...e.review.results };
        for (const g of result.groups) for (const l of g.lines) results[l.sourceLineKey] = l;
        const patientOutcomes = { ...e.review.patientOutcomes };
        for (const g of result.groups) {
          // "created" sticks: a retried group finding its patient must still count as new.
          if (g.patientOutcome && patientOutcomes[g.groupKey] !== "created") patientOutcomes[g.groupKey] = g.patientOutcome;
        }
        return { ...e, saving: false, recheck: true, review: { ...e.review, results, patientOutcomes } };
      }));
      const lines = result.groups.flatMap(g => g.lines);
      const saved = lines.filter(l => l.status === "saved").length;
      const held = lines.filter(l => l.status === "held").length;
      const review = lines.filter(l => l.status === "review_required").length;
      const failed = lines.filter(l => l.status === "failed").length;
      const createdPatients = result.groups.some(g => g.patientOutcome === "created");
      if (saved > 0 || held > 0 || createdPatients) onSaved?.();
      const name = current.file.name;
      const heldText = held > 0 ? `, ${held} pending until the CMS1500 is uploaded` : "";
      if (failed > 0 || review > 0) toast.warning(`${name}: ${saved} saved${heldText}, ${review} need review, ${failed} failed. Unresolved lines stay below for retry.`, { duration: 10000 });
      else toast.success(`${name}: ${saved} saved${heldText}${lines.length - saved - held > 0 ? `, ${lines.length - saved - held} already up to date or skipped` : ""}.`);
      if (kind === "cms1500" && saved > 0) {
        // Lines this save created may be what a waiting reimbursement needed.
        const pending = await utils.claims.pendingEobList.fetch();
        const ready = pending.items.filter(i => i.classification.status !== "cms1500_required").length;
        if (ready > 0) toast.info(`${ready} waiting reimbursement line${ready !== 1 ? "s" : ""} can now be applied under Bulk Upload → Insurance Reimbursement.`, { duration: 12000 });
      }
    } catch (err: any) {
      if (isLive(id, session)) {
        update(id, e => ({ ...e, saving: false }));
        toast.error(`Save failed for ${entry(id)?.file.name ?? "file"}: ${err?.message ?? "error"}. Nothing from this request was reported as saved — retry.`);
      }
    } finally {
      guard.exit();
    }
  }

  async function saveAll() {
    if (!saveAllGuard.current.tryEnter()) return;
    try {
      for (const e of entriesRef.current.filter(x => x.stage === "review")) await saveFile(e.id);
    } finally {
      saveAllGuard.current.exit();
    }
  }

  const removeFile = (id: string) => {
    const next = entriesRef.current.filter(e => e.id !== id);
    entriesRef.current = next;
    setEntries(next);
  };

  const retryFile = (id: string) => void processFiles([id]);

  const busy = entries.some(e => e.stage === "extracting" || e.stage === "checking" || e.saving);
  const anySaving = entries.some(e => e.saving);
  const fileSummary = summarizeFiles(entries);

  return (
    <Dialog open={open} onOpenChange={o => { if (!o && anySaving) return; onOpenChange(o); }}>
      <DialogContent className="w-[calc(100vw-1rem)] sm:max-w-6xl max-h-[92vh] overflow-y-auto rounded-2xl p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-brand-blue">
            <FileUp className="w-5 h-5 text-brand-gold" /> {title}
          </DialogTitle>
          <DialogDescription>
            {csv && (kind === "cms1500" ? "From the CSV template or the billing system's invoice export. " : "One row per service line, from the CSV template. ")}
            {kind === "cms1500"
              ? "CMS1500 forms create the claim's service lines (date, CPT, modifiers, units, diagnosis). Amounts stay blank until the EOB is uploaded."
              : "The EOB adds billed, paid and patient-responsibility amounts to lines that already came from a CMS1500. Upload the CMS1500 first."}
            {mode === "single" && contextPatient ? ` Patient: ${contextPatient.name}${contextAuthPeriod ? `, period ${contextAuthPeriod}` : ""}.` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple={mode === "bulk"}
            accept={csv ? ".csv,text/csv" : kind === "cms1500" ? ".pdf" : ".pdf,.csv,.xlsx,.xls,.xlsm"}
            onChange={e => { addFiles(e.target.files); e.target.value = ""; }}
            data-testid="claim-import-file-input"
          />
          <Button variant="outline" size="sm" disabled={anySaving || (mode === "single" && busy)} onClick={() => fileInputRef.current?.click()}>
            <FileUp className="w-4 h-4 mr-1" /> {mode === "bulk" ? (csv ? "Add files" : "Add more PDFs") : entries.length > 0 ? "Choose a different file" : "Choose file"}
          </Button>
          {mode === "bulk" && entries.length > 0 && (
            <span className="text-xs text-muted-foreground" data-testid="claim-import-progress" aria-live="polite">
              {fileSummary.read} of {fileSummary.total} file{fileSummary.total !== 1 ? "s" : ""} read
              {fileSummary.reading > 0 ? ` (up to ${MAX_PARALLEL_EXTRACTIONS} at a time)` : ""}
              {fileSummary.needsReview > 0 ? ` · ${fileSummary.needsReview} to review` : ""}
              {fileSummary.saved > 0 ? ` · ${fileSummary.saved} saved` : ""}
              {fileSummary.failed > 0 ? ` · ${fileSummary.failed} failed` : ""}
            </span>
          )}
          {csv && (
            <Button variant="ghost" size="sm" className="sm:ml-auto" onClick={() => downloadClaimCsvTemplate(kind)}>
              <Download className="w-4 h-4 mr-1" /> Download CSV Template
            </Button>
          )}
        </div>

        {entries.length === 0 && (
          <p className="text-sm text-muted-foreground py-6 text-center">
            {csv
              ? `Add one or more files made from ${CLAIM_CSV_TEMPLATES[kind].fileName}${kind === "cms1500" ? ", or invoice exports" : ""}. Each claim in a file is reviewed on its own.`
              : mode === "bulk" ? "Add one or more PDFs. Each PDF can have several pages and several patients; scanned PDFs are read with OCR." : "Choose a file to start."}
          </p>
        )}

        <div className="space-y-4">
          {entries.map(e => (
            <FileCard
              key={e.id}
              kind={kind}
              mode={mode}
              entry={e}
              roster={roster}
              contextPatient={contextPatient}
              onRemove={() => removeFile(e.id)}
              onRetry={() => retryFile(e.id)}
              onSave={() => void saveFile(e.id)}
              onDecision={(key, d) => setDecision(e.id, key, d)}
              onPatient={(groupKey, patientId) => setReview(e.id, r => ({ ...r, patientChoice: { ...r.patientChoice, [groupKey]: patientId } }), true)}
              onConfirmPatient={(groupKey, v) => setReview(e.id, r => ({ ...r, patientConfirmed: { ...r.patientConfirmed, [groupKey]: v } }))}
              onPatientForCluster={(clusterKey, patientId, confirmed) => setReview(e.id, r => forCluster(e, clusterKey, r, k => ({
                patientChoice: { [k]: patientId }, patientConfirmed: { [k]: confirmed }, patientCreate: { [k]: undefined },
              })), true)}
              onConfirmCluster={(clusterKey, v) => setReview(e.id, r => forCluster(e, clusterKey, r, k => ({ patientConfirmed: { [k]: v } })))}
              onCreateForCluster={(clusterKey, request) => setReview(e.id, r => forCluster(e, clusterKey, r, k => ({
                patientCreate: { [k]: request }, patientChoice: { [k]: undefined }, patientConfirmed: { [k]: false },
              })), true)}
              onPeriodForCluster={(clusterKey, period) => setReview(e.id, r => {
                const decisions = { ...r.decisions };
                for (const g of e.preview?.groups ?? []) {
                  if (g.patient.clusterKey !== clusterKey) continue;
                  for (const line of g.lines) {
                    if (line.status !== "period_required") continue;
                    const prev = decisions[line.sourceLineKey] as Cms1500Decision | null | undefined;
                    if (prev?.action === "skip") continue;
                    decisions[line.sourceLineKey] = { ...(prev ?? {}), action: "create", authPeriod: period, periodSource: "selected" };
                  }
                }
                return { ...r, decisions };
              })}
              onEdit={(key, edits) => setReview(e.id, r => ({ ...r, edits: { ...r.edits, [key]: { ...r.edits[key], ...edits } } }))}
              onRecheck={() => setReview(e.id, r => r, true)}
            />
          ))}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" disabled={anySaving} onClick={() => onOpenChange(false)}>Close</Button>
          {mode === "bulk" && entries.some(x => x.stage === "review") && (
            <Button className="bg-brand-blue hover:bg-brand-blue-dark text-white" disabled={anySaving} onClick={() => void saveAll()}>
              {anySaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
              Save all reviewed files
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Applies one review choice to every group of the same person in this file. */
function forCluster(
  entry: FileEntry,
  clusterKey: string,
  review: FileReviewState,
  patch: (groupKey: string) => Partial<Record<"patientChoice" | "patientConfirmed" | "patientCreate", Record<string, any>>>,
): FileReviewState {
  const next = { ...review, patientChoice: { ...review.patientChoice }, patientConfirmed: { ...review.patientConfirmed }, patientCreate: { ...review.patientCreate } };
  for (const g of entry.preview?.groups ?? []) {
    if (g.patient.clusterKey !== clusterKey) continue;
    const p = patch(g.groupKey);
    Object.assign(next.patientChoice, p.patientChoice ?? {});
    Object.assign(next.patientConfirmed, p.patientConfirmed ?? {});
    Object.assign(next.patientCreate, p.patientCreate ?? {});
  }
  return next;
}

function decisionStillValid(kind: Kind, decision: LineDecision, line: PreviewLine): boolean {
  if (decision.action === "skip") return true;
  if ("dismissed" in line && line.dismissed === true && !(decision as EobDecision).reopenDismissed) return false;
  if (decision.action === "hold") return line.status === "cms1500_required";
  if (kind === "cms1500") {
    const d = decision as Cms1500Decision;
    if (line.status === "already_saved") return true;
    if (d.action === "associate") return "associableIds" in line && line.associableIds.includes(d.claimRecordId ?? "");
    if (d.action === "create_distinct") return line.status === "needs_selection";
    return line.status === "ready_new" || line.status === "period_required";
  }
  const d = decision as EobDecision;
  if (!("candidates" in line)) return false;
  return line.candidates.some(c => c.id === d.claimRecordId) || ("targetClaimId" in line && line.targetClaimId === d.claimRecordId);
}

// ─── One file ──────────────────────────────────────────────────────────────

function FileCard(props: {
  kind: Kind;
  mode: ReviewMode;
  entry: FileEntry;
  roster: Array<{ id: string; name: string }>;
  contextPatient: { id: string; name: string } | null;
  onRemove: () => void;
  onRetry: () => void;
  onSave: () => void;
  onDecision: (key: string, d: LineDecision | null) => void;
  onPatient: (groupKey: string, patientId: string | undefined) => void;
  onConfirmPatient: (groupKey: string, v: boolean) => void;
  onPatientForCluster: (clusterKey: string, patientId: string | undefined, confirmed: boolean) => void;
  onConfirmCluster: (clusterKey: string, v: boolean) => void;
  onCreateForCluster: (clusterKey: string, request: PatientCreateRequest | undefined) => void;
  onPeriodForCluster: (clusterKey: string, period: number) => void;
  onEdit: (key: string, edits: LineEdits) => void;
  onRecheck: () => void;
}) {
  const { kind, entry, onRemove, onRetry, onSave } = props;
  const { review, preview } = entry;
  const summary = review ? summarizeResults(review) : null;
  const patients = review ? summarizePatients(review, k => preview?.groups.find(g => g.groupKey === k)?.patient.clusterKey) : null;
  const readyCount = useMemo(() => {
    if (!review) return 0;
    const input = buildCommitInput({ state: review, contextPatientId: null, contextAuthPeriod: null });
    return input ? input.groups.reduce((n, g) => n + g.lines.length, 0) : 0;
  }, [review]);
  const working = entry.stage === "extracting" || entry.stage === "checking";

  return (
    <div className="rounded-xl border border-border bg-card" data-testid="claim-import-file">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-medium text-sm break-all">{entry.file.name}</span>
        <Badge variant={entry.stage === "failed" ? "destructive" : "outline"} className="gap-1">
          {working && <Loader2 className="w-3 h-3 animate-spin" />}
          {entry.stage === "failed" && <XCircle className="w-3 h-3" />}
          {STAGE_LABEL[entry.stage]}
        </Badge>
        {review && <span className="text-xs text-muted-foreground">{review.doc.extractionMethod}{review.doc.pageCount ? ` · ${review.doc.pageCount} page(s)` : ""}</span>}
        <div className="ml-auto flex items-center gap-1">
          {entry.stage === "failed" && <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw className="w-3.5 h-3.5 mr-1" />Retry</Button>}
          {!entry.saving && <Button size="sm" variant="ghost" aria-label={`Remove ${entry.file.name}`} onClick={onRemove}><Trash2 className="w-3.5 h-3.5" /></Button>}
        </div>
      </div>

      {entry.error && <p className="px-3 py-2 text-sm text-destructive">{entry.error}</p>}

      {entry.rowErrors && entry.rowErrors.length > 0 && (
        <div className="mx-3 mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800" data-testid="claim-csv-row-errors">
          <p className="font-semibold">
            {entry.rowErrors.length} problem{entry.rowErrors.length !== 1 ? "s" : ""} in the file — the claims involved are not imported. Fix the file and upload it again; lines already saved are not duplicated.
          </p>
          <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-4">
            {entry.rowErrors.map((r, i) => (
              <li key={i}>{r.row != null ? `Row ${r.row}` : "Claim"}{r.claimId ? ` (${r.claimId})` : ""}: {r.message}</li>
            ))}
          </ul>
        </div>
      )}

      {review?.doc.columnMapping && (
        <details className="mx-3 mt-2 rounded-md border border-blue-200 bg-blue-50 p-2 text-xs text-blue-900" data-testid="claim-import-column-mapping">
          <summary className="cursor-pointer font-semibold">How this file's columns are used</summary>
          <ul className="mt-1 space-y-0.5">
            {review.doc.columnMapping.map(m => <li key={m.column}><span className="font-medium">{m.column}:</span> {m.usedAs}</li>)}
          </ul>
        </details>
      )}

      {review?.doc.extractionFallback && (
        <p className="mx-3 mt-2 flex gap-1 rounded-md border border-amber-400 bg-amber-100 p-2 text-xs font-medium text-amber-950" role="alert" data-testid="claim-import-fallback">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {review.doc.extractionFallback}
        </p>
      )}

      {review && review.doc.warnings.length > 0 && (
        <ul className="mx-3 mt-2 space-y-1 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
          {review.doc.warnings.map((w, i) => <li key={i} className="flex gap-1"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{w}</li>)}
        </ul>
      )}

      {review && preview && (
        <div className="space-y-3 p-3">
          {review.doc.groups.map(g => {
            const pg = preview.groups.find(x => x.groupKey === g.groupKey);
            return pg ? <GroupSection key={g.groupKey} {...props} group={g as any} previewGroup={pg} /> : null;
          })}
        </div>
      )}

      {review && summary && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-xs">
          <span>{summary.total} line(s)</span>
          {summary.saved > 0 && <Badge variant="secondary">{summary.saved} saved</Badge>}
          {patients && patients.created > 0 && <Badge variant="secondary" data-testid="claim-import-patients-created">{patients.created} new patient{patients.created !== 1 ? "s" : ""} created</Badge>}
          {patients && patients.existing > 0 && <Badge variant="secondary" data-testid="claim-import-patients-existing">{patients.existing} existing patient{patients.existing !== 1 ? "s" : ""}</Badge>}
          {summary.held > 0 && <Badge variant="outline" data-testid="claim-import-held">{summary.held} pending CMS1500</Badge>}
          {summary.unchanged > 0 && <Badge variant="secondary">{summary.unchanged} already up to date</Badge>}
          {summary.review > 0 && <Badge variant="outline">{summary.review} need review</Badge>}
          {summary.failed > 0 && <Badge variant="destructive">{summary.failed} failed</Badge>}
          <Button
            size="sm"
            className="ml-auto bg-brand-blue hover:bg-brand-blue-dark text-white"
            disabled={entry.saving || entry.checking || readyCount === 0}
            onClick={onSave}
            data-testid="claim-import-save"
          >
            {entry.saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <CheckCircle2 className="w-4 h-4 mr-1" />}
            {summary.saved + summary.unchanged > 0 ? `Retry / save ${readyCount} remaining` : `Save ${readyCount} reviewed line${readyCount !== 1 ? "s" : ""}`}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── One patient group inside a file ──────────────────────────────────────

const IDENTITY_BADGE: Record<string, { label: string; className: string }> = {
  existing: { label: "Existing patient", className: "border-green-300 bg-green-50 text-green-800" },
  new: { label: "New patient", className: "border-blue-300 bg-blue-50 text-blue-800" },
  needs_confirmation: { label: "Needs confirmation", className: "border-amber-400 bg-amber-50 text-amber-900" },
};

function GroupSection(props: Parameters<typeof FileCard>[0] & { group: { groupKey: string; patientName: string | null; pages: number[] | null; claimIdentifier: string | null; lines: Array<Cms1500ImportLine | EobImportLine>; warnings: string[]; unresolvedClaimTotals: Array<{ dateOfService: string | null; cptCodes: string | null; planPaid: number | null; patientResponsibility: number | null; cptCount: number }>; sourcePayerLabel?: string | null; lineDateOptions?: Record<string, string[]> }; previewGroup: PreviewGroup }) {
  const { kind, mode, entry, roster, contextPatient, group, previewGroup, onPatient, onConfirmPatient, onPatientForCluster, onConfirmCluster, onCreateForCluster, onPeriodForCluster } = props;
  const review = entry.review!;
  const csvGroup = entry.csvText != null;
  const p = previewGroup.patient;
  const chosen = review.patientChoice[group.groupKey] ?? p.patientId ?? undefined;
  const options = p.status === "unreadable" && mode === "bulk"
    ? roster.map(r => ({ id: r.id, name: r.name }))
    : p.status === "unreadable" && contextPatient ? [contextPatient] : p.candidates;
  const bulk = mode === "bulk";
  const clusterKey = p.clusterKey ?? group.groupKey;
  const creating = !!p.creatingName && bulk;
  const createRequest = review.patientCreate?.[group.groupKey];
  const createdName = createRequest?.name ?? p.creatingName ?? "";
  const anyDone = group.lines.some(l => isLineDone(review.results[l.sourceLineKey]));
  const badge = p.identityStatus ? IDENTITY_BADGE[p.identityStatus] : null;
  const periodLines = previewGroup.lines.filter(l => l.status === "period_required" && !isLineDone(review.results[l.sourceLineKey]));

  return (
    <div className="rounded-lg border border-border" data-testid="claim-import-group">
      <div className="flex flex-wrap items-center gap-2 bg-muted/40 px-3 py-2 text-sm">
        <span className="text-muted-foreground">In file:</span>
        {csvGroup && group.claimIdentifier && <span className="font-mono text-xs">Claim {group.claimIdentifier}</span>}
        <span className="font-medium">{group.patientName ?? "Patient name unreadable"}</span>
        {group.pages && <span className="text-xs text-muted-foreground">page{group.pages.length > 1 ? "s" : ""} {group.pages.join(", ")}</span>}
        <span className="text-muted-foreground">→</span>
        {bulk && badge && <Badge variant="outline" className={badge.className} data-testid="claim-import-patient-status">{badge.label}</Badge>}
        {p.status === "matched" && <span className="font-medium text-green-700">{p.patientName}</span>}
        {creating && (
          <span className="flex flex-wrap items-center gap-2" data-testid="claim-import-new-patient">
            <input
              key={`${group.groupKey}:${createdName}`}
              aria-label="Name for the new patient"
              className="h-8 w-56 max-w-full rounded-md border border-input bg-background px-2 text-xs"
              defaultValue={createdName}
              disabled={anyDone}
              onBlur={e => {
                const name = e.target.value.trim();
                if (name && name !== createdName) onCreateForCluster(clusterKey, { ...createRequest, name });
              }}
            />
            {createRequest?.distinctConfirmed && !anyDone && (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onCreateForCluster(clusterKey, undefined)}>Use an existing patient instead</Button>
            )}
          </span>
        )}
        {!creating && (p.status === "candidates" || p.status === "unreadable") && (
          <span className="flex flex-wrap items-center gap-2">
            <select
              className={selectClass}
              aria-label="Patient for this part of the file"
              value={chosen ?? ""}
              onChange={e => (bulk ? onPatientForCluster(clusterKey, e.target.value || undefined, false) : onPatient(group.groupKey, e.target.value || undefined))}
            >
              <option value="">Choose patient…</option>
              {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <label className="flex items-center gap-1 text-xs">
              <Checkbox
                checked={review.patientConfirmed[group.groupKey] === true}
                disabled={!chosen}
                onCheckedChange={v => (bulk ? onConfirmCluster(clusterKey, v === true) : onConfirmPatient(group.groupKey, v === true))}
              />
              I confirm this is the right patient
            </label>
          </span>
        )}
        {bulk && !creating && p.canCreate && !anyDone && (
          group.patientName
            ? <Button size="sm" variant="outline" className="h-7 px-2 text-xs" data-testid="claim-import-create-patient" onClick={() => onCreateForCluster(clusterKey, { name: group.patientName!, distinctConfirmed: true })}>Create as a new patient</Button>
            : (
              <input
                aria-label="Name for a new patient"
                placeholder="Or type a new patient's name"
                className="h-8 w-56 max-w-full rounded-md border border-input bg-background px-2 text-xs"
                data-testid="claim-import-typed-name"
                onBlur={e => {
                  const name = e.target.value.trim();
                  if (name) onCreateForCluster(clusterKey, { name, distinctConfirmed: true });
                }}
              />
            )
        )}
        {p.status === "unmatched" && !bulk && <span className="text-destructive">No dashboard patient matches — not imported.</span>}
        {p.status === "other_patient" && <span className="text-destructive">A different patient — not imported here. Use the bulk upload.</span>}
      </div>
      {bulk && p.identityReasons && p.identityReasons.length > 0 && !creating && (
        <ul className="space-y-1 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900" data-testid="claim-import-identity-reasons">
          {p.identityReasons.map((w, i) => <li key={i} className="flex gap-1"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{w}</li>)}
        </ul>
      )}
      {creating && !anyDone && (
        <p className="bg-blue-50 px-3 py-2 text-xs text-blue-900">
          Added to the dashboard when you save, with this name only. Insurance and authorization stay blank until you set them on the patient's page.
          {kind === "eob" ? " Reimbursement lines are kept pending until the matching CMS1500 is uploaded." : ""}
        </p>
      )}
      {group.sourcePayerLabel && <p className="px-3 pt-2 text-xs text-muted-foreground">Payer in file (not saved): {group.sourcePayerLabel}</p>}
      {kind === "cms1500" && bulk && periodLines.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 bg-muted/20 px-3 py-2 text-xs" data-testid="claim-import-period-all">
          <span>{creating ? "This patient has no authorization periods yet." : `${periodLines.length} lines need a period.`} Set every line for this patient:</span>
          {(previewGroup.periodOptions.length > 0 ? previewGroup.periodOptions : [1]).map(n => (
            <Button key={n} size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => onPeriodForCluster(clusterKey, n)}>Period {n}</Button>
          ))}
        </div>
      )}
      {group.warnings.length > 0 && (
        <ul className="space-y-1 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {group.warnings.map((w, i) => <li key={i} className="flex gap-1"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{w}</li>)}
        </ul>
      )}
      {group.unresolvedClaimTotals.length > 0 && (
        <ul className="space-y-1 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {group.unresolvedClaimTotals.map((t, i) => (
            <li key={i}>
              {t.planPaid != null ? `Combined plan payment ${money(t.planPaid)}` : "Combined claim total"}
              {t.patientResponsibility != null ? `${t.planPaid != null ? "," : ""} patient responsibility ${money(t.patientResponsibility)}` : ""}
              {` for ${t.cptCount} lines on ${dateText(t.dateOfService)} (${t.cptCodes}) — not saved to any line. Allocate it manually if needed.`}
            </li>
          ))}
        </ul>
      )}
      <div className="divide-y divide-border">
        {group.lines.map(line => {
          const pl = previewGroup.lines.find(l => l.sourceLineKey === line.sourceLineKey);
          return pl ? <LineRow key={line.sourceLineKey} {...props} kind={kind} line={line} previewLine={pl} periodOptions={previewGroup.periodOptions} dateOptions={group.lineDateOptions?.[line.sourceLineKey]} /> : null;
        })}
      </div>
    </div>
  );
}

// ─── One line ──────────────────────────────────────────────────────────────

function LineRow(props: Parameters<typeof FileCard>[0] & { line: Cms1500ImportLine | EobImportLine; previewLine: PreviewLine; periodOptions: number[]; dateOptions?: string[] }) {
  const { kind, entry, line, previewLine: pl, periodOptions, dateOptions, onDecision, onEdit, onRecheck } = props;
  const review = entry.review!;
  const result = review.results[line.sourceLineKey];
  const done = isLineDone(result);
  const decision = review.decisions[line.sourceLineKey] ?? null;
  const cms = kind === "cms1500" ? applyLineEdits(line as Cms1500ImportLine, review.edits[line.sourceLineKey]) : null;
  const eob = kind === "eob" ? (line as EobImportLine) : null;
  const held = "held" in pl && pl.held === true;
  const status = result ? result.status : pl.status;
  const flagged = cms ? cms.unreadable : [];
  const editable = !!cms && !done && (flagged.length > 0 || pl.status === "invalid");

  const editField = (field: keyof LineEdits, raw: string) => {
    const v = raw.trim();
    const value = field === "unitsBilled" ? (v === "" ? null : Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null) : v === "" ? null : v;
    onEdit(line.sourceLineKey, { [field]: value } as LineEdits);
  };
  const cell = (field: keyof LineEdits, value: string | number | null, label: string, width = "w-24") =>
    editable && field === "dateOfService" && dateOptions && dateOptions.length > 1 ? (
      <select
        aria-label="Date of service (the file lists several)"
        className={`${inputClass} w-32`}
        value={value ?? ""}
        onChange={e => { editField(field, e.target.value); onRecheck(); }}
      >
        <option value="">Choose date…</option>
        {dateOptions.map(d => <option key={d} value={d}>{d}</option>)}
      </select>
    ) : editable && (flagged.includes(field) || (pl.status === "invalid" && (field === "dateOfService" || field === "cptCodes"))) ? (
      <input
        aria-label={`${label} (unreadable — enter from the form)`}
        className={`${inputClass} ${width}`}
        defaultValue={value ?? ""}
        placeholder={field === "dateOfService" ? "YYYY-MM-DD" : "?"}
        onBlur={e => editField(field, e.target.value)}
      />
    ) : (
      <span className={flagged.includes(field) ? "text-amber-700" : ""}>{value ?? "—"}</span>
    );

  return (
    <div className="grid grid-cols-1 gap-2 px-3 py-2 text-xs md:grid-cols-[minmax(0,1fr)_minmax(14rem,22rem)] md:items-start" data-testid="claim-import-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {cms && cms.page != null && <span className="text-muted-foreground">p{cms.page}{cms.slot != null ? ` r${cms.slot}` : ""}</span>}
        {line.sourceRow != null && <span className="text-muted-foreground">Row {line.sourceRow}</span>}
        <span>{cms ? cell("dateOfService", cms.dateOfService, "Date of service", "w-28") : dateText(eob!.dateOfService)}</span>
        <span className="font-medium">{cms ? cell("cptCodes", cms.cptCodes, "CPT", "w-16") : eob!.cptCodes}</span>
        <span>Mod {cms ? cell("modifier", cms.modifier, "Modifiers", "w-20") : eob!.modifier ?? "—"}</span>
        <span>{cms ? cell("unitsBilled", cms.unitsBilled, "Units", "w-12") : eob!.unitsBilled ?? "—"} u</span>
        {cms && (
          <span>
            Dx {cms.diagnosisPointer ? <span className="text-muted-foreground">{cms.diagnosisPointer} → </span> : null}
            {cell("diagnosisCodes", cms.diagnosisCodes, "Diagnosis codes", "w-48")}
          </span>
        )}
        {eob && (
          <>
            <span>Billed {money(eob.chargeAmount)}</span>
            <span>Paid {money(eob.insuranceReimbursement)}</span>
            <span>Pt resp. {money(eob.patientAmountDue)}</span>
            {eob.patientAmountPaid != null && <span>Pt paid {money(eob.patientAmountPaid)}</span>}
            {eob.claimStatus && <span className="capitalize">{eob.claimStatus}</span>}
          </>
        )}
        {cms?.notes && <span className="w-full text-amber-800">{cms.notes}</span>}
        {editable && <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onRecheck}>Re-check edited line</Button>}
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant={statusTone(status)}>{RESULT_LABEL[status] ?? LINE_STATUS_LABEL[status] ?? status}</Badge>
          {"reason" in pl && pl.reason && !done && <span className="text-muted-foreground">{pl.reason}</span>}
          {status === "held" && <span className="text-muted-foreground">{result?.message ?? "Upload the matching CMS1500 first."}</span>}
        </div>
        {result?.message && !done && <span className="text-amber-800">{result.message}</span>}
        {!done && (kind === "cms1500"
          ? <Cms1500Action line={pl} decision={decision as Cms1500Decision | null} periodOptions={periodOptions} flagged={flagged} onDecision={d => onDecision(line.sourceLineKey, d)} />
          : <EobAction line={pl} decision={decision as EobDecision | null} held={held} onDecision={d => onDecision(line.sourceLineKey, d)} />)}
      </div>
    </div>
  );
}

function Cms1500Action({ line, decision, periodOptions, flagged, onDecision }: { line: PreviewLine; decision: Cms1500Decision | null; periodOptions: number[]; flagged: string[]; onDecision: (d: Cms1500Decision | null) => void }) {
  if (line.status === "patient_required" || line.status === "invalid") return null;
  const period = "period" in line ? line.period : null;
  const resolvedPeriod = period?.status === "resolved" ? period.authPeriod : null;
  const periodChoices = period?.status === "uncertain" ? period.options : periodOptions;
  const currentPeriod = decision?.authPeriod ?? resolvedPeriod ?? "";

  const periodSelect = (base: Cms1500Decision) => (
    <select
      className={selectClass}
      aria-label="Authorization period"
      value={currentPeriod}
      onChange={e => onDecision({ ...base, authPeriod: e.target.value ? Number(e.target.value) : null, periodSource: e.target.value ? "selected" : null })}
    >
      {resolvedPeriod == null && <option value="">Choose period…</option>}
      {Array.from(new Set([...(resolvedPeriod != null ? [resolvedPeriod] : []), ...periodChoices])).map(n => (
        <option key={n} value={n}>Period {n}{n === resolvedPeriod ? (period?.status === "resolved" && period.basis === "file" ? " (from file)" : " (matches visit dates)") : ""}</option>
      ))}
    </select>
  );

  const ack = flagged.length > 0 && decision && decision.action !== "skip" ? (
    <label className="flex items-center gap-1">
      <Checkbox checked={decision.acknowledgeFlags === true} onCheckedChange={v => onDecision({ ...decision, acknowledgeFlags: v === true })} />
      Blank values reviewed — save without them
    </label>
  ) : null;

  if (line.status === "already_saved") return <span className="text-muted-foreground">Will be checked against the saved line; amounts are never changed.</span>;

  if (line.status === "identity_review") {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-muted-foreground">{decision?.action === "skip" ? "Skipped" : "Not saved from this file."}</span>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onDecision(decision?.action === "skip" ? null : { action: "skip" })}>
          {decision?.action === "skip" ? "Undo skip" : "Skip"}
        </Button>
      </div>
    );
  }

  if (line.status === "needs_selection") {
    const value = decision?.action === "associate" ? `assoc:${decision.claimRecordId}` : decision?.action ?? "";
    return (
      <div className="flex flex-col gap-1">
        <select
          className={selectClass}
          aria-label="How to save this line"
          value={value}
          onChange={e => {
            const v = e.target.value;
            if (!v) onDecision(null);
            else if (v === "skip") onDecision({ action: "skip" });
            else if (v === "create_distinct") onDecision({ action: "create_distinct", authPeriod: resolvedPeriod, periodSource: resolvedPeriod != null ? "resolved" : null });
            else onDecision({ action: "associate", claimRecordId: v.slice("assoc:".length) });
          }}
        >
          <option value="">Choose…</option>
          {"candidates" in line && line.candidates.filter(c => "associableIds" in line && line.associableIds.includes(c.id)).map(c => (
            <option key={c.id} value={`assoc:${c.id}`}>Use existing line: {candidateLabel(c)}</option>
          ))}
          <option value="create_distinct">Save as a separate service line</option>
          <option value="skip">Skip this line</option>
        </select>
        {decision?.action === "create_distinct" && periodSelect(decision)}
        {ack}
      </div>
    );
  }

  const base: Cms1500Decision = decision && decision.action !== "skip" ? decision : { action: "create" };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {decision?.action === "skip" ? <span className="text-muted-foreground">Skipped</span> : periodSelect(base)}
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onDecision(decision?.action === "skip" ? null : { action: "skip" })}>
          {decision?.action === "skip" ? "Undo skip" : "Skip"}
        </Button>
      </div>
      {ack}
    </div>
  );
}

function EobAction({ line, decision, held, onDecision: decide }: { line: PreviewLine; decision: EobDecision | null; held: boolean; onDecision: (d: EobDecision | null) => void }) {
  const dismissed = "dismissed" in line && line.dismissed === true;
  const [reopening, setReopening] = useState(decision?.reopenDismissed === true);
  // Every decision on a line being reopened carries the reviewer's explicit reopen.
  const onDecision = (d: EobDecision | null) => decide(d && dismissed && d.action !== "skip" ? { ...d, reopenDismissed: true } : d);
  if (line.status === "patient_required" || line.status === "invalid") return null;
  if (dismissed && !reopening) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-muted-foreground">{decision?.action === "skip" ? "Skipped" : "Not saved from this file."}</span>
        <Button
          size="sm" variant="outline" className="h-6 px-2 text-[11px]" data-testid="claim-import-reopen-dismissed"
          onClick={() => {
            setReopening(true);
            if (line.status === "cms1500_required") onDecision({ action: "hold" });
            else if (line.status === "matched" && "targetClaimId" in line && line.targetClaimId) onDecision({ action: "apply", claimRecordId: line.targetClaimId });
            else decide(null);
          }}
        >
          Reopen this line
        </Button>
      </div>
    );
  }
  if (line.status === "cms1500_required") {
    return (
      <div className="flex flex-wrap items-center gap-1">
        {decision?.action === "skip"
          ? <span className="text-muted-foreground">Skipped</span>
          : <span>{held ? "Already pending from an earlier save." : "Saving keeps this line pending. Nothing is paid until its CMS1500 is saved."}</span>}
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onDecision(decision?.action === "skip" ? { action: "hold" } : { action: "skip" })}>
          {decision?.action === "skip" ? "Undo skip" : "Skip"}
        </Button>
      </div>
    );
  }
  const candidates = "candidates" in line ? (line.candidates as ExistingClaimLine[]) : [];
  const target = "targetClaimId" in line ? line.targetClaimId : undefined;
  if (line.status === "already_saved") return <span className="text-muted-foreground">Already applied from this file.</span>;

  const skipButton = (
    <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => onDecision(decision?.action === "skip" ? (target && line.status === "matched" ? { action: "apply", claimRecordId: target } : null) : { action: "skip" })}>
      {decision?.action === "skip" ? "Undo skip" : "Skip"}
    </Button>
  );

  if (line.status === "matched") {
    const c = candidates[0];
    return (
      <div className="flex flex-wrap items-center gap-1">
        {decision?.action === "skip" ? <span className="text-muted-foreground">Skipped</span> : <span>→ {c ? candidateLabel(c) : "matched line"}</span>}
        {skipButton}
      </div>
    );
  }

  if (line.status === "needs_selection") {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <select
          className={selectClass}
          aria-label="Claim line this payment belongs to"
          value={decision?.action === "apply" ? decision.claimRecordId ?? "" : decision?.action === "skip" ? "skip" : ""}
          onChange={e => {
            const v = e.target.value;
            onDecision(!v ? null : v === "skip" ? { action: "skip" } : { action: "apply", claimRecordId: v });
          }}
        >
          <option value="">Choose the CMS1500 line…</option>
          {candidates.map(c => <option key={c.id} value={c.id}>{candidateLabel(c)}</option>)}
          <option value="skip">Skip this line</option>
        </select>
      </div>
    );
  }

  // needs_confirmation
  return (
    <div className="flex flex-wrap items-center gap-1">
      <label className="flex items-center gap-1">
        <Checkbox
          checked={decision?.action === "apply" && decision.confirmReplace === true}
          onCheckedChange={v => onDecision(v === true && target ? { action: "apply", claimRecordId: target, confirmReplace: true } : null)}
        />
        Replace the existing amounts on this line
      </label>
      {skipButton}
    </div>
  );
}
