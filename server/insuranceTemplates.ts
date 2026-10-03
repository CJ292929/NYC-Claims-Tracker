/**
 * server/insuranceTemplates.ts
 *
 * Insurance template recognition engine.
 * Auto-detects the insurer from extracted PDF text and applies a
 * pre-mapped rule-based parser to extract claim rows accurately.
 *
 * Each template defines:
 *   - detect(text): returns true if this template matches the document
 *   - parse(text): returns extracted claim rows mapped to ClaimRecord columns
 *   - name: human-readable insurer name shown in the preview dialog
 */

export interface ExtractedClaim {
  placeOfService?: string | null;
  dateOfService?: string | null;
  visitNumber?: number | null;
  cptCodes?: string | null;
  unitsBilled?: number | null;
  diagnosisCodes?: string | null;
  modifier?: string | null;
  chargeAmount?: number | null;
  insuranceReimbursement?: number | null;
  patientAmountPaid?: number | null;
  patientAmountDue?: number | null;
  insuranceBilled?: string | null;
  oaClaimNumber?: string | null;
  claimSubmittedDate?: string | null;
  expireBcbsClaimNumber?: string | null;
  claimStatus?: string | null;
  paymentReceived?: number | null;
  checkDate?: string | null;
  checkNumberVirtualCard?: string | null;
  dateReceived?: string | null;
  lmn?: string | null;
  referenceNo?: string | null;
  dateOfAppeal?: string | null;
  notes?: string | null;
}

/** A group of claims belonging to one detected patient in the document */
export interface PatientClaimGroup {
  patientName: string;   // As detected in the document (e.g. "ALLISON AUYEUNG")
  claims: ExtractedClaim[];
}

export interface TemplateResult {
  templateName: string;
  claims: ExtractedClaim[];          // flat list (legacy, for single-patient files)
  patientGroups?: PatientClaimGroup[]; // per-patient groups (multi-patient files)
}

/**
 * Thrown when a template parser cannot reliably tell where one patient's
 * section ends and the next one's begins (e.g. a malformed/OCR-mangled
 * "Patient:" header that fails the section-split pattern). Callers MUST
 * treat this as an extraction failure requiring manual document review —
 * never catch it and fall back to AI extraction or an "empty success"
 * response, and never attribute the ambiguous lines to any patient name,
 * real or synthetic. See parseMeritainEOBWithGroups for the one place this
 * is currently thrown.
 */
