/**
 * server/fixtures/cms1500ExportSynthetic.ts — P4-P28
 *
 * Invented data in the exact shape of the billing system's invoice export:
 * the same 17 headers, one row per invoice, and a quoted multiline Description
 * holding a payer line, service blocks with their diagnosis lines, and a
 * coinsurance line. Every name, id, date and amount here is made up.
 */
export const EXPORT_HEADER = "Invoice Date(s),Service Date(s),patient_guid,Patient,Staff Member,Invoice #,Claim,Adjuster,Adjuster Phone,Adjuster Email,Description,Personal Health Number,Birth Date,Date of Injury,Employer,Total,Balance";

export function exportRow(r: {
  invoiceDate?: string;
  serviceDate?: string;
  guid?: string;
  patient?: string;
  invoice: string;
  birthDate?: string;
  description?: string;
  total?: string;
  balance?: string;
}): string {
  const description = r.description ?? `Synthetic Health Plan #SYN000 / 00000
1x 97530 - Therapeutic activities ($175.00)
M54.50, M25.561
1x 97530 - Therapeutic activities ($175.00)
M54.50, M25.561
1x 97112 - Neuromuscular reeducation ($175.00)
M54.50
Coinsurance: $350.00`;
  return [
    r.invoiceDate ?? "2026-02-20",
    r.serviceDate ?? "2026-02-02",
    r.guid ?? "S1001-1",
    `"${r.patient ?? "Alex Testpatient"}"`,
    "Synthetic Therapist",
    r.invoice,
    `"Synthetic Advantage (Synthetic Health) #SYN000 / 00000"`,
    "", "", "",
    `"${description.replace(/"/g, '""')}"`,
    "",
    r.birthDate ?? "1950-03-14",
    "", "",
    r.total ?? "350.0",
    r.balance ?? "350.0",
  ].join(",");
}

export const exportCsv = (...rows: string[]) => [EXPORT_HEADER, ...rows].join("\n") + "\n";
