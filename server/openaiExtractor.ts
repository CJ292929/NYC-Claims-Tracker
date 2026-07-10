import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import type { ExtractedClaim } from "./insuranceTemplates";

export interface OpenAIClaimExtractionResult {
  claims: ExtractedClaim[];
  confidence: number; // 0-1 score indicating extraction confidence
  detectedInsurer?: string;
  extractionNotes?: string;
  patientName?: string; // Top-level patient name if all claims are for same patient
}

/**
 * Extract claims from PDF text using OpenAI's structured JSON capabilities
 * Handles both Reimbursement (EOB) and CMS1500 upload types
 * CRITICAL: Ensures patient name is extracted for each claim
 */
export async function extractClaimsWithOpenAI(
  pdfText: string,
  uploadType: "reimbursement" | "cms1500"
): Promise<OpenAIClaimExtractionResult> {
  const systemPrompt =
    uploadType === "reimbursement"
      ? `You are a medical claims data extraction specialist. Extract all Explanation of Benefits (EOB) claim information accurately from the provided document text.

*** CRITICAL: You MUST extract the PATIENT NAME for EACH claim. This is required for matching against the clinic's patient database. ***

For each claim, extract:
- patientName: REQUIRED - full name as shown on document (e.g., "JOHN SMITH" or "Smith, John" or "JOHN M SMITH")
- dateOfService: MM/DD/YYYY format
- cptCodes: CPT code(s), comma-separated if multiple
- chargeAmount: total charge amount (numeric only, no $ sign)
- insuranceReimbursement: insurance reimbursement/allowed amount (numeric only)
- patientAmountPaid: patient co-pay amount (numeric only)
- patientAmountDue: patient balance due (numeric only)
- oaClaimNumber: claim number
- checkDate: check/payment date in MM/DD/YYYY format
- checkNumberVirtualCard: check number or virtual card number
- claimStatus: one of "approved", "denied", or "submitted"

IMPORTANT:
- If patient name appears in document header/top section, use it for ALL claims in that section
- If multiple patients in document, create separate claim objects for each patient
- Patient name is REQUIRED - never leave it null or empty
- Return ONLY valid JSON, no markdown or explanations.`
      : `You are a medical claims data extraction specialist. Extract all CMS-1500 Health Insurance Claim Form information accurately from the provided document text.

*** CRITICAL: You MUST extract the PATIENT NAME from Box 2. This is required for matching against the clinic's patient database. ***

For each claim, extract:
- patientName: REQUIRED - from Box 2 of form (e.g., "JOHN SMITH" or "Smith, John")
- dateOfService: MM/DD/YYYY format (from Box 24A)
- placeOfService: place of service code (from Box 24B)
- cptCodes: CPT/HCPCS code(s), comma-separated if multiple (from Box 24D)
- diagnosisCodes: ICD-10 diagnosis codes, comma-separated (from Box 21)
- unitsBilled: units billed (from Box 24G)
- modifier: modifier codes if present (from Box 24D)
- chargeAmount: total charge amount (numeric only)

IMPORTANT:
- Patient name is REQUIRED - never leave it null or empty
- Return ONLY valid JSON, no markdown or explanations.`;

  const userPrompt =
    uploadType === "reimbursement"
      ? `Extract all EOB claims from this document. IMPORTANT: Make sure to extract the patient name for each claim.\n\n${pdfText}`
      : `Extract all CMS-1500 claims from this document. IMPORTANT: Make sure to extract the patient name from Box 2 for each claim.\n\n${pdfText}`;

  try {
    const response = await invokeLLM({
      model: ENV.openaiModel,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
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
                  properties: {
                    patientName: { type: "string" }, // REQUIRED
                    dateOfService: { type: ["string", "null"] },
                    cptCodes: { type: ["string", "null"] },
                    chargeAmount: { type: ["number", "null"] },
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
                    placeOfService: { type: ["string", "null"] },
                    diagnosisCodes: { type: ["string", "null"] },
                    unitsBilled: { type: ["number", "null"] },
                    modifier: { type: ["string", "null"] },
                  },
                  required: ["patientName", "claimStatus"],
                },
              },
              detectedInsurer: { type: ["string", "null"] },
              confidence: { type: "number" },
              extractionNotes: { type: ["string", "null"] },
            },
            required: ["claims"],
          },
        },
      },
    });

    const content = response.choices[0].message.content;
    if (!content || typeof content !== "string") {
      throw new Error("No response from OpenAI");
    }

    const parsed = JSON.parse(content);

    // Normalize the response to match ExtractedClaim format
    const normalizedClaims: ExtractedClaim[] = (parsed.claims || []).map(
      (claim: any) => ({
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
        insuranceBilled: parsed.detectedInsurer || "Unknown",
        claimSubmittedDate: null,
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

    // Extract top-level patient name if all claims are for the same patient
    const uniquePatientNames = new Set(
      parsed.claims.map((c: any) => c.patientName?.toUpperCase().trim())
    );
    const patientName =
      uniquePatientNames.size === 1
        ? Array.from(uniquePatientNames)[0]
        : undefined;

    return {
      claims: normalizedClaims,
      confidence: parsed.confidence || 0.8,
      detectedInsurer: parsed.detectedInsurer,
      extractionNotes: parsed.extractionNotes,
      patientName: patientName as string | undefined,
    };
  } catch (error) {
    console.error("[OpenAI Extraction Error]", error);
    throw new Error(
      `Failed to extract claims with OpenAI: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Detect if a document is likely a specific insurance format
 * Uses OpenAI to identify the insurer and document type
 */
export async function detectInsuranceType(pdfText: string): Promise<{
  insurer: string;
  documentType: "eob" | "cms1500" | "other";
  confidence: number;
}> {
  try {
    const response = await invokeLLM({
      model: ENV.openaiModel,
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
          },
        },
      },
    });

    const content = response.choices[0].message.content;
    if (!content || typeof content !== "string") {
      throw new Error("No response from OpenAI");
    }

    return JSON.parse(content);
  } catch (error) {
    console.error("[Insurance Detection Error]", error);
    return {
      insurer: "Unknown",
      documentType: "other",
      confidence: 0,
    };
  }
}
