import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import type { ExtractedClaim } from "./insuranceTemplates";

/** A claim as returned by the AI extractor, with patient attribution preserved
 *  per-claim (documents like a combined multi-patient EOB list many different
 *  patients on one page — the top-level `patientName` on the result is only
 *  set when every claim happens to share one name). */
export type AIExtractedClaim = ExtractedClaim & { patientName?: string | null };

export interface AIClaimExtractionResult {
  claims: AIExtractedClaim[];
  confidence: number; // 0-1 score indicating extraction confidence
  detectedInsurer?: string;
  extractionNotes?: string;
  patientName?: string; // Top-level patient name if all claims are for same patient
}

/** Where to source the document content from for extraction. */
export type ExtractionSource =
  | { kind: "text"; text: string }
  | { kind: "pdf"; buffer: Buffer; filename: string };

/**
 * Best-effort recovery for LLM responses that don't come back as clean JSON —
 * e.g. wrapped in a markdown code fence despite instructions not to, or with
 * leading/trailing prose. Returns null (never throws) when nothing usable is
 * found so callers can fall back to the next extraction stage.
 */
function recoverJson(raw: string): any | null {
  const attempts = [
    raw,
    raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""),
  ];

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt.trim());
    } catch {
      // try next
    }
  }

  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Checks whether a claim's CPT code and dollar amounts actually appear as
 * substrings in the exact source text the model was given. Returns a list of
 * human-readable warnings (empty if everything checks out) — see the call
 * site for why this flags rather than discards.
 */
function verifyClaimAgainstSourceText(claim: ExtractedClaim, sourceText: string): string[] {
  const warnings: string[] = [];

  if (claim.cptCodes) {
    // Some source documents fuse the CPT code and its modifier together with
    // no separator (e.g. "9714059GP" = CPT 97140 + modifiers 59/GP) — check
    // the raw string first, then fall back to just the leading CPT portion
    // so that fusion alone doesn't trigger a false warning.
    const cptCore = claim.cptCodes.match(/^[A-Z]?\d{4,5}/)?.[0] ?? claim.cptCodes;
    if (!sourceText.includes(claim.cptCodes) && !sourceText.includes(cptCore)) {
      warnings.push(`CPT "${claim.cptCodes}" not found in source text`);
    }
  }

  const checkAmount = (label: string, value: number | null | undefined) => {
    if (value === null || value === undefined) return;
    const withCents = value.toFixed(2);
    const withoutCents = String(Math.trunc(value));
    if (!sourceText.includes(withCents) && !sourceText.includes(withoutCents)) {
      warnings.push(`${label} ${withCents} not found in source text`);
    }
  };
  checkAmount("Charge", claim.chargeAmount);
  checkAmount("Reimbursement", claim.insuranceReimbursement);
  checkAmount("Patient due", claim.patientAmountDue);

  const checkStringField = (label: string, value: string | null | undefined) => {
    if (!value) return;
    if (!sourceText.includes(value)) {
      warnings.push(`${label} "${value}" not found in source text`);
    }
  };
  checkStringField("Claim #", claim.oaClaimNumber);
  checkStringField("Check/EFT", claim.checkNumberVirtualCard);

  // Co-occurrence check: catches "right values, wrong row" fabrication that
  // the independent checks above can't see — e.g. a model that sees the same
  // 4 CPT codes repeat across two dates and extends that pattern to a third
  // date that actually only has 2 service lines. Each individual value
  // (CPT, charge) is real and passes the checks above, since it's copied
  // verbatim from a DIFFERENT line elsewhere in the document; only checking
  // that they appear TOGETHER on one line catches the fabricated combination.
  if (claim.cptCodes && claim.chargeAmount != null) {
    const cptCore = claim.cptCodes.match(/^[A-Z]?\d{4,5}/)?.[0] ?? claim.cptCodes;
    const chargeStr = claim.chargeAmount.toFixed(2);
    const chargeStrNoCents = String(Math.trunc(claim.chargeAmount));
    const coOccurs = sourceText.split("\n").some(
      (line) =>
        (line.includes(claim.cptCodes!) || line.includes(cptCore)) &&
        (line.includes(chargeStr) || line.includes(chargeStrNoCents))
    );
    if (!coOccurs) {
      warnings.push(
        `CPT "${claim.cptCodes}" and charge ${chargeStr} each appear somewhere in source text but never together on the same line — possible pattern-completion fabrication`
      );
    }
  }

  return warnings;
}

