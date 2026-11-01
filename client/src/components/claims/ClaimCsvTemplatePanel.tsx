/**
 * client/src/components/claims/ClaimCsvTemplatePanel.tsx — P4-P26
 *
 * One claims CSV option inside Bulk Upload (CMS1500 or Insurance
 * Reimbursement): its own upload button, its own Download CSV Template, and
 * the field help — all rendered from shared/claimCsvTemplates.ts, the same
 * definitions the server parser validates against. Rendered only for users
 * with Claims access (see Dashboard.tsx); the server gates the import
 * procedures independently.
 */
import { useRef } from "react";
import { Download, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  CLAIM_CSV_TEMPLATES,
  CMS1500_EXPORT_REQUIRED,
  CSV_DATE_FORMATS,
  CSV_MONEY_FORMAT,
  buildClaimCsvTemplate,
  type ClaimCsvKind,
} from "@shared/claimCsvTemplates";

export function downloadClaimCsvTemplate(kind: ClaimCsvKind) {
  const t = CLAIM_CSV_TEMPLATES[kind];
  const blob = new Blob([buildClaimCsvTemplate(kind)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = t.fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast.success(`${t.fileName} downloaded`);
}

export function ClaimCsvTemplatePanel({ kind, onFile }: { kind: ClaimCsvKind; onFile: (file: File) => void }) {
  const t = CLAIM_CSV_TEMPLATES[kind];
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = `claim-csv-${kind}`;
  const hasMoney = t.fields.some(f => f.type === "money");

  return (
    <div className="space-y-3" data-testid={`claim-csv-panel-${kind}`}>
      <p className="text-xs text-muted-foreground">
        {kind === "cms1500"
          ? "Use the billing system's invoice export as it is, or this app's CMS1500 CSV template. You review every line and patient before anything is saved. Import this before the Insurance Reimbursement CSV."
          : t.notes[0]}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onFile(file);
          }}
        />
        <Button className="h-auto min-h-9 min-w-0 shrink flex-1 basis-56 whitespace-normal py-2 bg-brand-blue hover:bg-brand-blue-dark text-white" onClick={() => inputRef.current?.click()}>
          <Upload className="w-4 h-4 mr-1.5" /> Import CSV
        </Button>
        <Button variant="outline" className="h-auto min-h-9 min-w-0 shrink flex-1 basis-56 whitespace-normal py-2" onClick={() => downloadClaimCsvTemplate(kind)}>
          <Download className="w-4 h-4 mr-1.5" /> Download CSV Template
        </Button>
      </div>
      <p className="break-all text-[11px] text-muted-foreground">Template file: <span className="font-mono">{t.fileName}</span></p>
      {kind === "cms1500" && (
        <p className="text-[11px] text-muted-foreground">
          Invoice export needs: {CMS1500_EXPORT_REQUIRED.join(", ")}. patient_guid and Birth Date are used to match patients; Total and Balance are never imported as payments.
        </p>
      )}

      <details className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
        <summary className="cursor-pointer font-semibold">Template fields and formats</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {t.notes.slice(1).map((n, i) => <li key={i}>{n}</li>)}
          <li>Dates: {CSV_DATE_FORMATS}.</li>
          {hasMoney && <li>Amounts: {CSV_MONEY_FORMAT}</li>}
        </ul>
        <div className="mt-2 max-h-64 overflow-y-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-blue-200">
                <th className="py-1 pr-2 font-semibold">Column</th>
                <th className="py-1 font-semibold">What to enter</th>
              </tr>
            </thead>
            <tbody>
              {t.fields.map(f => (
                <tr key={f.header} className="border-b border-blue-100 align-top">
                  <td className="py-1 pr-2">
                    <span className="font-mono break-all">{f.header}</span>
                    <span className={`ml-1 whitespace-nowrap rounded px-1 text-[10px] ${f.required ? "bg-red-100 text-red-800" : "bg-white text-blue-800"}`}>
                      {f.required ? "required" : "optional"}
                    </span>
                  </td>
                  <td className="py-1">{f.help}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
