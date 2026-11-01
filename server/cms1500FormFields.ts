/**
 * server/cms1500FormFields.ts — P4-P28
 *
 * Reads fillable (AcroForm) CMS-1500 PDFs from their form fields. In these
 * files the page's text layer holds only the printed form labels; every
 * patient and service value lives in a form field, so a text parser finds no
 * service lines at all, and two different patients' forms have identical text.
 *
 * The values are read exactly as entered, with no AI, and handed to the same
 * deterministic assembly as a scan (assembleCms1500Pages), so grouping, Box 24E
 * pointer resolution and the Box 28 check do not depend on how a page was read.
 *
 * Field names are the NUCC fillable form's: pt_name, birth_mm/dd/yy,
 * insurance_id, pt_account, ins_policy, physician_date, t_charge,
 * diagnosis1-12, and per Box 24 row n (1-6) sv<n>_mm_from .. sv<n>_yy_end,
 * place<n>, cpt<n>, mod<n>, mod<n>a-c, diag<n>, ch<n>, day<n>.
 */
import type { VisionPage, VisionServiceLine } from "./cms1500Vision";

const ROWS = [1, 2, 3, 4, 5, 6];

/** A page's Tx field values by name. Duplicates keep the first non-empty value. */
export type FormFieldValues = Map<string, string>;

export function collectTextFields(annotations: Array<{ fieldType?: string; fieldName?: string; fieldValue?: unknown }>): FormFieldValues {
  const fields: FormFieldValues = new Map();
  for (const a of annotations) {
    if (a.fieldType !== "Tx" || !a.fieldName || typeof a.fieldValue !== "string") continue;
    const value = a.fieldValue.trim();
    if (value && !fields.has(a.fieldName)) fields.set(a.fieldName, value);
  }
  return fields;
}

function moneyOf(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function datePart(fields: FormFieldValues, mm: string, dd: string, yy: string): string | null {
  const parts = [fields.get(mm), fields.get(dd), fields.get(yy)];
  return parts.every(Boolean) ? parts.join(" ") : null;
}

/** One page's fields → the page shape assembleCms1500Pages takes, or null when the page has no CMS-1500 values. */
export function formFieldsToPage(fields: FormFieldValues, pageNumber: number): VisionPage | null {
  const lines: VisionServiceLine[] = [];
  for (const n of ROWS) {
    const dateFrom = datePart(fields, `sv${n}_mm_from`, `sv${n}_dd_from`, `sv${n}_yy_from`);
    const cpt = fields.get(`cpt${n}`) ?? null;
    if (!cpt && !dateFrom) continue;
    const rawUnits = fields.get(`day${n}`);
    const units = rawUnits && /^\d+(\.0+)?$/.test(rawUnits) ? Number(rawUnits) : null;
    lines.push({
      row: n,
      dateFrom,
      dateTo: datePart(fields, `sv${n}_mm_end`, `sv${n}_dd_end`, `sv${n}_yy_end`),
      placeOfService: fields.get(`place${n}`) ?? null,
      cpt,
      modifiers: [`mod${n}`, `mod${n}a`, `mod${n}b`, `mod${n}c`].map(k => fields.get(k)).filter((m): m is string => !!m),
      diagnosisPointer: fields.get(`diag${n}`) ?? null,
      charge: moneyOf(fields.get(`ch${n}`)),
      units,
      unreadableFields: [],
    });
  }
  const patientName = fields.get("pt_name") ?? null;
  if (lines.length === 0 && !patientName) return null;

  const diagnoses = Array.from({ length: 12 }, (_, i) => ({ letter: String.fromCharCode(65 + i), code: fields.get(`diagnosis${i + 1}`) ?? null }))
    .filter(d => d.code);
  return {
    pageNumber,
    continuationLabel: null,
    patientName,
    patientDob: datePart(fields, "birth_mm", "birth_dd", "birth_yy"),
    insuredId: fields.get("insurance_id") ?? null,
    patientAccountNumber: fields.get("pt_account") ?? null,
    claimNumber: null,
    billingNpi: fields.get("pin") ?? null,
    insuredGroupNumber: fields.get("ins_policy") ?? null,
    signatureDate: fields.get("physician_date") ?? null,
    totalCharge: moneyOf(fields.get("t_charge")),
    diagnoses,
    lines,
  };
}

/**
 * Every page's filled form values. A page with no CMS-1500 values is left out,
 * so the caller can read just those pages another way. Returns an empty list
 * for a PDF with no filled fields (a flat text PDF or a scan) or one pdfjs
 * cannot open.
 */
export async function readCms1500FormPages(buffer: Buffer): Promise<VisionPage[]> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: VisionPage[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const annotations = await (await pdf.getPage(i)).getAnnotations();
      const page = formFieldsToPage(collectTextFields(annotations as any), i);
      if (page) pages.push(page);
    }
    return pages;
  } catch (err) {
    console.warn("[CMS1500 Form] Could not read form fields:", err instanceof Error ? err.message : err);
    return [];
  }
}