/**
 * Finds the single line of source text a claim's CPT code appears on, so
 * staff reviewing the extraction can see the literal text a claim was read
 * from without having to re-open the source document. Best-effort only —
 * returns null rather than guessing when the code can't be located (e.g.
 * the vision/PDF path, which has no separate source text to search).
 */
function findSourceLineForClaim(claim: ExtractedClaim, sourceText: string): string | null {
  if (!claim.cptCodes) return null;
  const cptCore = claim.cptCodes.match(/^[A-Z]?\d{4,5}/)?.[0] ?? claim.cptCodes;
  const line = sourceText
    .split("\n")
    .find((l) => l.includes(claim.cptCodes!) || l.includes(cptCore));
  return line ? line.trim().replace(/\s+/g, " ") : null;
}

/**
 * Extract claims from PDF text using the configured AI provider's structured
 * JSON capabilities (see server/_core/llm.ts — OpenAI GPT-4 Vision by
 * default, swappable via AI_PROVIDER). Handles both Reimbursement (EOB) and
 * CMS1500 upload types.
 * CRITICAL: Ensures patient name is extracted for each claim
 */
export async function extractClaimsWithAI(
  source: ExtractionSource,
  uploadType: "reimbursement" | "cms1500"
): Promise<AIClaimExtractionResult> {
  console.log(`[AIExtractor] Starting ${uploadType} extraction (source: ${source.kind}, provider: ${ENV.aiProvider})`);

  const systemPrompt =
    uploadType === "reimbursement"
      ? `You are a medical claims data extraction specialist with deep experience reading Explanation of Benefits (EOB) and remittance advice documents from every major US payer (Aetna, UnitedHealthcare/Optum, Cigna, Humana, Medicare/Medicare Advantage administrators like Wellpoint/NGS, BCBS, Meritain, and others). Extract all claim information accurately from the provided document text.

*** CRITICAL: You MUST extract the PATIENT NAME for EACH claim, individually. This is required for matching against the clinic's patient database. ***

*** DOCUMENT-TYPE BOUNDARY: This is a Reimbursement/EOB document. Only extract payment-side data — insuranceReimbursement, patientAmountPaid, patientAmountDue, oaClaimNumber (Claim #), checkDate (Check/Payment Date), and checkNumberVirtualCard (Check/EFT) — plus dateOfService and cptCodes, which you extract ONLY to identify which existing claim this payment applies to, never as billing data. NEVER extract placeOfService, diagnosisCodes, unitsBilled, modifier, or chargeAmount — those belong exclusively to CMS-1500 claim forms and must not appear on a Reimbursement/EOB record. ***

Payers lay these documents out very differently — a table of many patients on one page, a single-patient web-portal export, a per-claim narrative block, etc. Do not assume there is only one patient name at the top of the document: scan the ENTIRE document and re-identify the patient name at each claim/service-line block, since one EOB commonly covers many different patients (e.g. a check remitting payment for a whole clinic's batch of claims).

For each claim/service line, extract EVERY one of these fields when it appears anywhere in the document — a payment line's reimbursement, patient-paid, patient-due, claim #, check date, and check/EFT number are often printed in different parts of the same claim block, not all in one place, so check the whole block before leaving any of them null:
- patientName: REQUIRED - full name exactly as shown next to that specific claim (e.g., "JOHN SMITH" or "Smith, John" or "JOHN M SMITH"). Never reuse a different claim's patient name.
- dateOfService: MM/DD/YYYY format — extracted only to match this payment to the correct existing claim record, not as reimbursement data
- cptCodes: CPT/HCPCS code(s), comma-separated if multiple — extracted only to match this payment to the correct existing claim record, not as reimbursement data
- insuranceReimbursement: insurance reimbursement/allowed/paid amount (numeric only)
- patientAmountPaid: patient co-pay amount already paid (numeric only)
- patientAmountDue: patient balance/responsibility still due (numeric only)
- oaClaimNumber: claim number/ID/ICN/reference number for this claim — copy it character-for-character exactly as printed; never reformat, abbreviate, or invent one
- checkDate: check/payment/EFT date in MM/DD/YYYY format
- checkNumberVirtualCard: check number, EFT trace number, or virtual card number
- claimStatus: one of "approved", "denied", or "submitted" (infer from context — e.g. a $0 paid line with a denial code is "denied"; a line with a payment amount is "approved")
- insuranceBilled: the specific payer THIS claim was billed to/forwarded to — read the text right next to this claim (e.g. a "CLAIM INFORMATION FORWARDED TO: <payer>" line, or a payer name printed within this claim's own block). Do NOT default to the document's letterhead/logo — some documents (e.g. a Medicare administrator's EOB) print one org's letterhead at the top but list a DIFFERENT payer per claim/per patient below it, and each claim's own payer can differ from its neighbors'. Only fall back to the letterhead org if no claim-specific payer text exists at all.

FIELD NAME VARIATIONS — the same data point is labeled differently across payers; map by meaning, not by exact label. Some payers print several *different, non-interchangeable* dollar columns — read carefully, don't just grab the first similar-sounding label:
- Insurance Reimbursement = the amount the payer actually PAID/will pay: "Paid Amount", "Payable Amount", "Plan Paid", "Claim Payment Amount". This is NOT the same as "Allowed Amount"/"Allowable"/"QPA" — that is only the contractually recognized rate the patient-responsibility math is based on, and is often larger than what was actually paid (especially out-of-network). If both an "Allowed" and a "Paid"/"Payable" column exist, use the "Paid"/"Payable" one.
- Patient Due = the patient's owed balance under the plan: "Patient Responsibility", "Patient Resp", "Balance Due", or Copay + Deductible + Coinsurance summed. Some EOBs separately print a "Not Payable"/"Not Covered" column for amounts the plan simply doesn't cover — that is a different concept from Patient Responsibility (it's often only billable to the patient if a separate balance-billing agreement applies) — prefer the explicit "Patient Responsibility" figure when both are present.
- Claim Number = "Claim ID", "ICN", "Reference #", "Claim #", "Transaction ID", "Control Number"
- Check/Payment Date = "Payment Date", "Check Date", "Direct Deposit Date", "EFT Date"
- Auto/PIP (e.g. GEICO) EOBs use their own labels: Date of Service = "DOS"; CPT Codes = "PROC CODE"; Charge = "CHARGE". These documents commonly print a "REDUCTION" column — this is the insurer's own fee-schedule/contractual reduction, NOT patientAmountDue. No-fault auto/PIP coverage typically has zero patient responsibility, so do not map REDUCTION to patientAmountDue just because it's a dollar amount near the charge/paid columns; if no explicit patient-responsibility label exists, patientAmountDue is null. insuranceReimbursement on these documents is usually labeled "PROVIDER REIMBURSE".

IMPORTANT:
- Re-identify patient name per claim/service-line block — do NOT assume one name applies to the whole document
- If multiple patients are in the document, create separate claim objects for each patient's claims
- Patient name is REQUIRED - never leave it null or empty
- Use null (not a guess) for any field that isn't actually visible in the document — do not use outside/training knowledge to fill a gap (e.g. don't infer an insurer's usual claim number format, or a typical charge for a CPT code); if it isn't printed in this text, it's null
- Each individual service line is its own claim object — never combine two service lines (e.g. two different CPT codes) into one object. If you see two CPT codes on what looks like one row, that's two service lines that got visually close together; output them as two separate claim objects, never as one object with a comma-joined cptCodes value.
- Never output a CLAIM TOTALS, SUBTOTAL, or grand-total row as a service line — those summary rows repeat/sum the individual lines' amounts (e.g. a $700 total when the actual lines are $350/$175/$175) and must be skipped entirely, not extracted as their own claim or used as any line's chargeAmount.
- Do not complete patterns. If one date has 4 service lines and a later date for the same patient has only 2, output exactly 2 for that date — do not add the other 2 CPT codes just because they appeared on the earlier dates. Repetition across dates is a coincidence of the data, not a rule to extend. Count the actual service lines under each date before outputting; never output more rows for a date than that date actually has.
- Return ONLY valid JSON, no markdown or explanations.`
      : `You are a medical claims data extraction specialist. Extract all CMS-1500 Health Insurance Claim Form information accurately from the provided document text.

*** CRITICAL: You MUST extract the PATIENT NAME from Box 2. This is required for matching against the clinic's patient database. ***

*** DOCUMENT-TYPE BOUNDARY: This is a CMS-1500 claim form. Only extract billing-side data — dateOfService, placeOfService, diagnosisCodes, unitsBilled, modifier, cptCodes, and chargeAmount. NEVER extract insuranceReimbursement, patientAmountPaid, patientAmountDue, oaClaimNumber (Claim #), checkDate, or checkNumberVirtualCard (Check/EFT) — those belong exclusively to Reimbursement/EOB payment documents and a CMS-1500 form never carries that data. ***

For each service line, extract EVERY one of these fields when it appears anywhere in the document — do not leave a field null just because it wasn't on the exact box you checked first; CPT/charge/units/modifier are frequently printed on the same physical row and must all be read together:
- patientName: REQUIRED - from Box 2 of form (e.g., "JOHN SMITH" or "Smith, John")
- dateOfService: MM/DD/YYYY format (from Box 24A)
- placeOfService: place of service code (from Box 24B)
- cptCodes: CPT/HCPCS code(s), comma-separated if multiple (from Box 24D)
- diagnosisCodes: ICD-10 diagnosis codes, comma-separated (from Box 21)
- unitsBilled: units/days billed (from Box 24G — labeled "DAYS OR UNITS")
- modifier: modifier codes if present (from Box 24D, immediately after the CPT code)
- chargeAmount: total charge amount for this line (numeric only, from Box 24F)
- claimSubmittedDate: MM/DD/YYYY format — the physician/supplier signature date (from Box 31, usually printed after "SIGNED"/"DATE")
- insuranceBilled: the insurance plan/payer name this form was submitted to (from Box 11c "Insurance Plan Name" if present, otherwise Box 1 "Other" plan name, otherwise the carrier name printed in the form's letterhead/address block)

IMPORTANT:
- Patient name is REQUIRED - never leave it null or empty
- Extract one service line = one claim object. A CMS-1500 form with multiple service lines (Box 24, rows 1-6) must produce one claim object per row, each with its OWN dateOfService/cptCodes/chargeAmount/unitsBilled/modifier — never merge two rows together or repeat the same row's values across every date.
- Use null (not a guess) only for a field that is genuinely not visible anywhere in the document — do not leave a field null when the value is printed on the form.
- Return ONLY valid JSON, no markdown or explanations.`;

  const instruction =
    uploadType === "reimbursement"
      ? "Extract all EOB claims from this document. IMPORTANT: Make sure to extract the patient name for each claim."
      : "Extract all CMS-1500 claims from this document. IMPORTANT: Make sure to extract the patient name from Box 2 for each claim.";

  // Two ways to hand the document to the model:
  //  - text: pre-extracted text (from pdftotext/pdfjs) — cheaper, works when
  //    local extraction succeeded.
  //  - pdf: the raw PDF bytes, read natively by the model's own vision/document
  //    understanding — used when no local extraction method is available
  //    (e.g. serverless environments without pdftotext or a canvas backend).
  const userContent =
    source.kind === "text"
      ? `${instruction}\n\n${source.text}`
      : [
          { type: "text" as const, text: instruction },
          {
            type: "file" as const,
            file: {
              filename: source.filename,
              file_data: `data:application/pdf;base64,${source.buffer.toString("base64")}`,
            },
          },
        ];

  // Scoped to each document type's valid fields (mirrors the field-boundary
  // rules enforced by enforceFieldBoundary in claimUpload.ts). OpenAI's strict
  // json_schema mode requires every property to be listed in `required`, so
  // telling the model in the prompt not to fill a field isn't sufficient on
  // its own — the property must not exist in the schema at all for that
  // upload type, or the model can still populate it.
  // dateOfService/cptCodes appear on both schemas because a Reimbursement
  // upload needs them to match this payment to its existing CMS-1500 claim
  // row — not as reimbursement-document data to display.
  const reimbursementClaimProperties = {
    patientName: { type: "string" }, // REQUIRED
    dateOfService: { type: ["string", "null"] },
    cptCodes: { type: ["string", "null"] },
    insuranceReimbursement: { type: ["number", "null"] },
    patientAmountPaid: { type: ["number", "null"] },
    patientAmountDue: { type: ["number", "null"] },
    oaClaimNumber: { type: ["string", "null"] },
    checkDate: { type: ["string", "null"] },
    checkNumberVirtualCard: { type: ["string", "null"] },
    claimStatus: {
      type: "string",
      enum: ["submitted", "approved", "denied"],
    },
    insuranceBilled: { type: ["string", "null"] },
  } as const;

  const cms1500ClaimProperties = {
    patientName: { type: "string" }, // REQUIRED
    dateOfService: { type: ["string", "null"] },
    cptCodes: { type: ["string", "null"] },
    chargeAmount: { type: ["number", "null"] },
    placeOfService: { type: ["string", "null"] },
    diagnosisCodes: { type: ["string", "null"] },
    unitsBilled: { type: ["number", "null"] },
    modifier: { type: ["string", "null"] },
    claimSubmittedDate: { type: ["string", "null"] },
    claimStatus: {
      type: "string",
      enum: ["submitted", "approved", "denied"],
    },
    insuranceBilled: { type: ["string", "null"] },
  } as const;

  const claimItemProperties =
    uploadType === "reimbursement" ? reimbursementClaimProperties : cms1500ClaimProperties;

  try {
    const response = await invokeLLM({
      model: ENV.aiModel,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userContent,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "claim_extraction",
          strict: true,
          schema: {
            type: "object",
            properties: {
              claims: {
                type: "array",
                items: {
                  type: "object",
                  properties: claimItemProperties,
                  // OpenAI's strict json_schema mode rejects the request unless every
                  // property is listed here (use a nullable type for "optional" fields)
                  // and additionalProperties is explicitly false — Anthropic's tool-use
                  // schema validation is more lenient and accepts this shape too, so one
                  // schema definition works for both adapters.
                  required: Object.keys(claimItemProperties),
                  additionalProperties: false,
                },
              },
              detectedInsurer: { type: ["string", "null"] },
              confidence: { type: "number" },
              extractionNotes: { type: ["string", "null"] },
            },
            required: ["claims", "detectedInsurer", "confidence", "extractionNotes"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("No response from AI provider");
    }

    const parsed = recoverJson(content);
    if (!parsed) {
      console.error("[AIExtractor] Could not parse AI response as JSON:", content.slice(0, 500));
      throw new Error("AI provider returned malformed JSON that could not be recovered");
    }

    const claimsArray: any[] = Array.isArray(parsed.claims) ? parsed.claims : [];

    // Normalize the response to match ExtractedClaim format
    const normalizedClaims: AIExtractedClaim[] = claimsArray.map(
      (claim: any) => ({
        // Preserved per-claim (not just the aggregate top-level patientName below)
        // so multi-patient documents — e.g. a single combined EOB covering many
        // patients on one check — don't lose per-claim patient attribution.
        patientName: claim.patientName ? String(claim.patientName).trim() : null,
        dateOfService: claim.dateOfService || null,
        cptCodes: claim.cptCodes || null,
        chargeAmount:
          claim.chargeAmount !== null && claim.chargeAmount !== undefined
            ? Number(claim.chargeAmount)
            : null,
        insuranceReimbursement:
          claim.insuranceReimbursement !== null &&
          claim.insuranceReimbursement !== undefined
            ? Number(claim.insuranceReimbursement)
            : null,
        patientAmountPaid:
          claim.patientAmountPaid !== null && claim.patientAmountPaid !== undefined
            ? Number(claim.patientAmountPaid)
            : null,
        patientAmountDue:
          claim.patientAmountDue !== null && claim.patientAmountDue !== undefined
            ? Number(claim.patientAmountDue)
            : null,
        oaClaimNumber: claim.oaClaimNumber || null,
        checkDate: claim.checkDate || null,
        checkNumberVirtualCard: claim.checkNumberVirtualCard || null,
        claimStatus: claim.claimStatus || "submitted",
        placeOfService: claim.placeOfService || null,
        diagnosisCodes: claim.diagnosisCodes || null,
        unitsBilled:
          claim.unitsBilled !== null && claim.unitsBilled !== undefined
            ? Number(claim.unitsBilled)
            : null,
        modifier: claim.modifier || null,
        // Prefer the payer identified for THIS specific claim (e.g. its own
        // "forwarded to" line) over the document-wide detectedInsurer — some
        // documents print one org's letterhead but list a different payer per
        // claim/per patient below it (see the multi-patient scanning note
        // above), so applying detectedInsurer to every claim uniformly would
        // mislabel any claim whose actual payer differs from the letterhead.
        insuranceBilled: claim.insuranceBilled || parsed.detectedInsurer || "Unknown",
        claimSubmittedDate: claim.claimSubmittedDate || null,
        expireBcbsClaimNumber: null,
        paymentReceived: null,
        lmn: null,
        dateReceived: null,
        referenceNo: null,
        visitNumber: 0,
        dateOfAppeal: null,
        notes: parsed.extractionNotes || null,
      })
    );

    // Cheap, deterministic anti-hallucination check — only possible when we
    // have the exact source text the model saw (not for the 'pdf' vision
    // path, where there's no separately-extracted text to compare against).
    // Never discards a claim on failure: a false positive here (unusual
    // source formatting, e.g. a CPT code fused with its modifier) is far
    // cheaper than silently dropping real data, so mismatches are surfaced
    // in `notes` for staff review instead of filtered out.
    if (source.kind === "text") {
      for (const claim of normalizedClaims) {
        const warnings = verifyClaimAgainstSourceText(claim, source.text);
        if (warnings.length > 0) {
          console.warn(
            `[AIExtractor] Verification warning (CPT ${claim.cptCodes}, DOS ${claim.dateOfService}):`,
            warnings.join("; ")
          );
          claim.notes = [claim.notes, `⚠️ Unverified against source: ${warnings.join("; ")}`]
            .filter(Boolean)
            .join(" | ");
        }

        // Audit trail: attach the literal source line a claim's CPT code was
        // read from, regardless of verification outcome, so staff reviewing
        // the extraction (before it's saved) can eyeball it against the
        // structured fields without reopening the source document.
        const sourceLine = findSourceLineForClaim(claim, source.text);
        if (sourceLine) {
          claim.notes = [claim.notes, `📄 Source: "${sourceLine}"`]
            .filter(Boolean)
            .join(" | ");
        }
      }
    }

    // Extract top-level patient name if all claims are for the same patient
    const uniquePatientNames = new Set(
      claimsArray.map((c: any) => c.patientName?.toUpperCase().trim())
    );
    const patientName =
      uniquePatientNames.size === 1
        ? Array.from(uniquePatientNames)[0]
        : undefined;

    console.log(`[AIExtractor] Extracted ${normalizedClaims.length} claim(s), confidence ${parsed.confidence ?? "n/a"}`);

    return {
      claims: normalizedClaims,
      confidence: parsed.confidence || 0.8,
      detectedInsurer: parsed.detectedInsurer,
      extractionNotes: parsed.extractionNotes,
      patientName: patientName as string | undefined,
    };
  } catch (error) {
    console.error("[AIExtractor] Extraction error:", error);
    throw new Error(
      `Failed to extract claims with AI (${ENV.aiProvider}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Detect if a document is likely a specific insurance format. Uses the
 * configured AI provider to identify the insurer and document type.
 */
export async function detectInsuranceType(pdfText: string): Promise<{
  insurer: string;
  documentType: "eob" | "cms1500" | "other";
  confidence: number;
}> {
  try {
    const response = await invokeLLM({
      model: ENV.aiModel,
      messages: [
        {
          role: "system",
          content: `You are an insurance document classifier. Identify the insurance company and document type from the provided text.

Return a JSON object with:
- insurer: The insurance company name (e.g., "Meritain Health", "Aetna", "BCBS", "Cigna", "Medicare", "UnitedHealth")
- documentType: Either "eob" (Explanation of Benefits), "cms1500" (CMS-1500 form), or "other"
- confidence: A number between 0 and 1 indicating how confident you are in the classification

Return ONLY valid JSON, no markdown.`,
        },
        {
          role: "user",
          content: `Identify the insurance company and document type from this text:\n\n${pdfText.substring(0, 2000)}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "insurance_detection",
          strict: true,
          schema: {
            type: "object",
            properties: {
              insurer: { type: "string" },
              documentType: {
                type: "string",
                enum: ["eob", "cms1500", "other"],
              },
              confidence: { type: "number" },
            },
            required: ["insurer", "documentType", "confidence"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("No response from AI provider");
    }

    const parsed = recoverJson(content);
    if (!parsed) {
      throw new Error("AI provider returned malformed JSON for insurance detection");
    }
    return parsed;
  } catch (error) {
    console.error("[AIExtractor] Insurance detection error:", error);
    return {
      insurer: "Unknown",
      documentType: "other",
      confidence: 0,
    };
  }
}
