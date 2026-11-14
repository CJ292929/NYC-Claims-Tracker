/**
 * server/cms1500Vision.ts — P4-P24
 *
 * Page-aware CMS-1500 extraction for scanned / image-only PDFs (no text
 * layer, so pdftotext/pdfjs return nothing and the regex template cannot
 * run). Uses the app's configured AI provider through invokeLLM.
 *
 * Every page is rendered to a high-resolution image (pdfjs + its bundled
 * canvas) and read in its OWN request, so each page is guaranteed to be
 * looked at and its page number is known, not inferred. Validation against
 * the real supplied scan showed why: handing a vision model the whole
 * image-only PDF at once produced different, partly invented lines on each
 * run. If page rendering is unavailable in the runtime, the reader falls
 * back to the whole-PDF input and checks the answer against the real page
 * count: a skipped page is re-requested once, and still-missing pages are
 * reported, never silently treated as "no lines".
 *
 * The model only transcribes what is printed. Everything that decides
 * meaning — which pages belong to one patient's claim, which Box 21 codes a
 * line's Box 24E pointer refers to, whether the lines add up to Box 28 — is
 * done deterministically in assembleCms1500Pages(), which is unit-tested
 * against synthetic page fixtures.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { invokeLLM } from "./_core/llm";
import { loadPdfjs } from "./pdfjs";
import { ENV } from "./_core/env";
import { assignCms1500LineKeys, groupKeyFor } from "./claimImportKeys";
import { CMS1500_BOX26_SOURCE_SYSTEM, formatModifiers, type Cms1500ImportLine, type ImportGroup, type ImportPatientIdentity } from "@shared/claimImport";
import { fuzzyNameMatch } from "@shared/nameMatch";

// ─── Page transcription shape (what the model returns) ──────────────────────

export interface VisionDiagnosis {
  letter: string; // A-L as printed in Box 21
  code: string | null; // null when unreadable
}

export interface VisionServiceLine {
  row: number | null; // printed Box 24 row 1-6
  dateFrom: string | null; // as printed, e.g. "06 10 26" or "06/10/2026"
  dateTo: string | null;
  placeOfService: string | null;
  cpt: string | null;
  modifiers: string[];
  diagnosisPointer: string | null; // as printed, e.g. "ABCD"
  charge: number | null;
  units: number | null;
  unreadableFields: string[]; // any of: date, placeOfService, cpt, modifiers, diagnosisPointer, charge, units
}

export interface VisionPage {
  pageNumber: number;
  continuationLabel: string | null; // e.g. "continued - page 2 of 3"
  patientName: string | null; // Box 2
  patientDob: string | null; // Box 3
  insuredId: string | null; // Box 1a
  patientAccountNumber: string | null; // Box 26
  claimNumber: string | null; // CIC / claim number printed at the top of the form
  billingNpi: string | null; // Box 33a
  insuredGroupNumber: string | null; // Box 11
  signatureDate: string | null; // Box 31
  totalCharge: number | null; // Box 28 — null when blank on this page
  diagnoses: VisionDiagnosis[];
  lines: VisionServiceLine[];
}

const nullableString = { type: ["string", "null"] } as const;
const nullableNumber = { type: ["number", "null"] } as const;

const PAGE_SCHEMA = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pageNumber: { type: "integer" },
          continuationLabel: nullableString,
          patientName: nullableString,
          patientDob: nullableString,
          insuredId: nullableString,
          patientAccountNumber: nullableString,
          claimNumber: nullableString,
          billingNpi: nullableString,
          insuredGroupNumber: nullableString,
          signatureDate: nullableString,
          totalCharge: nullableNumber,
          diagnoses: {
            type: "array",
            items: {
              type: "object",
              properties: { letter: { type: "string" }, code: nullableString },
              required: ["letter", "code"],
              additionalProperties: false,
            },
          },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                row: { type: ["integer", "null"] },
                dateFrom: nullableString,
                dateTo: nullableString,
                placeOfService: nullableString,
                cpt: nullableString,
                modifiers: { type: "array", items: { type: "string" } },
                diagnosisPointer: nullableString,
                charge: nullableNumber,
                units: nullableNumber,
                unreadableFields: { type: "array", items: { type: "string" } },
              },
              required: ["row", "dateFrom", "dateTo", "placeOfService", "cpt", "modifiers", "diagnosisPointer", "charge", "units", "unreadableFields"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "pageNumber", "continuationLabel", "patientName", "patientDob", "insuredId", "patientAccountNumber",
          "claimNumber", "billingNpi", "insuredGroupNumber", "signatureDate", "totalCharge", "diagnoses", "lines",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["pages"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You transcribe scanned CMS-1500 (NUCC 02/12) health insurance claim forms. The document may be a black-and-white scan with no text layer, may contain several pages, and may contain several different patients' claims. Transcribe exactly what is printed — you do not interpret, total, or fill in anything.

Return exactly one entry in "pages" for EVERY page of the PDF, in order, with pageNumber 1, 2, 3, ... — including pages with no service lines.

For each page:
- continuationLabel: any page footer/header such as "continued - page 2 of 3", verbatim; null if none.
- patientName (Box 2), patientDob (Box 3), insuredId (Box 1a), patientAccountNumber (Box 26), claimNumber (any claim/CIC number printed at the very top of the form), billingNpi (Box 33a), insuredGroupNumber (Box 11), signatureDate (Box 31): verbatim as printed on THIS page; null if blank or unreadable. Never copy a value from another page.
- totalCharge: Box 28 on THIS page as a number; null when Box 28 is blank on this page (continued claims often print it only on the last page).
- diagnoses: every Box 21 entry printed on this page, as { letter, code }, letter A-L exactly as labeled. Use code null for an entry you cannot read. Do not add codes that are not printed.
- lines: every Box 24 service line on this page, top to bottom:
  - row: the printed line number 1-6.
  - dateFrom / dateTo: Box 24A from/to dates exactly as printed (e.g. "06 10 26").
  - placeOfService: Box 24B. cpt: Box 24D procedure code only.
  - modifiers: every Box 24D modifier on that line, in printed order (e.g. ["59", "GP"]). Never drop the second modifier.
  - diagnosisPointer: Box 24E exactly as printed for THAT line (e.g. "ABCD", "ABED", "CEDF"). Never substitute the Box 21 list.
  - charge: Box 24F as a number. units: Box 24G as a number.
  - unreadableFields: list any of date, placeOfService, cpt, modifiers, diagnosisPointer, charge, units you could not read with confidence. Put null (or [] for modifiers) for those values — never guess a value.
- Do not invent lines. Shaded supplemental-information rows above a line are not separate lines.

Return ONLY valid JSON.`;

// ─── Bounded concurrency for vision calls ───────────────────────────────────

// Per server instance. Each page is read twice, so a 3-page scan is 6 calls;
// 4 at a time keeps a 15-page scan (the upload cap) inside the 90 s function limit.
const MAX_CONCURRENT_VISION_CALLS = 4;
export const MAX_SCANNED_PAGES = 15;
let activeVisionCalls = 0;
const visionQueue: Array<() => void> = [];

async function withVisionSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeVisionCalls >= MAX_CONCURRENT_VISION_CALLS) {
    await new Promise<void>(resolve => visionQueue.push(resolve));
  }
  activeVisionCalls++;
  try {
    return await fn();
  } finally {
    activeVisionCalls--;
    visionQueue.shift()?.();
  }
}

function parseVisionPages(content: unknown): VisionPage[] {
  if (typeof content !== "string") throw new Error("No response from AI provider");
  const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
  return Array.isArray(parsed?.pages) ? parsed.pages : [];
}

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "cms1500_pages", strict: true, schema: PAGE_SCHEMA as unknown as Record<string, unknown> },
} as const;

/** Whole-PDF input — the fallback when page rendering is unavailable. */
async function requestPages(buffer: Buffer, filename: string, pageCount: number, onlyPages: number[] | null): Promise<VisionPage[]> {
  const instruction = onlyPages
    ? `This PDF has ${pageCount} page(s). Transcribe ONLY page(s) ${onlyPages.join(", ")}, returning one entry per requested page with its real pageNumber.`
    : `This PDF has ${pageCount} page(s). Transcribe every page, returning exactly ${pageCount} entries in "pages".`;
  const response = await withVisionSlot(() => invokeLLM({
    model: ENV.aiModel,
    max_tokens: 8192,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: instruction },
          { type: "file", file: { filename, file_data: `data:application/pdf;base64,${buffer.toString("base64")}` } },
        ],
      },
    ],
    response_format: RESPONSE_FORMAT,
  }));
  return parseVisionPages(response.choices[0]?.message?.content);
}

