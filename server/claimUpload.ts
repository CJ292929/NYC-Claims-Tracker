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
import { tryTemplateExtraction, parseCMS1500 } from './insuranceTemplates';
import { extractClaimsWithOpenAI, detectInsuranceType, type ExtractionSource } from './openaiExtractor';

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
- visitNumber: number — visit or service line number
- cptCodes: string — CPT/procedure codes (comma-separated if multiple)
- unitsBilled: number — units billed
- diagnosisCodes: string — ICD-10 diagnosis codes (comma-separated)
- modifier: string — modifier codes
- chargeAmount: number — total charge/billed amount (numeric, no $ sign)
- insuranceReimbursement: number — amount paid/reimbursed by insurance (numeric, no $ sign)
- patientAmountPaid: number — amount paid by patient
- patientAmountDue: number — patient balance/amount due
- insuranceBilled: string — insurance company name
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
    model: ENV.openaiModel,
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

        // Determine upload type from form field (reimbursement | cms1500)
        let uploadType: string = (req.body?.uploadType as string) || 'reimbursement';

        // Optionally detect document type using OpenAI if not explicitly specified
        if (!req.body?.uploadType && !isXlsx && !isCsv && extractedText.trim()) {
          try {
            const detection = await detectInsuranceType(extractedText);
            console.log(`[ClaimUpload] Detected: ${detection.insurer} (${detection.documentType}, confidence: ${detection.confidence})`);
            // Auto-detect CMS1500 with high confidence
            if (detection.confidence > 0.7 && detection.documentType === 'cms1500') {
              uploadType = 'cms1500';
              console.log('[ClaimUpload] Auto-detected CMS1500 format');
            }
          } catch (error) {
            console.error('[ClaimUpload] Document type detection failed:', error);
          }
        }

        if (uploadType === 'cms1500') {
          // For CMS1500, re-extract using pdftotext -layout for better form field capture
          let cms1500Text = extractedText;
          if (!isXlsx && !isCsv) {
            try {
              cms1500Text = extractPdfTextLayout(buffer);
            } catch {
              // fallback to pdfjs text if pdftotext is unavailable
            }
          }
          // CMS1500 parser: extract Date of Service, Place of Service, CPT, Modifier, Units, Diagnosis
          const patientGroups = parseCMS1500(cms1500Text);
          const flatClaims = patientGroups.flatMap(g => g.claims);

          if (flatClaims.length > 0) {
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
          try {
            const cms1500Source: ExtractionSource = (cms1500Text || extractedText).trim()
              ? { kind: 'text', text: cms1500Text || extractedText }
              : { kind: 'pdf', buffer, filename: originalname };
            console.log(`[ClaimUpload] CMS1500 regex parser found no claims, trying OpenAI extraction (${cms1500Source.kind})...`);
            const openaiResult = await extractClaimsWithOpenAI(cms1500Source, 'cms1500');
            if (openaiResult.claims.length > 0) {
              const aiPatientGroups = openaiResult.patientName
                ? [{ patientName: openaiResult.patientName, claims: openaiResult.claims }]
                : null;
              res.json({
                claims: openaiResult.claims,
                patientGroups: aiPatientGroups,
                extractedLength: extractedText.length,
                templateUsed: `OpenAI (CMS1500)`,
                uploadType: 'cms1500',
                confidence: openaiResult.confidence,
                extractionNotes: openaiResult.extractionNotes,
              });
              return;
            }
          } catch (openaiError) {
            console.error('[ClaimUpload] CMS1500 OpenAI extraction failed:', openaiError);
          }

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
          } catch {
            reimbursementText = extractedText;
          }
        }
        const templateResult = tryTemplateExtraction(reimbursementText, originalname);
        if (templateResult && templateResult.claims.length > 0) {
          res.json({
            claims: templateResult.claims,
            patientGroups: templateResult.patientGroups ?? null,
            extractedLength: extractedText.length,
            templateUsed: templateResult.templateName,
            uploadType: 'reimbursement',
          });
          return;
        }

        // Step 2: Fall back to OpenAI extraction for unrecognized formats.
        // Use whatever text we have; if none at all (pdftotext AND pdfjs
        // both failed to extract anything), send the PDF directly instead.
        try {
          const reimbursementSource: ExtractionSource = reimbursementText.trim()
            ? { kind: 'text', text: reimbursementText }
            : { kind: 'pdf', buffer, filename: originalname };
          console.log(`[ClaimUpload] No template matched, using OpenAI extraction (${reimbursementSource.kind})...`);
          const openaiResult = await extractClaimsWithOpenAI(reimbursementSource, 'reimbursement');
          
          if (openaiResult.claims.length > 0) {
            console.log(`[ClaimUpload] OpenAI extracted ${openaiResult.claims.length} claims for patient: ${openaiResult.patientName}`);
            
            // If all claims are for the same patient, create patientGroups for single-patient mode
            let patientGroups = null;
            if (openaiResult.patientName) {
              patientGroups = [{
                patientName: openaiResult.patientName,
                claims: openaiResult.claims
              }];
            }
            
            res.json({
              claims: openaiResult.claims,
              patientGroups: patientGroups,
              extractedLength: extractedText.length,
              templateUsed: `OpenAI (${openaiResult.detectedInsurer || 'Unknown'})`,
              uploadType: 'reimbursement',
              confidence: openaiResult.confidence,
              extractionNotes: openaiResult.extractionNotes,
            });
            return;
          }
        } catch (openaiError) {
          console.error('[ClaimUpload] OpenAI extraction failed:', openaiError);
        }

        // Step 3: Final fallback to legacy AI extraction — needs actual text,
        // unlike the vision-capable step above, so skip it when we have none.
        if (!extractedText.trim()) {
          res.status(422).json({ error: 'Could not extract any claims from this file.' });
          return;
        }
        console.log('[ClaimUpload] OpenAI failed, using legacy AI extraction...');
        const claims = await mapToClaimColumns(extractedText);
        res.json({ claims, extractedLength: extractedText.length, templateUsed: 'AI Extraction (Legacy)', uploadType: 'reimbursement' });
      } catch (err: any) {
        console.error('[ClaimUpload] Error:', err);
        res.status(500).json({ error: err.message ?? 'Failed to process file.' });
      }
    }
  );

  app.use(router);
}
