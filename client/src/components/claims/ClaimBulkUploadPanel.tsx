/**
 * client/src/components/claims/ClaimBulkUploadPanel.tsx — P4-P27
 *
 * The CMS1500 / Insurance Reimbursement tab inside Bulk Upload. Staff
 * receive these documents as PDFs, so the primary action picks one or more
 * PDFs (multi-page, multi-patient, scanned) and opens the shared review
 * dialog (ClaimImportDialog, bulk document mode — the same extraction,
 * preview and save path as every other claims upload). The P4-P26 CSV
 * template import stays below as the optional alternative.
 *
 * Rendered only for users with Claims access (see Dashboard.tsx); the
 * server gates /api/claims/upload-extract and claims.* independently.
 */
import { useRef } from "react";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { splitPdfFiles } from "@/lib/claimImportReview";
import type { ClaimCsvKind } from "@shared/claimCsvTemplates";
import { ClaimCsvTemplatePanel } from "./ClaimCsvTemplatePanel";

const PDF_COPY: Record<ClaimCsvKind, { action: string; help: string }> = {
  cms1500: {
    action: "Upload CMS1500 PDFs",
    help: "Choose one or more CMS1500 PDFs. Every page is read, including scanned forms, and files with several patients are split by patient. You review every line before anything is saved. Amounts stay blank until the EOB is uploaded.",
  },
  eob: {
    action: "Upload EOB PDFs",
    help: "Choose one or more EOB / remittance PDFs. Payments are matched to service lines that already came from a CMS1500. Unmatched or ambiguous lines wait for your choice, and nothing is saved until you confirm.",
  },
};

export function ClaimBulkUploadPanel({ kind, onPdfs, onCsv }: { kind: ClaimCsvKind; onPdfs: (files: File[]) => void; onCsv: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const copy = PDF_COPY[kind];

  return (
    <div className="space-y-4" data-testid={`claim-bulk-panel-${kind}`}>
      <div className="rounded-lg border-2 border-dashed border-brand-cream-dark p-4 text-center">
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          className="hidden"
          data-testid={`claim-pdf-input-${kind}`}
          onChange={e => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            const { pdfs, rejected } = splitPdfFiles(picked);
            if (rejected.length > 0) toast.error(`${rejected.length} file(s) are not PDFs and were not added: ${rejected.map(f => f.name).join(", ")}`);
            if (pdfs.length > 0) onPdfs(pdfs);
          }}
        />
        <Button className="w-full bg-brand-blue hover:bg-brand-blue-dark text-white sm:w-auto" onClick={() => inputRef.current?.click()} data-testid={`claim-pdf-upload-${kind}`}>
          <FileText className="w-4 h-4 mr-1.5" /> {copy.action}
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">{copy.help}</p>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Optional: import a CSV instead</p>
        <ClaimCsvTemplatePanel kind={kind} onFile={onCsv} />
      </div>
    </div>
  );
}
