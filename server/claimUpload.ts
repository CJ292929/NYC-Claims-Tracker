/**
 * server/claimUpload.ts
 * POST /api/claims/upload-extract
 *
 * Accepts a PDF, CSV, or Excel (.xlsx/.xls) file upload, extracts text/rows,
 * then uses the LLM to map the content to the Claims Tracker columns.
 *
 * Returns an array of partial ClaimRecord objects for staff to review before saving.
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { invokeLLM } from './_core/llm';
import { ENV } from './_core/env';
import { requireAuthenticatedUser } from './_core/requireAuth';
import { tryTemplateExtraction, parseCMS1500, PatientBoundaryError, type ExtractedClaim, type PatientClaimGroup } from './insuranceTemplates';
import { extractClaimsWithAI, detectInsuranceType, KNOWN_INSURER_NAMES, type ExtractionSource } from './aiClaimExtractor';

// requireAuthenticatedUser (server/_core/requireAuth.ts) runs before multer
// so an unauthenticated request never reaches file parsing, template
// extraction, or any AI/LLM call.

// Fields the regex/template parsers are known to leave null for some document
// layouts (Meritain EOBs never print these at all; CMS1500's layout-dependent
// regex can miss them depending on how a given PDF renderer positions text).
// When any of these are missing after the fast template pass, we run one
// supplementary AI vision/text pass and use it ONLY to fill the gaps —
// dollar amounts and claim numbers stay sourced from the regex parser, which
// is more precise for those than an LLM.
//
// Each upload type has its own backfill list. Payment-only fields
// (insuranceReimbursement, oaClaimNumber, checkDate, ...) and CMS-1500-only
// form fields (placeOfService, claimSubmittedDate, visitNumber) stay scoped
// to the upload type that can actually carry them — backfilling those across
// the boundary would waste an AI call for a value enforceFieldBoundary would
// strip right back out before saving. Billing-detail fields (chargeAmount,
// diagnosisCodes, modifier, unitsBilled) appear in BOTH lists since both a
// CMS-1500 form and an EOB's own line-item table can legitimately print them
// — see the comment on CMS1500_ONLY_FIELDS below.
//
// Each list is further split into claim-level vs. line-level fields.
// parseCMS1500/parseMeritainEOB group service lines under a shared date via
// DateClaimGroup.cptLines[] (server/insuranceTemplates.ts) — per-CPT-line
// data (cptCodes, chargeAmount, unitsBilled, modifier, diagnosisCodes,
// insuranceReimbursement, patientAmountPaid, patientAmountDue) only ever
// lives in cptLines, never on the DateClaimGroup object itself, and
// bulkImportFromEOB (server/routers.ts) reads line.* — not claim.* — for
// those fields when saving. Checking/backfilling only the claim-level object
// silently misses them entirely.
const CMS1500_CLAIM_FIELDS_TO_BACKFILL: (keyof ExtractedClaim)[] = [
  'placeOfService',
  'diagnosisCodes',
  'claimSubmittedDate',
  // visitNumber lives on the DateClaimGroup itself (bulkImportFromEOB reads
  // claim.visitNumber, not line.visitNumber — see server/routers.ts), so it
  // belongs in the claim-level list, not the line-level one below.
  'visitNumber',
];
const CMS1500_LINE_FIELDS_TO_BACKFILL: (keyof ExtractedClaim)[] = [
  'cptCodes',
  'chargeAmount',
  'unitsBilled',
  'modifier',
  'diagnosisCodes',
];

const REIMBURSEMENT_CLAIM_FIELDS_TO_BACKFILL: (keyof ExtractedClaim)[] = [
  'oaClaimNumber',
  'checkDate',
  'checkNumberVirtualCard',
];
const REIMBURSEMENT_LINE_FIELDS_TO_BACKFILL: (keyof ExtractedClaim)[] = [
  'insuranceReimbursement',
  'patientAmountPaid',
  'patientAmountDue',
  // Line-item billing detail (Billed Amount / DX / Modifier / Quantity) that
  // many EOBs print alongside the payment columns in their own "Line Level
  // Information" table — no longer CMS1500-exclusive, see the comment on
  // CMS1500_ONLY_FIELDS below.
  'chargeAmount',
  'diagnosisCodes',
  'modifier',
  'unitsBilled',
];

/** A partial ExtractedClaim that may carry a DateClaimGroup-style cptLines[] array. */
type ClaimWithLines = ExtractedClaim & { cptLines?: Array<Record<string, unknown>> };