/**
 * One rendered page → that page's transcription (the page number is ours,
 * not the model's). The page goes as overlapping horizontal bands at full
 * render resolution, top to bottom: vision APIs downscale a whole page to
 * roughly 768 px on its short side, which is too coarse for CMS-1500 print.
 */
async function requestRenderedPage(bands: Buffer[], pageNumber: number, pageCount: number): Promise<VisionPage | null> {
  const response = await withVisionSlot(() => invokeLLM({
    model: ENV.aiModel,
    max_tokens: 4096,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `These ${bands.length} images are overlapping horizontal strips of page ${pageNumber} of ${pageCount} of a scanned CMS-1500, in order from the top of the page to the bottom. ` +
              `Together they are one page: content in an overlap appears in two strips but is printed once — never transcribe it twice. ` +
              `Return exactly one entry in "pages" for this page, with pageNumber ${pageNumber}.`,
          },
          ...bands.map(png => ({ type: "image_url" as const, image_url: { url: `data:image/png;base64,${png.toString("base64")}`, detail: "high" as const } })),
        ],
      },
    ],
    response_format: RESPONSE_FORMAT,
  }));
  const [page] = parseVisionPages(response.choices[0]?.message?.content);
  return page ? { ...page, pageNumber } : null;
}

/**
 * pdfjs's bundled font data, as a file path it can read. Without it, any page
 * text using a non-embedded standard font (printed form labels, filled form
 * values) renders blank: the image sent to the reader silently loses that text.
 * Packaged for the deployed function by includeFiles in vercel.json.
 *
 * P4-P30: located from legacy/build/pdf.mjs (always packaged, server/pdfjs.ts
 * imports it), not pdfjs-dist/package.json — the file tracer does not package
 * that package.json, so on the deployed function this lookup always failed.
 */