export class PatientBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatientBoundaryError';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Parse a date string like "04/24/2026" or "04/24/26" or "04-24-2026" → "2026-04-24" */
function parseDate(raw: string): string | null {
  if (!raw) return null;
  const clean = raw.trim();
  // MM/DD/YYYY or MM-DD-YYYY
  const m1 = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m1) return `${m1[3]}-${m1[1].padStart(2, '0')}-${m1[2].padStart(2, '0')}`;
  // MM/DD/YY or MM-DD-YY (2-digit year)
  const m2 = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m2) {
    const year = parseInt(m2[3], 10);
    const fullYear = year > 50 ? 1900 + year : 2000 + year;
    return `${fullYear}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
  }
  // YYYY-MM-DD already
  const m3 = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m3) return clean;
  return null;
}

/** Parse a dollar amount like "$350.00" or "350.00" → 350 */
function parseMoney(raw: string): number | null {
  if (!raw) return null;
  const clean = raw.replace(/[$,\s]/g, '').trim();
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

/**
 * CMS-1500 Box 24 has exactly 6 service-line slots (numbered 1-6 down the
 * form). visitNumber is the printed row position, not a labeled field —
 * any value outside that range means the row counter mis-tracked (e.g. a
 * false-positive CPT match) and the value must not be trusted.
 */
function clampVisitNumber(n: number): number | null {
  return n >= 1 && n <= 6 ? n : null;
}

// ─── Meritain Health EOB Template ───────────────────────────────────────────

/**
 * Meritain Health Explanation of Benefits
 *
 * Detection: "Meritain Health" in text, or "EPC Draft #", or filename "EPP_*"
 *
 * Structure:
 *   - Document header: EPC Draft #, Payment Date, Payment Week
 *   - Per-patient blocks: Patient: NAME, Member #, Claim #, Rendering Provider, Group Name/Check
 *   - Service line table rows: date totalCharge allowed discount otherPlan otherAdj coIns coPay deductible nonCov notPayment cptCode coPayAmount
 *   - "Claim Total:" row at end of each patient block
 */
function detectMeritain(text: string): boolean {
  return (
    /meritain health/i.test(text) ||
    /epc draft #/i.test(text) ||
    /administered by:\s*meritain/i.test(text)
  );
}

function parseMeritainEOB(text: string): ExtractedClaim[] {
  return parseMeritainEOBWithGroups(text).flatMap(g => g.claims);
}

/** A date-level group within a patient's claims, with individual CPT sub-rows */
export interface DateClaimGroup extends ExtractedClaim {
  cptLines: Array<{
    cptCodes: string | null;
    chargeAmount: number | null;
    insuranceReimbursement: number | null;
    patientAmountPaid: number | null;
    patientAmountDue: number | null;
    unitsBilled: number | null;
    modifier: string | null;
    diagnosisCodes: string | null;
  }>;
}

/** Parse Meritain EOB and return claims grouped by patient name, then by date */
export function parseMeritainEOBWithGroups(text: string): Array<{ patientName: string; claims: DateClaimGroup[] }> {
  // Extract document-level payment date and EPC Draft # (from pdftotext -layout output).
  // Layout mode wraps a value onto the next line when it's too wide for its column,
  // so each field is extracted independently rather than assuming a fixed number of
  // newlines between the label block and the value block.
  const epcDraftMatch = text.match(/EPC Draft #:\s*\n?\s*(\d+)/);
  const paymentDateMatch = text.match(/Payment Date:\s*\n?\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  const docPaymentDate = paymentDateMatch ? parseDate(paymentDateMatch[1]) : null;
  const epcDraftNo = epcDraftMatch ? epcDraftMatch[1].trim() : null;

  // Accumulate all flat claims per patient name (merge duplicate patient sections —
  // the same patient can have multiple Claim #s, e.g. one per visit date)
  const patientClaimsMap = new Map<string, ExtractedClaim[]>();

  // Split by patient blocks: look for "Patient:   NAME" followed by "Claim #:"
  const patientSections = text.split(/(?=Patient:\s+[A-Z])/g);

  for (let sIdx = 0; sIdx < patientSections.length; sIdx++) {
    let section = patientSections[sIdx];
    if (!section.includes('Claim #:')) continue;
    // Truncate at "Claim Total:" to prevent service lines from leaking into the next patient's section
    const claimTotalIdx = section.indexOf('Claim Total:');
    if (claimTotalIdx !== -1) {
      section = section.slice(0, claimTotalIdx);
    }

    // Extract patient name — stops at either a newline (pdftotext plain mode) or a run
    // of 2+ spaces (pdftotext -layout mode, where "Member #:"/"Claim #:" share the same
    // physical line as the name, separated by wide column padding).
    const nameMatch = section.match(/Patient:\s+([A-Z][A-Z\s]+?)(?=\s{2,}|\n)/);
    const patientName = nameMatch ? nameMatch[1].trim() : 'UNKNOWN';

    // A well-formed section carries exactly one "Patient:" header -- the one
    // the split lookahead above matched to start this section. If a SECOND
    // "Patient<optional space>: NAME" occurrence shows up inside the same
    // section, a later patient's header failed the strict split pattern
    // (e.g. an OCR/layout artifact like "Patient :" with a stray space
    // before the colon) and that patient's block never got separated from
    // this one -- the section now contains two or more real patients'
    // service lines with no reliable way to tell which line belongs to
    // which. (Deliberately counting "Patient:" headers, not "Claim #:"
    // markers -- one real patient can legitimately have several Claim #s
    // in their own single well-formed section, one per visit date, and that
    // must keep working exactly as before; see the patientClaimsMap comment
    // above.) There's no safe automatic attribution here -- not to
    // `patientName` (whichever header happens to appear first), and not to
    // a synthetic placeholder name either, since a fake "patient" in the
    // preview is itself a form of silently misrepresenting the error. This
    // throws instead: the caller (tryTemplateExtraction / claimUpload.ts)
    // must surface it as an explicit extraction failure and stop before
    // anything reaches the import preview or persistence, never fall back
    // to AI extraction or an empty "no claims found" success.
    const patientHeaderCount = (section.match(/Patient\s*:\s*[A-Z]/g) || []).length;
    if (patientHeaderCount > 1) {
      throw new PatientBoundaryError(
        `Patient boundaries could not be determined (section ${sIdx} contains ${patientHeaderCount} patient headers that should have been split into separate sections).`
      );
    }

    // Extract Claim # — specific to this section/visit (each date group has its own claim #)
    const claimMatch = section.match(/Claim #:\s+([A-Z0-9]+)/);
    const claimNo = claimMatch ? claimMatch[1].trim() : null;

    // Extract Group Name/Check (format: "16404/137040261" — group/check number).
    // Captures a single token (\S+), not the rest of the line, since in -layout mode
    // trailing columns like "Customer Service:..." share the same physical line.
    const groupMatch = section.match(/Group Name\/Check:\s+(\S+)/);
    const groupName = groupMatch ? groupMatch[1].trim() : null;
    // Extract EFT/Check number: the part after the slash (e.g. "137040261" from "16404/137040261")
    const checkEftMatch = groupName ? groupName.match(/\/([\d]+)$/) : null;
    const checkEftNumber = checkEftMatch ? checkEftMatch[1] : null;

    if (!patientClaimsMap.has(patientName)) {
      patientClaimsMap.set(patientName, []);
    }
    const patientClaims = patientClaimsMap.get(patientName)!;

    // Extract service lines from pdftotext -layout output, where each service row stays
    // on one physical line with its charge/allowed/discount/co-ins/co-pay/deductible/
    // non-cov columns aligned (unlike plain mode, which scatters all amounts for the
    // whole claim into one flat block separate from their CPT codes).
    // Meritain EOB columns (in order):
    //   date_range (e.g. 04/11/26-04/11/26)  <- group 1 (start date)
    //   CPT code (e.g. 97110)                <- group 3
    //   explanation code (e.g. 395)          <- skipped
    //   total charge (e.g. 175.00)           <- group 4
    //   allowed amount/QPA (e.g. 135.00)     <- group 5 (insurance reimbursement)
    //   provider discount (e.g. 40.00)       <- group 6 (skipped — not patient obligation)
    //   other plan payment (e.g. 0.00)       <- group 7
    //   other adjustment (e.g. 0.00)         <- group 8
    //   co-insurance (e.g. 0.00)             <- group 9 (patient obligation)
    //   co-pay (e.g. 0.00)                   <- group 10 (patient obligation)
    //   deductible (e.g. 0.00)               <- group 11 (patient obligation)
    //   non-covered (e.g. 0.00)              <- group 12 (patient obligation)
    //   net payment amount (e.g. 135.00)     <- group 13, OPTIONAL and unused: in
    //                                            -layout mode this column sometimes
    //                                            wraps onto its own line when a nearby
    //                                            row's value pushes the page width, so
    //                                            it can be absent from the CPT line itself
    const serviceLinePattern = /(\d{1,2}\/\d{1,2}\/\d{2,4})-(\d{1,2}\/\d{1,2}\/\d{2,4})\s+([A-Z0-9]+)\s+\d+\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)(?:\s+(\d+\.\d+))?/g;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = serviceLinePattern.exec(section)) !== null) {
      const rawDate = lineMatch[1];
      const cptCode = lineMatch[3];
      const totalCharge = parseMoney(lineMatch[4]); // provider's billed charge for this line
      const notPaymentAmount = parseMoney(lineMatch[5]); // allowed/insurance reimbursement
      // Patient obligation = co-ins + co-pay + deductible + non-covered
      const coIns = parseMoney(lineMatch[9]) ?? 0;
      const coPay = parseMoney(lineMatch[10]) ?? 0;
      const deductible = parseMoney(lineMatch[11]) ?? 0;
      const nonCov = parseMoney(lineMatch[12]) ?? 0;
      const coPayAmountFromLine = coPay; // patient co-pay (0 is a valid value meaning no co-pay)
      const patientDue = coIns + coPay + deductible + nonCov;
      const parsedDate = parseDate(rawDate);

      let claimStatus = 'submitted';
      if (notPaymentAmount !== null && notPaymentAmount > 0) claimStatus = 'approved';
      else if (notPaymentAmount === 0) claimStatus = 'denied';

      patientClaims.push({
        dateOfService: parsedDate,
        cptCodes: cptCode || null,
        // "total charge" is the provider's billed amount for this line,
        // printed directly in Meritain's service-line table (group 4) —
        // the same concept as a CMS-1500's Box 24F charge, safe to carry
        // through on a Reimbursement/EOB upload too.
        chargeAmount: totalCharge,
        insuranceReimbursement: notPaymentAmount,
        patientAmountPaid: coPayAmountFromLine,
        // groupName ("16404/137040261") is the Group Name/Check billing
        // identifier printed on the EOB, not the payer name — insuranceBilled
        // must never hold the insurance company name (see anti-hallucination
        // check in aiClaimExtractor.ts).
        insuranceBilled: groupName,
        oaClaimNumber: claimNo,
        claimStatus,
        checkDate: docPaymentDate,
        dateReceived: docPaymentDate,
        referenceNo: epcDraftNo,
        checkNumberVirtualCard: checkEftNumber,
        // EOBs never print the CMS-1500 Box 24 line number — visitNumber
        // comes only from a CMS-1500 upload and is preserved through the
        // upsert merge (see enforceFieldBoundary's CMS1500_ONLY_FIELDS).
        visitNumber: null,
        placeOfService: null,
        // Meritain's service-line table (see the column list above this
        // function) genuinely does not print per-line units, diagnosis
        // codes, or modifiers — there's no source data to extract, unlike
        // chargeAmount above. REIMBURSEMENT_LINE_FIELDS_TO_BACKFILL in
        // claimUpload.ts will fill these from the AI backfill pass if a
        // future Meritain layout variant does print them.
        unitsBilled: null,
        diagnosisCodes: null,
        modifier: null,
        patientAmountDue: patientDue, // 0 is a valid value meaning no patient obligation
        claimSubmittedDate: null,
        expireBcbsClaimNumber: null,
        paymentReceived: notPaymentAmount,
        lmn: null,
        dateOfAppeal: null,
        notes: null,
      });
    }
  }

  // Build final result: per patient, group flat claims by date → DateClaimGroup[]
  const result: Array<{ patientName: string; claims: DateClaimGroup[] }> = [];
  for (const [patientName, flatClaims] of Array.from(patientClaimsMap.entries())) {
    if (flatClaims.length === 0) continue;
    const dateMap = new Map<string, DateClaimGroup>();
    for (const claim of flatClaims) {
      const dateKey = claim.dateOfService || 'no-date';
      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, { ...claim, cptLines: [] });
      }
      const group = dateMap.get(dateKey)!;
      group.cptLines.push({
        cptCodes: claim.cptCodes ?? null,
        chargeAmount: claim.chargeAmount ?? null,
        insuranceReimbursement: claim.insuranceReimbursement ?? null,
        patientAmountPaid: claim.patientAmountPaid ?? null,
        patientAmountDue: claim.patientAmountDue ?? null,
        unitsBilled: claim.unitsBilled ?? null,
        modifier: claim.modifier ?? null,
        diagnosisCodes: claim.diagnosisCodes ?? null,
      });
    }
    result.push({ patientName, claims: Array.from(dateMap.values()) });
  }

  return result;
}

// ─── CMS1500 Health Insurance Claim Form Parser ─────────────────────────────

/**
 * CMS-1500 (HCFA) Health Insurance Claim Form
 *
 * Detection: "HEALTH INSURANCE CLAIM FORM" or "CMS-1500" or "HCFA" in text
 *
 * Fields extracted (CMS1500 upload type):
 *   - Patient Name (Box 2)
 *   - Date of Service (Box 24A)
 *   - Place of Service (Box 24B)
 *   - CPT/HCPCS Code (Box 24D)
 *   - Modifier (Box 24D modifier)
 *   - Diagnosis Pointer → mapped to Diagnosis Codes from Box 21
 *   - Units Billed (Box 24G)
 *   - Charge Amount (Box 24F)
 */
function detectCMS1500(text: string, filename?: string): boolean {
  return (
    /health insurance claim form/i.test(text) ||
    /NUCC.*02.12/i.test(text) ||
    /CMS.?1500/i.test(text) ||
    (filename ? /cms1500/i.test(filename) : false)
  );
}

/** Parse a CMS1500 date fragment like "06 10 26" or "06 10 2026" → "2026-06-10" */
function parseCMS1500Date(mm: string, dd: string, yy: string): string | null {
  const m = mm.trim().padStart(2, '0');
  const d = dd.trim().padStart(2, '0');
  const y = yy.trim();
  if (!m || !d || !y) return null;
  const year = y.length === 2 ? (parseInt(y) > 50 ? 1900 + parseInt(y) : 2000 + parseInt(y)) : parseInt(y);
  return `${year}-${m}-${d}`;
}

export function parseCMS1500(text: string): Array<{ patientName: string; claims: DateClaimGroup[] }> {
  // ── Extract patient name (Box 2)
  // In layout mode, "Garcia, Isabela" appears on the line AFTER the PATIENT'S NAME label
  // The label line contains "PATIENT'S NAME (Last Name, First Name...)"
  // The value line (a few lines later) contains "Garcia, Isabela"
  let patientName = 'UNKNOWN';
  // Strategy: find lines with "Last, First" pattern that are NOT form labels
  // Exclude lines containing form label keywords
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip form label lines
    if (/NAME.*Last.*First|INSURED'S NAME|OTHER INSURED|REFERRING|PROVIDER/i.test(trimmed)) continue;
    // Match "Garcia, Isabela" or "GARCIA, ISAIAS" pattern
    const m = trimmed.match(/^([A-Za-z][a-zA-Z'\-]+,\s*[A-Za-z][a-zA-Z'\-]+(?:\s+[A-Za-z])?)/); 
    if (m && m[1].length > 5) {
      patientName = m[1].trim().toUpperCase();
      break;
    }
  }

  // ── Extract diagnosis codes from Box 21 (ICD-10 codes like M54.50, M25.551)
  const diagCodes: string[] = [];
  const diagPattern = /([A-Z]\d{2,3}\.\d{1,4})/g;
  let diagMatch: RegExpExecArray | null;
  while ((diagMatch = diagPattern.exec(text)) !== null) {
    const code = diagMatch[1];
    if (!diagCodes.includes(code)) diagCodes.push(code);
  }
  const allDiagCodes = diagCodes.join(', ');

  // ── Extract Date Submitted (Box 31 — physician signature date)
  // In layout mode, appears as "06/15/2026" after "SIGNED" and "DATE" labels
  let dateSubmitted: string | null = null;
  const signedDateMatch = text.match(/SIGNED\s+SOF[\s\S]{0,200}DATE[\s\S]{0,50}(\d{2}\/\d{2}\/\d{4})/);
  if (signedDateMatch) {
    dateSubmitted = parseDate(signedDateMatch[1]);
  } else {
    // Fallback: look for a date after "DATE" label near the bottom of the form
    const dateMatches = Array.from(text.matchAll(/(\d{2}\/\d{2}\/\d{4})/g));
    if (dateMatches.length > 0) {
      // Use the last date found (usually the submission date at the bottom)
      dateSubmitted = parseDate(dateMatches[dateMatches.length - 1][1]);
    }
  }

  // ── Find the section 24 area (service lines)
  // Locate "24. A" or "DATE(S) OF SERVICE" header to anchor the search
  const section24Idx = text.search(/24\.\s*A\.?\s*DATE|DATE\(S\)\s*OF\s*SERVICE/i);
  const serviceArea = section24Idx >= 0 ? text.slice(section24Idx) : text;

  // ── Strategy: find each service line block by its row number prefix (1, 2, 3...)
  // In layout mode, each service line starts with a line number on its own "row"
  // e.g.: "1" then nearby lines have date fragments, CPT, modifier, charge, units
  // We'll collect all CPT codes (9xxxx, G0xxx, etc.) and nearby context

  const dateMap = new Map<string, DateClaimGroup>();

  // Strategy 1: Try to find compact single-line service entries
  // Some PDFs render: "06 10 26 06 10 26 11 97530 GP ABCD 350.00 2"
  const compactPattern = /(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{1,2})\s+((?:9|G|H|T)\d{4})\s+([A-Z0-9 ]+?)\s+([A-Z]{2,6})\s+([\d,]+\.\d{2})\s+(\d+)/g;
  let cm2: RegExpExecArray | null;
  let compactRowCounter = 0; // fallback visit number = this row's position, matching Box 24's own printed row numbers (1-6)
  while ((cm2 = compactPattern.exec(serviceArea)) !== null) {
    compactRowCounter++;
    const fromDate = parseCMS1500Date(cm2[1], cm2[2], cm2[3]);
    const placeOfService = cm2[7];
    const cptCode = cm2[8];
    const modifier = cm2[9].trim().split(/\s+/)[0];
    const chargeAmount = parseMoney(cm2[11]);
    const units = parseInt(cm2[12], 10);
    // visitNumber is the service line's printed position in Box 24 (1-6) —
    // a positional value, not a text label. compactRowCounter already
    // increments once per matched service line in document order.
    const visitNumber = clampVisitNumber(compactRowCounter);
    const dateKey = fromDate || 'no-date';
    if (!dateMap.has(dateKey)) {
      dateMap.set(dateKey, {
        dateOfService: fromDate, placeOfService, diagnosisCodes: allDiagCodes || null,
        claimSubmittedDate: dateSubmitted, visitNumber,
        cptCodes: null, chargeAmount: null, insuranceReimbursement: null,
        patientAmountPaid: null, patientAmountDue: null, unitsBilled: null, modifier: null, cptLines: [],
        // Reimbursement/EOB-only fields — explicit null (not undefined) since
        // a CMS-1500 form never carries claim/check/payment data.
        oaClaimNumber: null, checkDate: null, checkNumberVirtualCard: null, expireBcbsClaimNumber: null,
      });
    }
    dateMap.get(dateKey)!.cptLines.push({
      cptCodes: cptCode, chargeAmount, insuranceReimbursement: null,
      patientAmountPaid: null, patientAmountDue: null, unitsBilled: units, modifier,
      diagnosisCodes: allDiagCodes || null,
    });
  }

  // Strategy 2: Layout-mode extraction — each service line spans multiple physical lines
  // Find CPT codes and extract context from surrounding ±20 lines
  if (dateMap.size === 0) {
    const lines = serviceArea.split('\n');
    const cptLineRe = /\b((?:9|G|H|T)\d{4})\b/;
    // Find service date: look for pattern like "06 I 10 I 26" or "06  10  26" in layout text
    // In layout mode dates appear as: "06 I   I" "10 II 26" or "I 10 I 26 I 06 I 10 I 26 I 11 I"
    const dateFragRe = /(?:I\s*)?(\d{2})\s*(?:I\s*)?(\d{2})\s*(?:I\s*)?(\d{2})\s*(?:I\s*)?(\d{2})\s*(?:I\s*)?(\d{2})\s*(?:I\s*)?(\d{2})\s*(?:I\s*)?(\d{1,2})\s*(?:I\s*)?/;

    let layoutRowCounter = 0; // fallback visit number = this row's position, matching Box 24's own printed row numbers (1-6)
    for (let i = 0; i < lines.length; i++) {
      const cptMatch = lines[i].match(cptLineRe);
      if (!cptMatch) continue;
      layoutRowCounter++;
      const cptCode = cptMatch[1];

      // Look in a window of ±15 lines for date, modifier, charge, units
      const windowStart = Math.max(0, i - 15);
      const windowEnd = Math.min(lines.length - 1, i + 15);
      const window = lines.slice(windowStart, windowEnd + 1).join('\n');

      // Extract date from window
      // In layout mode, date is spread across lines like:
      //   "     06 I   I"
      //   "         10 II 26    I       I"
      //   "                  06 II   10 I 26"
      // Strategy: collect all 2-digit numbers from the window, find the first valid date triple
      let fromDate: string | null = null;
      let placeOfService: string | null = null;

      // Try the compact pattern first (single-line date)
      const dfm = window.match(dateFragRe);
      if (dfm) {
        fromDate = parseCMS1500Date(dfm[1], dfm[2], dfm[3]);
        placeOfService = dfm[7] || null;
      }

      // If no date found, try extracting individual digit groups from the window
      if (!fromDate) {
        // Collect all standalone 2-digit numbers in order from the window lines (before CPT line)
        const preWindow = lines.slice(windowStart, i + 1).join('\n');
        const twoDigits: string[] = [];
        const tdRe = /\b(\d{2})\b/g;
        let tdm: RegExpExecArray | null;
        while ((tdm = tdRe.exec(preWindow)) !== null) {
          twoDigits.push(tdm[1]);
        }
        // Find a valid MM DD YY triple (month 01-12, day 01-31, year 00-99 or 2000-2099)
        for (let j = 0; j < twoDigits.length - 2; j++) {
          const mm = parseInt(twoDigits[j], 10);
          const dd = parseInt(twoDigits[j + 1], 10);
          const yy = parseInt(twoDigits[j + 2], 10);
          if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && yy >= 0 && yy <= 99) {
            // Skip birth dates (year < 30 but month/day look like a date in the past)
            // Service dates will be recent (year 20-30 = 2020-2030)
            const fullYear = yy > 50 ? 1900 + yy : 2000 + yy;
            if (fullYear >= 2020 && fullYear <= 2035) {
              fromDate = `${fullYear}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
              break;
            }
          }
        }
      }

      // Extract place of service from the same line as CPT code
      // Layout: "I     11      I         I        97530        I"
      const cptLine = lines[i];
      let posMatch = cptLine.match(/I\s*(\d{2})\s*I/);
      if (posMatch) placeOfService = posMatch[1];

      // Extract modifier — look for 2-letter code near CPT
      let modifier: string | null = null;
      // Modifier often appears on the same line as CPT or next line
      const modWindow = lines.slice(i, Math.min(lines.length - 1, i + 5)).join(' ');
      const modMatch = modWindow.match(/\b(GP|59|25|51|76|77|KX|CO|GN|GO|GT|95|AT)\b/);
      if (modMatch) modifier = modMatch[1];

      // Extract charge amount + units. Both can land on the line BEFORE, ON, or
      // AFTER the CPT code's own line — the exact vertical position of these form
      // fields in pdftotext -layout output varies per row, not just per document
      // (confirmed against two independently-generated real CMS-1500 PDFs). Digits
      // are also frequently interleaved with stray "I" characters left over from
      // the form's printed field-separator marks (e.g. "175II.00" for $175.00,
      // "1I" for 1 unit) — plain `[\d,]+\.\d{2}` never matches those.
      let chargeAmount: number | null = null;
      let units: number | null = null;
      const rowWindowStart = Math.max(0, i - 2);
      const rowWindowEnd = Math.min(lines.length - 1, i + 3);
      const rowWindow = lines.slice(rowWindowStart, rowWindowEnd + 1).join(' ');
      // (?<!\d) keeps this from matching mid-way through a longer digit run
      // (e.g. an NPI number), since those never contain a decimal point anyway.
      const chargeMatch = rowWindow.match(/(?<!\d)(\d{2,4})\s*I{0,3}\s*\.(\d{2})\b/);
      if (chargeMatch) {
        chargeAmount = parseFloat(`${chargeMatch[1]}.${chargeMatch[2]}`);
        const chargeEnd = chargeMatch.index! + chargeMatch[0].length;
        // Units usually immediately follows the charge ("350.00 2", "175II.00 1I").
        const afterCharge = rowWindow.slice(chargeEnd, chargeEnd + 20);
        const afterUnitsMatch = afterCharge.match(/\b(\d{1,2})I?\b/);
        if (afterUnitsMatch) {
          units = parseInt(afterUnitsMatch[1], 10);
        } else {
          // Fall back to searching before the charge, taking the LAST (closest)
          // match so an earlier date fragment on the same row isn't picked up
          // instead of the actual units value.
          const beforeCharge = rowWindow.slice(Math.max(0, chargeMatch.index! - 150), chargeMatch.index!);
          const beforeMatches = Array.from(beforeCharge.matchAll(/\b(\d{1,2})I?\b/g));
          if (beforeMatches.length > 0) units = parseInt(beforeMatches[beforeMatches.length - 1][1], 10);
        }
      }

      // visitNumber is the service line's printed position in Box 24 (1-6) —
      // a positional value, not a text label. layoutRowCounter already
      // increments once per matched service line in document order.
      const visitNumber = clampVisitNumber(layoutRowCounter);

      const dateKey = fromDate || 'no-date';
      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, {
          dateOfService: fromDate, placeOfService, diagnosisCodes: allDiagCodes || null,
          claimSubmittedDate: dateSubmitted, visitNumber,
          cptCodes: null, chargeAmount: null, insuranceReimbursement: null,
          patientAmountPaid: null, patientAmountDue: null, unitsBilled: null, modifier: null, cptLines: [],
        });
      }
      dateMap.get(dateKey)!.cptLines.push({
        cptCodes: cptCode, chargeAmount, insuranceReimbursement: null,
        patientAmountPaid: null, patientAmountDue: null,
        unitsBilled: units, modifier, diagnosisCodes: allDiagCodes || null,
      });
    }
  }

  const claims = Array.from(dateMap.values());
  if (claims.length === 0) return [];

  // bulkImportFromEOB (server/routers.ts) reads per-service-line data from
  // cptLines when present, but falls back to the DateClaimGroup's own
  // top-level fields when cptLines is empty (e.g. the date/POS/diagnosis
  // area matched but no individual service line did) — so those top-level
  // fields shouldn't be left at their placeholder null forever when at least
  // one cptLine was actually found. Representative of the group's first line;
  // exact for the common single-CPT-line-per-date case.
  for (const claim of claims) {
    if (claim.cptLines.length > 0) {
      const first = claim.cptLines[0];
      claim.cptCodes = claim.cptLines.map(l => l.cptCodes).filter(Boolean).join(', ') || null;
      claim.chargeAmount = first.chargeAmount;
      claim.unitsBilled = first.unitsBilled;
      claim.modifier = first.modifier;
    }
  }

  return [{ patientName, claims }];
}