function hasMissingFields(
  claims: ClaimWithLines[],
  claimFields: (keyof ExtractedClaim)[],
  lineFields: (keyof ExtractedClaim)[]
): boolean {
  return claims.some(claim => {
    if (claimFields.some(field => claim[field] === null || claim[field] === undefined)) return true;
    const lines = claim.cptLines;
    if (lines === undefined) return false; // flat claim (no line-level structure) — claim-level check above is authoritative
    if (lines.length === 0) return lineFields.length > 0; // date group found but zero service lines extracted
    return lines.some(line => lineFields.some(field => line[field] === null || line[field] === undefined));
  });
}

// Mutates `claims` in place so it stays in sync with any other array (e.g.
// patientGroups) that references the same claim objects.
function backfillMissingFields(
  claims: ClaimWithLines[],
  aiClaims: ExtractedClaim[],
  claimFields: (keyof ExtractedClaim)[],
  lineFields: (keyof ExtractedClaim)[]
): void {
  claims.forEach((claim, i) => {
    // Every AI claim sharing this claim's date of service — a date group can
    // have several CPT lines, and each corresponds to its own AI-extracted
    // claim object, so matching must consider all of them, not just one.
    const dateMatches = aiClaims.filter(a => a.dateOfService === claim.dateOfService);
    const claimMatch = dateMatches[0] ?? aiClaims[i];
    if (claimMatch) {
      for (const field of claimFields) {
        if ((claim[field] === null || claim[field] === undefined) && claimMatch[field] !== null && claimMatch[field] !== undefined) {
          (claim as any)[field] = claimMatch[field];
        }
      }
    }

    const lines = claim.cptLines;
    if (lines === undefined) return; // flat claim — nothing further to backfill at the line level
    if (lines.length === 0) {
      // Regex found the date/claim-level fields but no service lines at
      // all — rebuild cptLines entirely from the AI's claims for this date.
      for (const aiClaim of dateMatches) {
        const newLine: Record<string, unknown> = {};
        for (const field of lineFields) newLine[field] = aiClaim[field] ?? null;
        lines.push(newLine);
      }
      return;
    }
    lines.forEach((line, li) => {
      const lineMatch =
        dateMatches.find(a => a.cptCodes && a.cptCodes === line.cptCodes) ??
        dateMatches[li] ??
        dateMatches[0];
      if (!lineMatch) return;
      for (const field of lineFields) {
        if ((line[field] === null || line[field] === undefined) && lineMatch[field] !== null && lineMatch[field] !== undefined) {
          line[field] = lineMatch[field];
        }
      }
    });
  });
}

// Value fields that may ONLY appear on a CMS-1500 claim form, vs. only on a
// Reimbursement/EOB payment document. dateOfService and cptCodes are
// deliberately excluded from both lists — they're the upsert match key
// (patient_id, auth_period, date_of_service, cpt_codes) used by
// bulkImportFromEOB/upsertClaimRecord, so a Reimbursement upload must keep
// them populated to attach its payment to the right existing CMS-1500 row.
// diagnosisCodes/unitsBilled/modifier/chargeAmount are deliberately NOT in
// this list — many Reimbursement/EOB documents print their own line-item
// billing table (Billed Amount, DX, Modifier, Quantity) alongside the
// payment columns, and that data is real, useful line-level detail for
// review, not something that belongs only to CMS-1500. placeOfService,
// claimSubmittedDate, and visitNumber remain CMS-1500-exclusive: they come
// from specific numbered boxes on that form (24B, 31, 24) and are not
// printed on payer-issued EOBs.
const CMS1500_ONLY_FIELDS: (keyof ExtractedClaim)[] = [
  'placeOfService',
  'claimSubmittedDate',
  // Matches the existing isCms gate in bulkImportFromEOB (server/routers.ts),
  // which already only ever writes visitNumber for CMS-1500 claims.
  'visitNumber',
];

const REIMBURSEMENT_ONLY_FIELDS: (keyof ExtractedClaim)[] = [
  'insuranceReimbursement',
  'patientAmountPaid',
  'patientAmountDue',
  'oaClaimNumber',
  'checkDate',
  'checkNumberVirtualCard',
];

// Final defensive gate: strips any value that leaked across the document-type
// boundary — whether from the regex template parser, an AI backfill pass, or
// the unscoped legacy extractor — before a claim ever reaches the client or
// gets saved. Mutates `claims` in place.
function enforceFieldBoundary(claims: ExtractedClaim[], uploadType: 'reimbursement' | 'cms1500'): void {
  const fieldsToStrip = uploadType === 'reimbursement' ? CMS1500_ONLY_FIELDS : REIMBURSEMENT_ONLY_FIELDS;
  for (const claim of claims) {
    for (const field of fieldsToStrip) {
      (claim as any)[field] = null;
    }
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const allowed = [
      'application/pdf',
      'text/csv',
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel.sheet.macroEnabled.12', // .xlsm
    ];
    if (
      allowed.includes(file.mimetype) ||
      name.endsWith('.csv') ||
      name.endsWith('.xlsx') ||
      name.endsWith('.xls') ||
      name.endsWith('.xlsm')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, CSV, and Excel (.xlsx/.xls) files are supported.'));
    }
  },
});