export function standardFontDataUrl(): string | undefined {
  try {
    const lib = createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.mjs");
    return `${path.join(path.dirname(lib), "..", "..", "standard_fonts").replace(/\\/g, "/")}/`;
  } catch {
    console.warn("[CMS1500 Vision] pdfjs standard font data not found; printed text may be missing from rendered pages");
    return undefined;
  }
}

const RENDER_SCALE = 3; // ~216 dpi for a letter-size page
/** Overlapping bands (fractions of page height) — header/Box 21, Box 21-24, Box 24-33. */
const BANDS: Array<[number, number]> = [[0, 0.4], [0.33, 0.73], [0.6, 1]];

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toUpperCase().replace(/\s+/g, " ") === (b ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const sameNumber = (a: number | null | undefined, b: number | null | undefined) =>
  (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.005);

/**
 * Two independent reads of the same page → one transcription in which any
 * value the reads disagree on is blank and flagged, never picked.
 *   - header fields / Box 28 that differ become null;
 *   - a Box 21 letter whose code differs (or is in only one read) becomes
 *     unreadable;
 *   - lines are paired by printed row; each differing field is blanked and
 *     listed in unreadableFields. A row only one read found is kept with
 *     its date and CPT flagged, so it can't be saved without review.
 */
export function reconcilePageReads(a: VisionPage, b: VisionPage): VisionPage {
  const pickText = (x: string | null, y: string | null) => (sameText(x, y) ? x : null);
  const letters = Array.from(new Set([...a.diagnoses, ...b.diagnoses].map(d => d.letter.trim().toUpperCase()))).sort();
  const diagnoses = letters.map(letter => {
    const da = a.diagnoses.find(d => d.letter.trim().toUpperCase() === letter);
    const db = b.diagnoses.find(d => d.letter.trim().toUpperCase() === letter);
    const code = da && db && da.code && sameText(da.code.replace(/\s/g, ""), (db.code ?? "").replace(/\s/g, "")) ? da.code : null;
    return { letter, code };
  });

  const rowsA = new Map(a.lines.map((l, i) => [l.row ?? -(i + 1), l]));
  const rowsB = new Map(b.lines.map((l, i) => [l.row ?? -(i + 1), l]));
  const rows = Array.from(new Set(Array.from(rowsA.keys()).concat(Array.from(rowsB.keys())))).sort((x, y) => Math.abs(x) - Math.abs(y));
  const lines: VisionServiceLine[] = rows.map(row => {
    const la = rowsA.get(row), lb = rowsB.get(row);
    if (!la || !lb) {
      const only = (la ?? lb)!;
      return { ...only, unreadableFields: Array.from(new Set([...only.unreadableFields, "date", "cpt"])) };
    }
    const flags = new Set([...la.unreadableFields, ...lb.unreadableFields]);
    if (!sameText(la.dateFrom, lb.dateFrom) || !sameText(la.dateTo, lb.dateTo)) flags.add("date");
    if (!sameText(la.placeOfService, lb.placeOfService)) flags.add("placeOfService");
    if (!sameText(la.cpt, lb.cpt)) flags.add("cpt");
    if (!sameText([...la.modifiers].map(m => m.trim().toUpperCase()).sort().join(","), [...lb.modifiers].map(m => m.trim().toUpperCase()).sort().join(","))) flags.add("modifiers");
    if (!sameText(la.diagnosisPointer?.replace(/[\s,]/g, ""), lb.diagnosisPointer?.replace(/[\s,]/g, ""))) flags.add("diagnosisPointer");
    if (!sameNumber(la.charge, lb.charge)) flags.add("charge");
    if (!sameNumber(la.units, lb.units)) flags.add("units");
    return { ...la, unreadableFields: Array.from(flags) };
  });

  return {
    pageNumber: a.pageNumber,
    continuationLabel: pickText(a.continuationLabel, b.continuationLabel),
    // Two spellings of one name (e.g. a dropped middle initial) are the same
    // person by the app's own safe name rule; anything else is unreadable.
    patientName: a.patientName && b.patientName && fuzzyNameMatch(a.patientName, b.patientName) ? a.patientName : null,
    patientDob: pickText(a.patientDob, b.patientDob),
    insuredId: pickText(a.insuredId, b.insuredId),
    patientAccountNumber: pickText(a.patientAccountNumber, b.patientAccountNumber),
    claimNumber: pickText(a.claimNumber, b.claimNumber),
    billingNpi: pickText(a.billingNpi, b.billingNpi),
    insuredGroupNumber: pickText(a.insuredGroupNumber, b.insuredGroupNumber),
    signatureDate: pickText(a.signatureDate, b.signatureDate),
    totalCharge: sameNumber(a.totalCharge, b.totalCharge) ? a.totalCharge : null,
    diagnoses,
    lines,
  };
}

/** Reads a rendered page twice, independently, and reconciles the two reads. */
async function readRenderedPage(bands: Buffer[], pageNumber: number, pageCount: number): Promise<VisionPage | null> {
  const [first, second] = await Promise.all([
    requestRenderedPage(bands, pageNumber, pageCount),
    requestRenderedPage(bands, pageNumber, pageCount),
  ]);
  if (!first || !second) return null;
  return reconcilePageReads(first, second);
}

/** Renders every page and cuts it into BANDS (PNG each), or returns null when no canvas backend is available. */
export async function renderPdfPages(buffer: Buffer): Promise<Buffer[][] | null> {
  try {
    const pdfjsLib = await loadPdfjs();
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), standardFontDataUrl: standardFontDataUrl() }).promise;
    const factory = (doc as unknown as { canvasFactory?: { create(w: number, h: number): { canvas: any; context: any } } }).canvasFactory;
    if (!factory) return null;
    const out: Buffer[][] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
      const full = factory.create(width, height);
      await page.render({ canvasContext: full.context, viewport, canvas: full.canvas } as any).promise;
      out.push(BANDS.map(([from, to]) => {
        const y = Math.floor(height * from), h = Math.ceil(height * (to - from));
        const band = factory.create(width, h);
        band.context.drawImage(full.canvas, 0, y, width, h, 0, 0, width, h);
        return band.canvas.toBuffer("image/png");
      }));
    }
    return out;
  } catch (err) {
    console.warn("[CMS1500 Vision] Page rendering unavailable, using whole-PDF input:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Transcribes every page: one rendered image per page when possible
 * (bounded concurrency), otherwise the whole PDF. A page that fails or is
 * skipped is re-requested once; any still missing are listed in
 * missingPages so the caller reports them instead of treating the file as
 * fully read.
 */
export async function extractCms1500PagesWithVision(
  buffer: Buffer,
  filename: string,
  pageCount: number,
  /** P4-P28: pages to read; the rest were already read from form fields. Default: every page. */
  onlyPages: number[] = range(pageCount)
): Promise<{ pages: VisionPage[]; missingPages: number[]; method: "rendered_pages" | "whole_pdf" }> {
  const byPage = new Map<number, VisionPage>();
  const rendered = await renderPdfPages(buffer);
  if (rendered && rendered.length === pageCount) {
    const results = await Promise.allSettled(onlyPages.map(n => readRenderedPage(rendered[n - 1], n, pageCount)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value) byPage.set(onlyPages[i], r.value);
      else if (r.status === "rejected") console.warn(`[CMS1500 Vision] Page ${onlyPages[i]} failed:`, r.reason instanceof Error ? r.reason.message : r.reason);
    });
    if (byPage.size === 0) throw new Error("No page of the scan could be read");
    for (const n of onlyPages.filter(p => !byPage.has(p))) {
      try {
        const page = await readRenderedPage(rendered[n - 1], n, pageCount);
        if (page) byPage.set(n, page);
      } catch (err) {
        console.warn(`[CMS1500 Vision] Page ${n} retry failed:`, err instanceof Error ? err.message : err);
      }
    }
    const missingPages = onlyPages.filter(n => !byPage.has(n));
    return { pages: Array.from(byPage.values()).sort((a, b) => a.pageNumber - b.pageNumber), missingPages, method: "rendered_pages" };
  }

  const accept = (pages: VisionPage[]) => {
    for (const p of pages) {
      if (Number.isInteger(p.pageNumber) && onlyPages.includes(p.pageNumber) && !byPage.has(p.pageNumber)) {
        byPage.set(p.pageNumber, p);
      }
    }
  };
  accept(await requestPages(buffer, filename, pageCount, onlyPages.length === pageCount ? null : onlyPages));
  let missing = onlyPages.filter(n => !byPage.has(n));
  if (missing.length > 0) {
    console.warn(`[CMS1500 Vision] First pass returned ${byPage.size}/${pageCount} pages; re-requesting page(s) ${missing.join(", ")}`);
    accept(await requestPages(buffer, filename, pageCount, missing));
    missing = onlyPages.filter(n => !byPage.has(n));
  }
  return { pages: Array.from(byPage.values()).sort((a, b) => a.pageNumber - b.pageNumber), missingPages: missing, method: "whole_pdf" };
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

// ─── Deterministic assembly ─────────────────────────────────────────────────

const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
};
const ident = (v: string | null | undefined): string | null => {
  const s = clean(v);
  return s ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") || null : null;
};
const nameKey = (v: string | null | undefined): string | null => {
  const s = clean(v);
  return s ? s.toUpperCase().replace(/[^A-Z]+/g, " ").trim() || null : null;
};

/** "06 10 26", "06/10/2026", "061026" → "2026-06-10"; anything else → null. */
export function parseFormDate(raw: string | null | undefined): string | null {
  const s = clean(raw);
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, " ").trim().split(/\s+/);
  let mm: string, dd: string, yy: string;
  if (digits.length === 3) [mm, dd, yy] = digits;
  else if (digits.length === 1 && (digits[0].length === 6 || digits[0].length === 8)) {
    mm = digits[0].slice(0, 2); dd = digits[0].slice(2, 4); yy = digits[0].slice(4);
  } else return null;
  const m = parseInt(mm, 10), d = parseInt(dd, 10);
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const year = yy.length === 2 ? 2000 + parseInt(yy, 10) : yy.length === 4 ? parseInt(yy, 10) : NaN;
  if (!Number.isFinite(year)) return null;
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Box 24E pointer → letters. Older forms print digit pointers ("1234" =
 *  1,2,3,4), so each digit maps to one letter (1 → A). Anything else → null. */
export function pointerLetters(raw: string | null | undefined): string[] | null {
  const s = clean(raw);
  if (!s) return null;
  const letters: string[] = [];
  for (const t of s.toUpperCase().replace(/[\s,]+/g, "")) {
    if (/^[A-L]$/.test(t)) letters.push(t);
    else if (/^[1-9]$/.test(t)) letters.push(String.fromCharCode(64 + parseInt(t, 10)));
    else return null;
  }
  return letters.length > 0 && letters.length <= 4 ? letters : null;
}

/** Strong identifiers shared by every page of one claim (when printed). */
function pageIdentity(p: VisionPage) {
  return {
    name: nameKey(p.patientName),
    insuredId: ident(p.insuredId),
    account: ident(p.patientAccountNumber),
    claim: ident(p.claimNumber),
    dob: parseFormDate(p.patientDob),
  };
}

function samePatientClaim(a: ReturnType<typeof pageIdentity>, b: ReturnType<typeof pageIdentity>): boolean {
  if (!a.name || !b.name || !fuzzyNameMatch(a.name, b.name)) return false;
  let sharedStrong = 0;
  for (const k of ["insuredId", "account", "claim", "dob"] as const) {
    if (a[k] && b[k]) {
      if (a[k] !== b[k]) return false;
      sharedStrong++;
    }
  }
  return sharedStrong > 0;
}

/** Box 3 as evidence: a two-digit year is not trusted (06 10 38 must not become 2038), nor a future date. */
export function parseFormBirthDate(raw: string | null | undefined): string | null {
  const iso = parseFormDate(raw);
  if (!iso) return null;
  const digits = (clean(raw) ?? "").replace(/[^0-9]/g, " ").trim().split(/\s+/);
  const year = digits.length === 3 ? digits[2] : digits[0].slice(4);
  if (year.length !== 4) return null;
  return iso > new Date().toISOString().slice(0, 10) ? null : iso;
}

export interface AssembledCms1500 {
  groups: ImportGroup<Cms1500ImportLine>[];
  warnings: string[];
}

/** Box 26 / Box 3 as identity evidence. A form can print a per-claim account number, so Box 26 is never decisive alone. */
function patientIdentityFor(pages: VisionPage[]): ImportPatientIdentity | null {
  const externalId = pages.map(p => clean(p.patientAccountNumber)).find(Boolean) ?? null;
  const birthDate = pages.map(p => parseFormBirthDate(p.patientDob)).find(Boolean) ?? null;
  if (!externalId && !birthDate) return null;
  return { sourceSystem: CMS1500_BOX26_SOURCE_SYSTEM, externalId, strength: "account", birthDate };
}

/**
 * Pages → patient claim groups.
 *   - A page joins the previous group only when the patient name AND at
 *     least one strong identifier (insured id, account #, claim #, DOB)
 *     match, and no identifier printed on both pages differs. Adjacency
 *     alone never merges pages, and a page whose patient cannot be read is
 *     its own unassigned group (patientName null) — never attached to a
 *     neighbor.
 *   - Box 21 is merged per group; a letter printed with two different codes
 *     on different pages is treated as unreadable.
 *   - Each line's diagnosis codes are resolved from ITS OWN pointer, in
 *     pointer order. Any letter that cannot be resolved leaves the line's
 *     diagnosisCodes null and flags it.
 *   - Box 28 (often only on the last page) is checked against the sum of
 *     the line charges; a mismatch or an unreadable charge is a warning.
 *     Charges are never persisted.
 */
export function assembleCms1500Pages(pages: VisionPage[], pageCount: number, missingPages: number[] = []): AssembledCms1500 {
  const warnings: string[] = [];
  if (missingPages.length > 0) {
    warnings.push(`Page(s) ${missingPages.join(", ")} of ${pageCount} could not be read. Lines on those pages are not included — re-upload or enter them manually.`);
  }

  type Building = { pages: VisionPage[]; identity: ReturnType<typeof pageIdentity> };
  const building: Building[] = [];
  for (const page of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    const id = pageIdentity(page);
    const prev = building[building.length - 1];
    if (prev && prev.identity.name && samePatientClaim(prev.identity, id)) {
      prev.pages.push(page);
      for (const k of ["insuredId", "account", "claim", "dob"] as const) prev.identity[k] = prev.identity[k] ?? id[k];
    } else {
      building.push({ pages: [page], identity: id });
    }
  }

  const groups: ImportGroup<Cms1500ImportLine>[] = building.map((b, gi) => {
    const groupWarnings: string[] = [];
    const pageNums = b.pages.map(p => p.pageNumber);
    const patientName = b.identity.name ? clean(b.pages.find(p => clean(p.patientName))?.patientName) : null;
    if (!patientName) {
      groupWarnings.push(`Page(s) ${pageNums.join(", ")}: the patient could not be identified, so these pages were not merged with any other page. Confirm the patient before saving.`);
    } else if (!b.identity.insuredId && !b.identity.account && !b.identity.claim && !b.identity.dob) {
      groupWarnings.push(`Page(s) ${pageNums.join(", ")}: no insured ID, account number, claim number, or date of birth was readable, so these pages were kept separate from neighboring pages.`);
    }

    // Box 21, merged across the group's pages.
    const dx = new Map<string, string | null>();
    for (const p of b.pages) {
      for (const d of p.diagnoses ?? []) {
        const letter = (d.letter ?? "").trim().toUpperCase();
        if (!/^[A-L]$/.test(letter)) continue;
        const code = clean(d.code)?.toUpperCase().replace(/\s+/g, "") ?? null;
        if (!dx.has(letter)) dx.set(letter, code);
        else if (dx.get(letter) !== code) {
          dx.set(letter, null);
          groupWarnings.push(`Box 21 ${letter} reads differently on different pages — treated as unreadable.`);
        }
      }
    }

    const signature = b.pages.map(p => parseFormDate(p.signatureDate)).find(Boolean) ?? null;
    const groupNumber = b.pages.map(p => clean(p.insuredGroupNumber)).find(Boolean) ?? null;

    const lines: Array<Omit<Cms1500ImportLine, "sourceLineKey">> = [];
    for (const p of b.pages) {
      for (const l of p.lines ?? []) {
        const unreadable = new Set((l.unreadableFields ?? []).map(f => String(f)));
        const notes: string[] = [];
        const dateOfService = unreadable.has("date") ? null : parseFormDate(l.dateFrom);
        const dateTo = unreadable.has("date") ? null : parseFormDate(l.dateTo);
        const flagged: string[] = [];
        if (!dateOfService) flagged.push("dateOfService");
        if (dateTo && dateOfService && dateTo !== dateOfService) notes.push(`Box 24A spans ${dateOfService} to ${dateTo}.`);
        const cpt = unreadable.has("cpt") ? null : clean(l.cpt)?.toUpperCase() ?? null;
        if (!cpt || !/^[A-Z0-9]{5}$/.test(cpt)) flagged.push("cptCodes");
        const modifiers = unreadable.has("modifiers") ? null : formatModifiers(l.modifiers ?? []);
        if (unreadable.has("modifiers")) flagged.push("modifier");
        let units: number | null = unreadable.has("units") ? null : l.units;
        if (units != null && !(Number.isInteger(units) && units > 0 && units < 1000)) units = null;
        if (units == null) flagged.push("unitsBilled");

        const letters = unreadable.has("diagnosisPointer") ? null : pointerLetters(l.diagnosisPointer);
        let diagnosisCodes: string | null = null;
        if (!letters) {
          flagged.push("diagnosisCodes");
          if (clean(l.diagnosisPointer)) notes.push(`Diagnosis pointer "${clean(l.diagnosisPointer)}" could not be read.`);
        } else {
          const codes: string[] = [];
          const unresolved: string[] = [];
          for (const letter of letters) {
            const code = dx.get(letter);
            if (code) { if (!codes.includes(code)) codes.push(code); }
            else unresolved.push(letter);
          }
          if (unresolved.length > 0) {
            flagged.push("diagnosisCodes");
            notes.push(`Pointer ${letters.join("")}: Box 21 ${unresolved.join(", ")} is missing or unreadable.`);
          } else {
            diagnosisCodes = codes.join(", ");
          }
        }
        const pos = unreadable.has("placeOfService") ? null : clean(l.placeOfService);
        if (unreadable.has("placeOfService")) flagged.push("placeOfService");
        const charge = unreadable.has("charge") ? null : (typeof l.charge === "number" && Number.isFinite(l.charge) ? l.charge : null);

        lines.push({
          page: p.pageNumber,
          slot: Number.isInteger(l.row) && (l.row as number) >= 1 && (l.row as number) <= 6 ? (l.row as number) : null,
          dateOfService,
          placeOfService: pos,
          cptCodes: flagged.includes("cptCodes") ? null : cpt,
          modifier: modifiers,
          unitsBilled: units,
          diagnosisPointer: letters ? letters.join("") : clean(l.diagnosisPointer),
          diagnosisCodes,
          claimSubmittedDate: signature,
          insuranceBilled: groupNumber,
          lineChargeForValidation: charge,
          unreadable: Array.from(new Set(flagged)),
          notes: notes.length > 0 ? notes.join(" ") : null,
        });
      }
    }

    // Box 28 check — the last page that prints it wins (continued claims
    // usually print it only on the last page).
    const total = [...b.pages].reverse().map(p => p.totalCharge).find(t => typeof t === "number" && Number.isFinite(t)) ?? null;
    if (total != null) {
      if (lines.some(l => l.lineChargeForValidation == null)) {
        groupWarnings.push(`Box 28 total $${total.toFixed(2)} could not be verified: at least one line charge is unreadable.`);
      } else {
        const sum = lines.reduce((s, l) => s + (l.lineChargeForValidation ?? 0), 0);
        if (Math.abs(sum - total) > 0.004) {
          groupWarnings.push(`Line charges add up to $${sum.toFixed(2)} but Box 28 shows $${total.toFixed(2)} — a line may be missing or misread. Review before saving.`);
        }
      }
    } else if (lines.length > 0) {
      groupWarnings.push("Box 28 total charge was not readable on any page, so the line count could not be cross-checked.");
    }

    const flaggedCount = lines.filter(l => l.unreadable.length > 0).length;
    if (flaggedCount > 0) groupWarnings.push(`${flaggedCount} line(s) have unreadable values left blank — review the flagged cells.`);

    const groupKey = groupKeyFor(
      `cms1500-scan:${b.identity.name ?? "unidentified"}:${b.identity.insuredId ?? ""}:${b.identity.account ?? ""}:${b.identity.claim ?? ""}:${patientName ? "" : `p${pageNums[0]}`}:${gi}`
    );
    return {
      groupKey,
      patientName,
      pages: pageNums,
      claimIdentifier: b.pages.map(p => clean(p.patientAccountNumber) ?? clean(p.claimNumber)).find(Boolean) ?? null,
      lines: assignCms1500LineKeys(groupKey, lines),
      warnings: groupWarnings,
      unresolvedClaimTotals: [],
      patientIdentity: patientIdentityFor(b.pages),
    };
  });

  return { groups, warnings };
}
