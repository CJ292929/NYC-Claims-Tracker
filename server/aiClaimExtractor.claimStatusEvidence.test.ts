/**
 * server/aiClaimExtractor.claimStatusEvidence.test.ts
 *
 * P4-P14: reported bug — an Anthem/BCBS claim row showed "Denied" despite a
 * present, non-zero insurance reimbursement amount. Anthem/BCBS has no
 * dedicated regex template (see server/insuranceTemplates.ts's commented-out
 * "BCBS Remittance" entry), so it goes through extractClaimsWithAI's AI
 * extraction path — this file tests reconcileClaimStatusWithPaymentEvidence,
 * the deterministic, line-local correction applied to every AI-extracted
 * claim after the model's own claimStatus guess.
 *
 * No live LLM call: invokeLLM is mocked to return a fixed structured
 * response (same pattern as
 * server/aiClaimExtractor.reimbursementLineItems.test.ts), using synthetic,
 * fictional claim data modeled on the reported Anthem/BCBS EOB shape — no
 * real PHI, and the staff's actual source PDF was not used or tested here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./_core/llm', () => ({ invokeLLM: vi.fn() }));

import { invokeLLM } from './_core/llm';
import { extractClaimsWithAI, reconcileClaimStatusWithPaymentEvidence } from './aiClaimExtractor';
import type { ExtractedClaim } from './insuranceTemplates';

const invokeLLMMock = vi.mocked(invokeLLM);

const SYNTHETIC_ANTHEM_EOB_TEXT = `
SAMPLE ANTHEM BLUE CROSS BLUE SHIELD EOB — SYNTHETIC TEST FIXTURE, NOT A REAL DOCUMENT
Patient: JOHN TESTPATIENT
Claim #: AB-55021

This claim contains one or more denied service lines. See remark codes below.

DATE: 02/10/2026  CPT: 97110  BILLED: $120.00  PAID: $96.00  STATUS: Paid
DATE: 02/10/2026  CPT: 97140  BILLED: $80.00  PAID: $0.00  REMARK: CO-50 Not medically necessary  STATUS: Denied
`;

function mockLLMResponse(claims: any[]) {
  invokeLLMMock.mockResolvedValueOnce({
    choices: [
      {
        message: {
          content: JSON.stringify({
            claims,
            detectedInsurer: 'Anthem BCBS (Synthetic)',
            confidence: 0.9,
            extractionNotes: null,
          }),
        },
      },
    ],
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reconcileClaimStatusWithPaymentEvidence (unit)', () => {
  it('corrects "denied" to "approved" when a positive reimbursement is present — the reported bug', () => {
    const claim: ExtractedClaim = { cptCodes: '97140', dateOfService: '2026-02-10', claimStatus: 'denied', insuranceReimbursement: 96 };
    reconcileClaimStatusWithPaymentEvidence(claim);
    expect(claim.claimStatus).toBe('approved');
    expect(claim.notes).toMatch(/corrected from "denied" to "approved"/);
  });

  it('leaves "denied" alone when the reimbursement is a confirmed $0 (consistent, not touched)', () => {
    const claim: ExtractedClaim = { cptCodes: '97140', dateOfService: '2026-02-10', claimStatus: 'denied', insuranceReimbursement: 0 };
    reconcileClaimStatusWithPaymentEvidence(claim);
    expect(claim.claimStatus).toBe('denied');
    expect(claim.notes).toBeFalsy();
  });

  it('flags "approved" with a confirmed $0 reimbursement as needs_review instead of trusting either label', () => {
    const claim: ExtractedClaim = { cptCodes: '97110', dateOfService: '2026-02-10', claimStatus: 'approved', insuranceReimbursement: 0 };
    reconcileClaimStatusWithPaymentEvidence(claim);
    expect(claim.claimStatus).toBe('needs_review');
    expect(claim.notes).toMatch(/needs_review/);
  });

  it('leaves "submitted" with no reimbursement amount yet untouched (zero-payment non-denial, still pending)', () => {
    const claim: ExtractedClaim = { cptCodes: '97110', dateOfService: '2026-02-10', claimStatus: 'submitted', insuranceReimbursement: null };
    reconcileClaimStatusWithPaymentEvidence(claim);
    expect(claim.claimStatus).toBe('submitted');
  });

  it('is independent per line — a corrected line never flips an unrelated line on the same claim', () => {
    const paidLineWronglyDenied: ExtractedClaim = { cptCodes: '97110', dateOfService: '2026-02-10', claimStatus: 'denied', insuranceReimbursement: 96 };
    const genuinelyDeniedLine: ExtractedClaim = { cptCodes: '97140', dateOfService: '2026-02-10', claimStatus: 'denied', insuranceReimbursement: 0 };

    reconcileClaimStatusWithPaymentEvidence(paidLineWronglyDenied);
    reconcileClaimStatusWithPaymentEvidence(genuinelyDeniedLine);

    expect(paidLineWronglyDenied.claimStatus).toBe('approved'); // corrected
    expect(genuinelyDeniedLine.claimStatus).toBe('denied'); // untouched — its own evidence is consistent
  });
});

describe('extractClaimsWithAI — mixed paid/denied lines on one Anthem/BCBS document', () => {
  it('keeps each line\'s own status: corrects the wrongly-denied paid line, leaves the genuinely denied line denied', async () => {
    mockLLMResponse([
      {
        patientName: 'JOHN TESTPATIENT',
        dateOfService: '02/10/2026',
        cptCodes: '97110',
        chargeAmount: 120,
        diagnosisCodes: null,
        modifier: null,
        unitsBilled: 1,
        insuranceReimbursement: 96,
        patientAmountPaid: null,
        patientAmountDue: null,
        oaClaimNumber: 'AB-55021',
        checkDate: null,
        checkNumberVirtualCard: null,
        // Model incorrectly bled the document-wide "contains denied lines"
        // language onto this line, despite its own $96 payment.
        claimStatus: 'denied',
        insuranceBilled: null,
        visitNumber: null,
      },
      {
        patientName: 'JOHN TESTPATIENT',
        dateOfService: '02/10/2026',
        cptCodes: '97140',
        chargeAmount: 80,
        diagnosisCodes: null,
        modifier: null,
        unitsBilled: 1,
        insuranceReimbursement: 0,
        patientAmountPaid: null,
        patientAmountDue: null,
        oaClaimNumber: 'AB-55021',
        checkDate: null,
        checkNumberVirtualCard: null,
        claimStatus: 'denied', // genuinely denied, consistent with its own $0
        insuranceBilled: null,
        visitNumber: null,
      },
    ]);

    const result = await extractClaimsWithAI({ kind: 'text', text: SYNTHETIC_ANTHEM_EOB_TEXT }, 'reimbursement');

    expect(result.claims).toHaveLength(2);
    const paidLine = result.claims.find(c => c.cptCodes === '97110')!;
    const deniedLine = result.claims.find(c => c.cptCodes === '97140')!;

    expect(paidLine.claimStatus).toBe('approved'); // corrected — reimbursement present
    expect(deniedLine.claimStatus).toBe('denied'); // untouched — its own $0 is consistent
  });
});