// Column descriptions for the LLM prompt
const COLUMN_DESCRIPTIONS = `
Extract claim line items and map each one to these columns (use null if not found):
- placeOfService: string — place of service code or description (e.g. "11", "Home", "Office")
- dateOfService: string — date of service in YYYY-MM-DD format
- visitNumber: integer — CMS-1500 only: the Box 24 service line's position (1-6), assigned top-to-bottom in printed order, not a text label. Always null for Reimbursement/EOB documents.
- cptCodes: string — CPT/procedure codes (comma-separated if multiple)
- unitsBilled: number — units billed
- diagnosisCodes: string — ICD-10 diagnosis codes (comma-separated)
- modifier: string — modifier codes
- chargeAmount: number — total charge/billed amount (numeric, no $ sign)
- insuranceReimbursement: number — amount paid/reimbursed by insurance (numeric, no $ sign)
- patientAmountPaid: number — amount paid by patient
- patientAmountDue: number — patient balance/amount due
- insuranceBilled: string — the numeric billing/group/payer identifier (e.g. Group #, Billing ID, Payer ID); NEVER the insurance company name (do not write "Aetna", "Meritain Health", etc.) — use null if no such identifier is visible
- oaClaimNumber: string — OA or internal claim number
- claimSubmittedDate: string — date claim was submitted in YYYY-MM-DD format
- expireBcbsClaimNumber: string — BCBS or external claim/reference number
- claimStatus: string — one of: submitted, approved, pending, denied, pended, rejected, resubmitted
- paymentReceived: number — payment received amount
- checkDate: string — check/payment date in YYYY-MM-DD format
- checkNumberVirtualCard: string — check number or virtual card number
- dateReceived: string — date payment was received in YYYY-MM-DD format
- lmn: string — LMN documents date sent
- referenceNo: string — reference number
- dateOfAppeal: string — date of appeal in YYYY-MM-DD format
- notes: string — any additional notes or remarks from the document
`;

// Extract text from PDF buffer using pdfjs-dist
async function extractPdfText(buffer: Buffer): Promise<string> {
  // Dynamically import pdfjs-dist (ESM-only in v4+)
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;
  const textParts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: any) => ('str' in item ? item.str : ''))
      .join(' ');
    textParts.push(pageText);
  }
  return textParts.join('\n');
}

/** Extract text from PDF using pdftotext -layout (better for form PDFs like CMS1500) */
function extractPdfTextLayout(buffer: Buffer): string {
  const tmpFile = join(tmpdir(), `cms1500_${Date.now()}.pdf`);
  try {
    writeFileSync(tmpFile, buffer);
    const text = execSync(`pdftotext -layout "${tmpFile}" -`, { maxBuffer: 10 * 1024 * 1024 }).toString();
    return text;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Pure-JS layout-preserving PDF text extraction using pdfjs-dist's per-glyph
 * position data. Approximates what `pdftotext -layout` produces (each visual
 * row kept on its own text line, columns kept visually separated) without
 * requiring the poppler `pdftotext` binary — which isn't bundled in Vercel's
 * serverless Node runtime, so extractPdfTextLayout() above reliably fails
 * there every time. Used as the fallback in that case, in place of
 * extractPdfText()'s flat "join every glyph on the page with one space"
 * output, which discards row structure entirely (an entire page's table
 * becomes a single line) and is far more likely to scramble a dense table's
 * columns/rows together than this is.
 */
async function extractPdfTextLayoutJS(buffer: Buffer): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;
  const pageTexts: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = (content.items as any[]).filter(item => typeof item.str === 'string' && item.str.length > 0);

    // Group glyphs into rows by Y position — fragments on the same visual
    // line land within a small tolerance of each other's baseline (same
    // technique already used by parseCMS1500's layout-mode row detection
    // in insuranceTemplates.ts, applied generically here for any EOB table).
    const rows: Array<Array<{ x: number; str: string; width: number }>> = [];
    let currentRow: Array<{ x: number; str: string; width: number }> = [];
    let lastY: number | null = null;
    const sortedByY = [...items].sort((a, b) => b.transform[5] - a.transform[5]);

    for (const item of sortedByY) {
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        if (currentRow.length > 0) rows.push(currentRow);
        currentRow = [];
      }
      currentRow.push({ x: item.transform[4], str: item.str, width: item.width ?? 0 });
      lastY = y;
    }
    if (currentRow.length > 0) rows.push(currentRow);

    // Within each row, order left-to-right and space fragments apart
    // proportional to the horizontal gap between them, so table columns
    // stay visually separated instead of glued into one run of characters.
    const pageLines = rows.map(row => {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      let line = '';
      let prevEnd: number | null = null;
      for (const frag of sorted) {
        if (prevEnd !== null) {
          const gap = frag.x - prevEnd;
          // ~4 PDF units per space character approximates typical body-text
          // spacing at EOB font sizes; clamped so overlapping/adjacent
          // fragments still get at least one separating space, and any
          // pathologically large gap doesn't blow up the line length.
          const spaces = Math.max(1, Math.round(gap / 4));
          line += ' '.repeat(Math.min(spaces, 20));
        }
        line += frag.str;
        prevEnd = frag.x + frag.width;
      }
      return line;
    });

    pageTexts.push(pageLines.join('\n'));
  }

  return pageTexts.join('\n\n');
}