// ─── Template Registry ───────────────────────────────────────────────────────

interface InsuranceTemplate {
  name: string;
  detect: (text: string, filename?: string) => boolean;
  parse: (text: string) => ExtractedClaim[];
}

const TEMPLATES: InsuranceTemplate[] = [
  {
    name: 'Meritain Health EOB',
    detect: (text, filename) =>
      detectMeritain(text) ||
      (filename ? /^epp_/i.test(filename) : false),
    parse: parseMeritainEOB,
  },
  // Add more templates here as new insurers are onboarded:
  // { name: 'Aetna EOB', detect: detectAetna, parse: parseAetnaEOB },
  // { name: 'BCBS Remittance', detect: detectBCBS, parse: parseBCBSRemittance },
  // { name: 'Cigna EOB', detect: detectCigna, parse: parseCignaEOB },
  // { name: 'Medicare Advantage EOB', detect: detectMedicare, parse: parseMedicareEOB },
];

/**
 * Try to match the extracted text to a known insurance template.
 * Returns the template result if matched, or null if no template matches
 * (caller should fall back to AI extraction).
 *
 * Can also throw PatientBoundaryError (propagated from a template's parser,
 * e.g. parseMeritainEOBWithGroups) when the document's patient sections
 * can't be reliably told apart. That is NOT a "no template matched" case —
 * the caller must treat it as a hard extraction failure (surface it to the
 * user, do not fall back to AI extraction, do not build an empty/partial
 * result) rather than catching it here.
 */
export function tryTemplateExtraction(
  text: string,
  filename?: string
): TemplateResult | null {
  for (const template of TEMPLATES) {
    if (template.detect(text, filename)) {
      const claims = template.parse(text);
      // For Meritain, also return per-patient groups
      let patientGroups: PatientClaimGroup[] | undefined;
      if (template.name === 'Meritain Health EOB') {
        patientGroups = parseMeritainEOBWithGroups(text);
      }
      return {
        templateName: template.name,
        claims,
        patientGroups,
      };
    }
  }
  return null;
}
