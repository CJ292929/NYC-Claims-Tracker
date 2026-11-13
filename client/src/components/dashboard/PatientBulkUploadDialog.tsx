/**
 * client/src/components/dashboard/PatientBulkUploadDialog.tsx — P4-P29
 *
 * "Bulk Upload Patients" on Patient Records, for Staff, Clinic Admin and
 * Owner. Choose a Patient Data CSV → review every patient (new, already on the
 * dashboard, similar to an existing patient, or invalid) → save → summary.
 * Parsing, validation and duplicate checks all run on the server
 * (server/patientCsvImport.ts) on preview AND on save, so this component only
 * shows the review and passes the reviewer's choices. Separate from the
 * claims Bulk Upload (CMS1500 / Insurance Reimbursement), which stays Clinic
 * Admin / Owner only.
 */
import { useRef, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";
import { AlertTriangle, CheckCircle2, Download, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { PATIENT_CSV_COLUMNS, PATIENT_CSV_FILE_NAME, buildPatientCsvTemplate, type PatientCsvGroup } from "@shared/patientCsvImport";

type Preview = inferRouterOutputs<AppRouter>["patients"]["csvImportPreview"];
type CommitResult = inferRouterOutputs<AppRouter>["patients"]["csvImportCommit"];

const STATUS_LABEL: Record<PatientCsvGroup["status"], { text: string; className: string }> = {
  new: { text: "New patient", className: "bg-green-100 text-green-800" },
  existing: { text: "Already on dashboard", className: "bg-gray-100 text-gray-700" },
  possible_duplicate: { text: "Possible duplicate", className: "bg-amber-100 text-amber-800" },
  invalid: { text: "Has errors", className: "bg-red-100 text-red-800" },
};

export function downloadPatientCsvTemplate() {
  const blob = new Blob([buildPatientCsvTemplate()], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = PATIENT_CSV_FILE_NAME;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast.success(`${PATIENT_CSV_FILE_NAME} downloaded`);
}

/** Default selection: new patients ticked; possible duplicates need an explicit tick. */
function initialSelection(groups: PatientCsvGroup[]): Set<string> {
  return new Set(groups.filter(g => g.status === "new").map(g => g.key));
}

export function PatientBulkUploadDialog() {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CommitResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const previewMutation = trpc.patients.csvImportPreview.useMutation({
    onSuccess: data => {
      setPreview(data);
      setSelected(initialSelection(data.groups));
    },
    onError: e => toast.error(`Could not read the file: ${e.message}`),
  });
  const commitMutation = trpc.patients.csvImportCommit.useMutation({
    onSuccess: data => {
      setResult(data);
      utils.patients.list.invalidate();
      utils.visits.listByPatient.invalidate();
      utils.visits.authAlerts.invalidate();
      utils.visits.completedPatientIds.invalidate();
      if (data.summary.created > 0) toast.success(`Added ${data.summary.created} patient${data.summary.created === 1 ? "" : "s"}.`);
    },
    // Nothing is lost: saving again is safe, because a patient already saved is never created twice.
    onError: e => toast.error(`Save failed: ${e.message}. You can save again safely.`),
  });

  const reset = () => {
    setFile(null);
    setPreview(null);
    setSelected(new Set());
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    let text: string;
    try {
      text = await f.text();
    } catch {
      toast.error("The file could not be read.");
      return;
    }
    setResult(null);
    setFile({ name: f.name, text });
    previewMutation.mutate({ fileName: f.name, csvText: text });
  };

  const save = () => {
    if (!file || !preview) return;
    const saveable = preview.groups.filter(g => g.status === "new" || g.status === "possible_duplicate");
    commitMutation.mutate({
      fileName: file.name,
      csvText: file.text,
      skipKeys: saveable.filter(g => g.status === "new" && !selected.has(g.key)).map(g => g.key),
      confirmKeys: saveable.filter(g => g.status === "possible_duplicate" && selected.has(g.key)).map(g => g.key),
    });
  };

  const toggle = (key: string, on: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toSave = preview?.groups.filter(g => (g.status === "new" || g.status === "possible_duplicate") && selected.has(g.key)) ?? [];
  const sessionsToSave = toSave.reduce((n, g) => n + g.visits.length, 0);

  return (
    <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) reset(); }}>
      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setOpen(true)} aria-label="Bulk Upload Patients" data-testid="bulk-upload-patients">
        <Upload className="w-4 h-4" />
        <span className="hidden sm:inline">Bulk Upload Patients</span>
      </Button>
      <DialogContent className="w-[calc(100vw-1rem)] max-h-[90vh] overflow-y-auto overflow-x-hidden bg-white sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-brand-blue">Bulk Upload Patients</DialogTitle>
          <DialogDescription>
            Import a patient list from the Patient Data CSV. You review every patient before anything is saved. Patients already on the dashboard are never changed.
          </DialogDescription>
        </DialogHeader>

        {!preview && (
          <div className="space-y-4 min-w-0">
            <div className="border-2 border-dashed border-brand-cream-dark rounded-lg p-6 text-center hover:border-brand-gold transition-colors">
              <input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden" id="patient-csv-upload" data-testid="patient-csv-input"
                onChange={e => onFile(e.target.files?.[0])} />
              <label htmlFor="patient-csv-upload" className="cursor-pointer block">
                {previewMutation.isPending
                  ? <Loader2 className="w-8 h-8 text-brand-gold mx-auto mb-2 animate-spin" />
                  : <Upload className="w-8 h-8 text-brand-gold mx-auto mb-2" />}
                <p className="text-brand-blue font-semibold">{previewMutation.isPending ? "Reading file…" : "Choose a patient CSV"}</p>
              </label>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">Patient Data CSV columns</p>
                <Button size="sm" onClick={downloadPatientCsvTemplate} data-testid="download-patient-template"
                  className="h-auto gap-1.5 bg-brand-blue hover:bg-brand-blue-dark text-white text-xs font-semibold px-3 py-1.5">
                  <Download className="w-3.5 h-3.5" />
                  Download Template
                </Button>
              </div>
              <ul className="space-y-0.5">
                {PATIENT_CSV_COLUMNS.map(c => (
                  <li key={c.field} className="break-words"><span className="font-semibold">{c.headers[0]}</span>{c.required ? " (required)" : ""}: {c.help}</li>
                ))}
              </ul>
              <p>One row per session. Claims, payment and CPT columns are not accepted here.</p>
            </div>
          </div>
        )}

        {preview && !result && (
          <div className="space-y-3 min-w-0">
            <p className="text-xs text-muted-foreground break-all">File: {preview.fileName}</p>
            {preview.fileError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert" data-testid="patient-csv-file-error">
                <AlertTriangle className="inline w-4 h-4 mr-1" />{preview.fileError.message}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4" data-testid="patient-csv-counts">
                  <Count label="New" value={preview.counts.new} />
                  <Count label="Already on dashboard" value={preview.counts.existing} />
                  <Count label="Possible duplicates" value={preview.counts.possibleDuplicate} />
                  <Count label="With errors" value={preview.counts.invalid} />
                </div>
                {preview.ignoredColumns.length > 0 && (
                  <p className="text-xs text-amber-800">Ignored columns: {preview.ignoredColumns.join(", ")}</p>
                )}
                {preview.counts.duplicateLines > 0 && (
                  <p className="text-xs text-amber-800">{preview.counts.duplicateLines} line{preview.counts.duplicateLines === 1 ? "" : "s"} exactly repeat{preview.counts.duplicateLines === 1 ? "s" : ""} an earlier line and will be skipped.</p>
                )}
                <ul className="divide-y rounded-lg border max-h-[45vh] overflow-y-auto" data-testid="patient-csv-groups">
                  {preview.groups.map(g => {
                    const selectable = g.status === "new" || g.status === "possible_duplicate";
                    const label = STATUS_LABEL[g.status];
                    return (
                      <li key={g.key} className="flex gap-3 p-3 text-sm min-w-0">
                        <Checkbox
                          checked={selectable && selected.has(g.key)}
                          disabled={!selectable}
                          onCheckedChange={v => toggle(g.key, v === true)}
                          aria-label={`Import ${g.name || "row"}`}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-brand-blue break-words">{g.name || "(no name)"}</span>
                            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${label.className}`}>{label.text}</span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Line{g.lines.length === 1 ? "" : "s"} {g.lines.join(", ")} · {g.visits.length} session{g.visits.length === 1 ? "" : "s"}
                            {g.insurance ? ` · ${g.insurance}` : ""}{g.authDate ? ` · Auth ${g.authDate}` : ""}
                          </p>
                          {g.status === "existing" && <p className="text-xs text-gray-600">Matches {g.matchedName}. Not changed.</p>}
                          {g.status === "possible_duplicate" && <p className="text-xs text-amber-800">Similar to {g.matchedName}. Tick only if this is a different person.</p>}
                          {g.errors.length > 0 && (
                            <ul className="list-disc pl-4 text-xs text-red-700 space-y-0.5">
                              {g.errors.map((e, i) => <li key={i} className="break-words">{e}</li>)}
                            </ul>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={reset} disabled={commitMutation.isPending}>Choose another file</Button>
              {!preview.fileError && (
                <Button onClick={save} disabled={toSave.length === 0 || commitMutation.isPending} data-testid="patient-csv-save"
                  className="bg-brand-blue hover:bg-brand-blue-dark text-white font-semibold">
                  {commitMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                  Save {toSave.length} patient{toSave.length === 1 ? "" : "s"} ({sessionsToSave} session{sessionsToSave === 1 ? "" : "s"})
                </Button>
              )}
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-3 min-w-0" data-testid="patient-csv-summary">
            {result.fileError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{result.fileError.message}</div>
            ) : (
              <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">
                <CheckCircle2 className="inline w-4 h-4 mr-1" />
                Added {result.summary.created} patient{result.summary.created === 1 ? "" : "s"} with {result.summary.sessionsCreated} session{result.summary.sessionsCreated === 1 ? "" : "s"}.
                {" "}{result.summary.alreadyExists} already on the dashboard, {result.summary.skipped} not selected, {result.summary.invalid} with errors, {result.summary.failed} failed.
              </div>
            )}
            {result.results.some(r => r.outcome !== "created") && (
              <ul className="divide-y rounded-lg border max-h-[40vh] overflow-y-auto text-xs">
                {result.results.filter(r => r.outcome !== "created").map(r => (
                  <li key={r.key} className="p-2 break-words">
                    <span className="font-semibold">{r.name || `Line ${r.lines.join(", ")}`}</span>: {r.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {result.summary.failed > 0 && (
                <Button variant="outline" onClick={save} disabled={commitMutation.isPending}>Try failed patients again</Button>
              )}
              <Button variant="outline" onClick={reset}>Upload another file</Button>
              <Button onClick={() => { setOpen(false); reset(); }} className="bg-brand-blue hover:bg-brand-blue-dark text-white">Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-2">
      <p className="text-lg font-semibold text-brand-blue">{value}</p>
      <p className="text-muted-foreground">{label}</p>
    </div>
  );
}