// Parse Excel (XLSX/XLS) buffer to JSON string (compact, one row per line)
function extractXlsxText(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const allRows: any[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    allRows.push(...rows);
  }
  if (allRows.length === 0) throw new Error('No data found in Excel file.');
  // Compact: one JSON object per line to minimize token usage
  return allRows.map(r => JSON.stringify(r)).join('\n');
}

// Parse CSV buffer to JSON string
function extractCsvText(buffer: Buffer): string {
  const csvString = buffer.toString('utf-8');
  const result = Papa.parse(csvString, { header: true, skipEmptyLines: true });
  if (result.errors.length > 0 && result.data.length === 0) {
    throw new Error('Could not parse CSV file.');
  }
  return JSON.stringify(result.data, null, 2);
}

// Call LLM to map extracted text to claim columns
async function mapToClaimColumns(extractedText: string): Promise<any[]> {
  // Trim to ~20000 chars to stay within token limits while covering more rows
  const trimmedText = extractedText.slice(0, 20000);
  const prompt = `You are a medical billing assistant. You will be given text extracted from a PDF, CSV, or Excel file that contains insurance claim information.

${COLUMN_DESCRIPTIONS}

IMPORTANT RULES:
- Return a JSON object with a single key "claims" whose value is an array of claim objects.
- Each object in the array represents one claim line item.
- Use null for any field that cannot be determined from the document.
- Dates must be in YYYY-MM-DD format or null.
- Numbers must be numeric (no currency symbols), or null.
- claimStatus must be one of: submitted, approved, pending, denied, pended, rejected, resubmitted — pick the closest match or use "submitted" as default.
- If the document contains multiple claim lines, return one object per line.
- If only one claim is found, return {"claims": [one object]}.
- Column names in the source file may differ — map them by meaning (e.g. "Billed Amount" → chargeAmount, "Paid" → insuranceReimbursement, etc.).

Document content:
---
${trimmedText}
---

Return JSON object with "claims" array:`;

  const response = await invokeLLM({
    model: ENV.aiModel,
    messages: [
      { role: 'system', content: 'You are a medical billing data extraction assistant. Always respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
  });

  const rawContent = response?.choices?.[0]?.message?.content;
  const content: string = typeof rawContent === 'string' ? rawContent : '{"claims":[]}';

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      return [];
    }
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed.claims && Array.isArray(parsed.claims)) return parsed.claims;
  if (parsed.data && Array.isArray(parsed.data)) return parsed.data;
  if (parsed.rows && Array.isArray(parsed.rows)) return parsed.rows;
  if (typeof parsed === 'object' && parsed !== null) return [parsed];

  return [];
}

// Express route registration
import type { Express } from 'express';
export function registerClaimUploadRoute(app: Express) {
  const router = Router();

  router.post(
    '/api/claims/upload-extract',
    requireAuthenticatedUser,
    (req, res, next) => {
      upload.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
          res.status(400).json({ error: `Upload error: ${err.message}` });
          return;
        }
        if (err) {
          res.status(400).json({ error: err.message });
          return;
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: 'No file uploaded.' });
          return;
        }

        const { buffer, mimetype, originalname } = req.file;
        const name = originalname.toLowerCase();
        let extractedText = '';

        console.log(`[ClaimUpload] Stage 1/7 — PDF uploaded: "${originalname}" (${(buffer.length / 1024).toFixed(1)} KB, ${mimetype})`);

        const isXlsx =
          name.endsWith('.xlsx') ||
          name.endsWith('.xls') ||
          name.endsWith('.xlsm') ||
          mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
          mimetype === 'application/vnd.ms-excel.sheet.macroEnabled.12';

        const isCsv = !isXlsx && (mimetype === 'text/csv' || name.endsWith('.csv'));

        if (isXlsx) {
          extractedText = extractXlsxText(buffer);
        } else if (isCsv) {
          extractedText = extractCsvText(buffer);
        } else {
          // pdfjs-dist's text extraction can throw in serverless Node.js
          // environments without a canvas backend (e.g. "DOMMatrix is not
          // defined") for PDFs whose glyph rendering path touches canvas-only
          // APIs. This initial pass is only used for the empty-file check and
          // response metadata when uploadType is explicit (the normal case) —
          // the actual reimbursement/CMS1500 extraction re-reads the PDF via
          // pdftotext regardless — so fall back to that instead of failing
          // the whole request.
          try {
            extractedText = await extractPdfText(buffer);
          } catch (pdfjsError) {
            console.error('[ClaimUpload] pdfjs-dist extraction failed, falling back to pdftotext:', pdfjsError);
            try {
              extractedText = extractPdfTextLayout(buffer);
            } catch (pdftotextError) {
              console.error('[ClaimUpload] pdftotext also failed:', pdftotextError);
              extractedText = '';
            }
          }
        }

        // For CSV/Excel there's no fallback if extraction comes back empty —
        // fail now. PDFs are allowed through even with empty extractedText:
        // the AI fallback steps below can read the PDF directly (vision) when
        // no local text-extraction method worked (e.g. serverless
        // environments without pdftotext or a canvas backend).
        if (!extractedText.trim() && (isXlsx || isCsv)) {
          res.status(422).json({ error: 'Could not extract any data from the file. Please ensure it is a valid CSV or Excel file.' });
          return;
        }

        console.log(`[ClaimUpload] Stage 2/7 — OCR/text extraction completed: ${extractedText.trim() ? `${extractedText.length} chars` : 'no text extracted, will rely on AI vision fallback'}`);

        // Determine upload type from form field (reimbursement | cms1500)
        let uploadType: string = (req.body?.uploadType as string) || 'reimbursement';

        // Optionally auto-detect document type via AI if not explicitly specified
        if (!req.body?.uploadType && !isXlsx && !isCsv && extractedText.trim()) {
          try {
            const detection = await detectInsuranceType(extractedText);
            console.log(`[ClaimUpload] Stage 3/7 — Template/type detection: ${detection.insurer} (${detection.documentType}, confidence: ${detection.confidence})`);
            // A known EOB-issuing payer's own document rarely doubles as a
            // CMS-1500 claim form — require a higher confidence bar before
            // honoring a 'cms1500' classification in that case, since a
            // false positive here sends genuine EOB text into the CMS-1500
            // regex parser's unanchored positional extraction (bad data),
            // whereas a false 'reimbursement' default just falls through to
            // the AI path with EOB-appropriate prompting (safer failure mode).
            const isKnownInsurer = KNOWN_INSURER_NAMES.some((name) => detection.insurer.toLowerCase().includes(name));
            const confidenceThreshold = isKnownInsurer ? 0.9 : 0.7;
            if (detection.confidence > confidenceThreshold && detection.documentType === 'cms1500') {
              uploadType = 'cms1500';
              console.log('[ClaimUpload] Auto-detected CMS1500 format');
            }
          } catch (error) {
            console.error('[ClaimUpload] Document type detection failed (non-fatal, continuing with default uploadType):', error);
          }
        }

        if (uploadType === 'cms1500') {
          // For CMS1500, re-extract using pdftotext -layout for better form field capture
          let cms1500Text = extractedText;
          if (!isXlsx && !isCsv) {
            try {
              cms1500Text = extractPdfTextLayout(buffer);
            } catch (pdftotextError) {
              // pdftotext binary isn't bundled on serverless platforms like Vercel —
              // this fails on every request there, not just occasionally, so it's
              // logged rather than silently swallowed. Fall back to the pure-JS
              // layout reconstruction (still row/column-aware) instead of dropping
              // all the way to extractedText's single-line-per-page flat join.
              console.warn('[ClaimUpload] pdftotext -layout unavailable for CMS1500 (expected on serverless):', pdftotextError instanceof Error ? pdftotextError.message : pdftotextError);
              try {
                cms1500Text = await extractPdfTextLayoutJS(buffer);
              } catch (jsLayoutError) {
                console.error('[ClaimUpload] JS layout extraction also failed for CMS1500, falling back to flat text:', jsLayoutError);
              }
            }
          }
          // CMS1500 parser: extract Date of Service, Place of Service, CPT, Modifier, Units, Diagnosis
          console.log('[ClaimUpload] Stage 4/7 — Regex template parsing (CMS1500)...');
          const patientGroups = parseCMS1500(cms1500Text);
          const flatClaims = patientGroups.flatMap(g => g.claims);

          if (flatClaims.length > 0) {
            if (hasMissingFields(flatClaims, CMS1500_CLAIM_FIELDS_TO_BACKFILL, CMS1500_LINE_FIELDS_TO_BACKFILL)) {
              try {
                const cms1500Source: ExtractionSource = (cms1500Text || extractedText).trim()
                  ? { kind: 'text', text: cms1500Text || extractedText }
                  : { kind: 'pdf', buffer, filename: originalname };
                console.log('[ClaimUpload] Stage 4b/7 — CMS1500 regex parser left fields blank, running AI to backfill place of service / units / diagnosis / modifier...');
                const backfillResult = await extractClaimsWithAI(cms1500Source, 'cms1500');
                if (backfillResult.claims.length > 0) {
                  backfillMissingFields(flatClaims, backfillResult.claims, CMS1500_CLAIM_FIELDS_TO_BACKFILL, CMS1500_LINE_FIELDS_TO_BACKFILL);
                }
              } catch (backfillError) {
                console.error('[ClaimUpload] CMS1500 AI backfill failed (continuing with regex-only result):', backfillError);
              }
            }
            enforceFieldBoundary(flatClaims, 'cms1500');
            console.log(`[ClaimUpload] Stage 7/7 — Database save pending: ${flatClaims.length} claim(s) via CMS1500 template parser`);
            res.json({
              claims: flatClaims,
              patientGroups: patientGroups.length > 0 ? patientGroups : null,
              extractedLength: extractedText.length,
              templateUsed: 'CMS1500',
              uploadType: 'cms1500',
            });
            return;
          }

          // Fall back to AI extraction when the regex-based parser (which relies
          // on pdftotext -layout output) finds nothing — e.g. pdftotext isn't
          // installed in this environment (serverless platforms like Vercel
          // don't ship it). Use whatever text we do have; if none at all
          // (pdftotext AND pdfjs both failed), send the PDF directly instead.
          // Never let an AI-provider failure crash the request — log and fall
          // through to the CMS1500 template result (empty) below instead.
          try {
            const cms1500Source: ExtractionSource = (cms1500Text || extractedText).trim()
              ? { kind: 'text', text: cms1500Text || extractedText }
              : { kind: 'pdf', buffer, filename: originalname };
            console.log(`[ClaimUpload] Stage 5/7 — AI text parsing (CMS1500 regex parser found no claims, trying AI via ${cms1500Source.kind}${cms1500Source.kind === 'pdf' ? ' — Stage 5b/7 vision fallback' : ''})...`);
            const aiResult = await extractClaimsWithAI(cms1500Source, 'cms1500');
            if (aiResult.claims.length > 0) {
              console.log(`[ClaimUpload] Stage 6/7 — JSON validation passed: ${aiResult.claims.length} claim(s)`);
              enforceFieldBoundary(aiResult.claims, 'cms1500');
              const aiPatientGroups = aiResult.patientName
                ? [{ patientName: aiResult.patientName, claims: aiResult.claims }]
                : null;
              console.log(`[ClaimUpload] Stage 7/7 — Database save pending: ${aiResult.claims.length} claim(s) via AI (CMS1500)`);
              res.json({
                claims: aiResult.claims,
                patientGroups: aiPatientGroups,
                extractedLength: extractedText.length,
                templateUsed: `AI (CMS1500)`,
                uploadType: 'cms1500',
                confidence: aiResult.confidence,
                extractionNotes: aiResult.extractionNotes,
              });
              return;
            }
          } catch (aiError) {
            console.error('[ClaimUpload] CMS1500 AI extraction failed (continuing with empty template result, request will not crash):', aiError);
          }

          enforceFieldBoundary(flatClaims, 'cms1500');
          res.json({
            claims: flatClaims,
            patientGroups: patientGroups.length > 0 ? patientGroups : null,
            extractedLength: extractedText.length,
            templateUsed: 'CMS1500',
            uploadType: 'cms1500',
          });
          return;
        }

        // Step 1: Try rule-based template recognition first (fast, accurate)
        // For reimbursement PDFs, use pdftotext -layout so each service line's charge/
        // allowed/co-ins/co-pay/deductible/non-cov columns stay aligned to its CPT code.
        // Plain mode reads the underlying PDF's table column-by-column instead of
        // row-by-row, which scatters all the dollar amounts into a block completely
        // separate from the CPT codes/dates they belong to.
        let reimbursementText = extractedText;
        if (!isXlsx && !isCsv) {
          try {
            reimbursementText = extractPdfTextLayout(buffer);
          } catch (pdftotextError) {
            // See the matching comment in the CMS1500 branch above — this is
            // an expected, every-time failure on serverless platforms like
            // Vercel (no pdftotext binary), so it's logged instead of silent,
            // and falls back to the pure-JS layout reconstruction rather than
            // straight to extractedText's flattened, row-structure-free text.
            console.warn('[ClaimUpload] pdftotext -layout unavailable for reimbursement doc (expected on serverless):', pdftotextError instanceof Error ? pdftotextError.message : pdftotextError);
            try {
              reimbursementText = await extractPdfTextLayoutJS(buffer);
            } catch (jsLayoutError) {
              console.error('[ClaimUpload] JS layout extraction also failed for reimbursement doc, falling back to flat text:', jsLayoutError);
              reimbursementText = extractedText;
            }
          }
        }
        console.log('[ClaimUpload] Stage 4/7 — Template detection (reimbursement)...');
        let templateResult: ReturnType<typeof tryTemplateExtraction>;
        try {
          templateResult = tryTemplateExtraction(reimbursementText, originalname);
        } catch (err) {
          // A template parser (e.g. parseMeritainEOBWithGroups) determined it
          // cannot reliably tell two patients' sections apart in this
          // document. This must stop the request here: never fall through to
          // AI extraction below (an LLM could still produce a confident-
          // looking guess that silently misattributes a claim) and never
          // report success with zero/partial claims -- both would hide the
          // exact failure this error exists to surface.
          if (err instanceof PatientBoundaryError) {
            console.error('[ClaimUpload] Patient boundary extraction failure:', err.message);
            res.status(422).json({
              error: 'Patient boundaries could not be determined. Review the document before importing.',
            });
            return;
          }
          throw err;
        }
        if (templateResult && templateResult.claims.length > 0) {
          if (hasMissingFields(templateResult.claims, REIMBURSEMENT_CLAIM_FIELDS_TO_BACKFILL, REIMBURSEMENT_LINE_FIELDS_TO_BACKFILL)) {
            try {
              const reimbursementBackfillSource: ExtractionSource = reimbursementText.trim()
                ? { kind: 'text', text: reimbursementText }
                : { kind: 'pdf', buffer, filename: originalname };
              console.log(`[ClaimUpload] Stage 4b/7 — Template "${templateResult.templateName}" left fields blank, running AI to backfill place of service / units / diagnosis / modifier...`);
              const backfillResult = await extractClaimsWithAI(reimbursementBackfillSource, 'reimbursement');
              if (backfillResult.claims.length > 0) {
                backfillMissingFields(templateResult.claims, backfillResult.claims, REIMBURSEMENT_CLAIM_FIELDS_TO_BACKFILL, REIMBURSEMENT_LINE_FIELDS_TO_BACKFILL);
                // templateResult.claims and templateResult.patientGroups[].claims come from
                // two independent parse calls (see tryTemplateExtraction), not shared
                // object references — each group's claims need the same backfill applied.
                templateResult.patientGroups?.forEach((group: PatientClaimGroup) => {
                  backfillMissingFields(group.claims, backfillResult.claims, REIMBURSEMENT_CLAIM_FIELDS_TO_BACKFILL, REIMBURSEMENT_LINE_FIELDS_TO_BACKFILL);
                });
              }
            } catch (backfillError) {
              console.error('[ClaimUpload] Reimbursement AI backfill failed (continuing with template-only result):', backfillError);
            }
          }
          enforceFieldBoundary(templateResult.claims, 'reimbursement');
          templateResult.patientGroups?.forEach((group: PatientClaimGroup) => {
            enforceFieldBoundary(group.claims, 'reimbursement');
          });
          // Some templates (currently Globe Life) can find a claim block
          // where the payer only discloses ONE combined Plan Paid for
          // several CPT lines, with no line-level breakdown printed. Those
          // amounts are deliberately never written onto any claims_records
          // row (see DateClaimGroup.unresolvedClaimTotal in
          // insuranceTemplates.ts for why) -- surfaced here instead so
          // staff see an explicit "needs manual review" notice rather than
          // the payment silently not showing up anywhere.
          const reimbursementReviewNeeded = (templateResult.patientGroups ?? [])
            .flatMap((group: PatientClaimGroup) =>
              (group.claims as Array<ExtractedClaim & { unresolvedClaimTotal?: { planPaid: number; patientResponsibility: number | null; cptCount: number } | null }>)
                .filter(c => c.unresolvedClaimTotal)
                .map(c => ({
                  patientName: group.patientName,
                  dateOfService: c.dateOfService ?? null,
                  cptCodes: c.cptCodes ?? null,
                  planPaid: c.unresolvedClaimTotal!.planPaid,
                  patientResponsibility: c.unresolvedClaimTotal!.patientResponsibility,
                  cptCount: c.unresolvedClaimTotal!.cptCount,
                }))
            );
          console.log(`[ClaimUpload] Stage 7/7 — Database save pending: ${templateResult.claims.length} claim(s) via template "${templateResult.templateName}"${reimbursementReviewNeeded.length > 0 ? ` (${reimbursementReviewNeeded.length} claim block(s) need manual Plan Paid review)` : ''}`);
          res.json({
            claims: templateResult.claims,
            patientGroups: templateResult.patientGroups ?? null,
            extractedLength: extractedText.length,
            templateUsed: templateResult.templateName,
            uploadType: 'reimbursement',
            reimbursementReviewNeeded: reimbursementReviewNeeded.length > 0 ? reimbursementReviewNeeded : undefined,
          });
          return;
        }

        // Step 2: Fall back to AI extraction for unrecognized formats. Use
        // whatever text we have; if none at all (pdftotext AND pdfjs both
        // failed to extract anything), send the PDF directly instead (vision
        // fallback). Never let an AI-provider failure crash the request —
        // log and fall through to Step 3 instead.
        try {
          const reimbursementSource: ExtractionSource = reimbursementText.trim()
            ? { kind: 'text', text: reimbursementText }
            : { kind: 'pdf', buffer, filename: originalname };
          console.log(`[ClaimUpload] Stage 5/7 — AI text parsing (no template matched, using AI via ${reimbursementSource.kind}${reimbursementSource.kind === 'pdf' ? ' — Stage 5b/7 vision fallback' : ''})...`);
          const aiResult = await extractClaimsWithAI(reimbursementSource, 'reimbursement');

          if (aiResult.claims.length > 0) {
            console.log(`[ClaimUpload] Stage 6/7 — JSON validation passed: ${aiResult.claims.length} claim(s) for patient: ${aiResult.patientName}`);
            enforceFieldBoundary(aiResult.claims, 'reimbursement');

            // If all claims are for the same patient, create patientGroups for single-patient mode
            let patientGroups = null;
            if (aiResult.patientName) {
              patientGroups = [{
                patientName: aiResult.patientName,
                claims: aiResult.claims
              }];
            }

            console.log(`[ClaimUpload] Stage 7/7 — Database save pending: ${aiResult.claims.length} claim(s) via AI (${aiResult.detectedInsurer || 'Unknown'})`);
            res.json({
              claims: aiResult.claims,
              patientGroups: patientGroups,
              extractedLength: extractedText.length,
              templateUsed: `AI (${aiResult.detectedInsurer || 'Unknown'})`,
              uploadType: 'reimbursement',
              confidence: aiResult.confidence,
              extractionNotes: aiResult.extractionNotes,
            });
            return;
          }
          // extractClaimsWithAI ran successfully and legitimately found zero
          // claims -- e.g. the requested patient's name appears only in a
          // header/subscriber list with no service lines of their own. This
          // is a valid, honest result, not a failure: return it as such
          // instead of falling through to the legacy fallback below, which
          // has no patient-name awareness at all and would extract every
          // patient in the document unfiltered, silently reintroducing
          // cross-patient contamination through a completely different path
          // than the ones already hardened in extractClaimsWithAI.
          console.log('[ClaimUpload] AI extraction succeeded but found zero claims -- returning empty result rather than falling back to the unscoped legacy extractor.');
          res.json({
            claims: [],
            patientGroups: null,
            extractedLength: extractedText.length,
            templateUsed: `AI (${aiResult.detectedInsurer || 'Unknown'})`,
            uploadType: 'reimbursement',
            confidence: aiResult.confidence,
            extractionNotes: aiResult.extractionNotes ?? 'No service line data was found for this patient in the document.',
          });
          return;
        } catch (aiError) {
          console.error('[ClaimUpload] AI extraction failed (continuing to legacy fallback, request will not crash):', aiError);
        }

        // Step 3: Final fallback to legacy AI extraction — only reached when
        // extractClaimsWithAI itself threw (see catch above), never for a
        // legitimate zero-claims result (handled above). Needs actual text,
        // unlike the vision-capable step above, so skip it when we have none.
        if (!extractedText.trim()) {
          console.error('[ClaimUpload] No text and AI extraction failed — returning controlled 422 instead of crashing.');
          res.status(422).json({ error: 'Could not extract any claims from this file.' });
          return;
        }
        console.log('[ClaimUpload] Stage 5/7 — AI text parsing failed upstream, using legacy AI extraction...');
        const claims = await mapToClaimColumns(extractedText);
        // mapToClaimColumns' prompt (COLUMN_DESCRIPTIONS) is not upload-type-scoped
        // like extractClaimsWithAI's — it asks for every column regardless of
        // document type, so this is the one place the boundary gate is load-bearing
        // rather than defense-in-depth.
        enforceFieldBoundary(claims, 'reimbursement');
        console.log(`[ClaimUpload] Stage 7/7 — Database save pending: ${claims.length} claim(s) via legacy AI extraction`);
        res.json({ claims, extractedLength: extractedText.length, templateUsed: 'AI Extraction (Legacy)', uploadType: 'reimbursement' });
      } catch (err: any) {
        console.error('[ClaimUpload] Error:', err);
        res.status(500).json({ error: err.message ?? 'Failed to process file.' });
      }
    }
  );

  app.use(router);
}
