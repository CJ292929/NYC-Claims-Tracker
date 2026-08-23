/**
 * server/aiClaimExtractor.reimbursementLineItems.test.ts
 *
 * Regression tests for the Reimbursement Insurance extraction completeness
 * fix: a Reimbursement/EOB upload must carry chargeAmount, diagnosisCodes,
 * modifier, and unitsBilled through from its own "Line Level Information"
 * table (billed amount, DX codes, modifier, quantity) in addition to the
 * payment-side fields (insuranceReimbursement, patientAmountPaid,
 * patientAmountDue) that already worked. Uses a synthetic, fictional EOB
 * fixture modeled on the reported document structure — no real PHI.
 *
 * No live LLM call: invokeLLM is mocked to return a fixed structured
 * response, so these tests only exercise the normalization/sanitization
 * logic in extractClaimsWithAI, not prompt quality itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./_core/llm', () => ({ invokeLLM: vi.fn() }));

import { invokeLLM } from './_core/llm';
import { extractClaimsWithAI } from './aiClaimExtractor';

const invokeLLMMock = vi.mocked(invokeLLM);

// Fictional patient/EOB text modeled on the reported "Line Level Information"
// table structure (Service Dates, Rev, Procedure Codes, DX Codes, Modifier,
// Quantity, Billed/Allowed/Coinsurance/Copay/Deductible/Paid Amount).
const SYNTHETIC_EOB_TEXT = `
SAMPLE INSURANCE EOB — SYNTHETIC TEST FIXTURE, NOT A REAL DOCUMENT
Patient: JANE TESTPATIENT
Claim #: 192643

Line Level Information
DATE: 01/11/2026  CPT: 97162  DX: M54.50 M25.512 R29.6 R26.89  MODIFIER: GP
QUANTITY: 1.000  BILLED: $275.00  ALLOWED: $275.00  COINSURANCE: $137.50
COPAY: $0.00  DEDUCTIBLE: $0.00  PAID: $137.50

DATE: 01/11/2026  CPT: 97140  DX: M54.50 M25.512 R26.89 M62.81  MODIFIER: 59 GP
QUANTITY: 1.000  BILLED: $175.00  ALLOWED: $138.48  COINSURANCE: $69.24
COPAY: $0.00  DEDUCTIBLE: $0.00  PAID: $69.24
`;

function mockLLMResponse(claims: any[], overrides: Record<string, unknown> = {}) {
  invokeLLMMock.mockResolvedValueOnce({
    choices: [
      {
        message: {
          content: JSON.stringify({
            claims,
            detectedInsurer: 'Synthetic Test Payer',
            confidence: 0.95,
            extractionNotes: null,
            ...overrides,
          }),
        },
      },
    ],
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractClaimsWithAI — reimbursement line-item completeness', () => {
  it('A/B: carries Billed Amount into chargeAmount and Paid Amount into insuranceReimbursement', async () => {
    mockLLMResponse([
      {
        patientName: 'JANE TESTPATIENT',
        dateOfService: '01/11/2026',
        cptCodes: '97162',
        chargeAmount: 275.0,
        diagnosisCodes: 'M54.50, M25.512, R29.6, R26.89',
        modifier: 'GP',
        unitsBilled: 1,
        insuranceReimbursement: 137.5,
        patientAmountPaid: 0,
        patientAmountDue: null,
        oaClaimNumber: '192643',
        checkDate: '03/03/2026',
        checkNumberVirtualCard: null,
        claimStatus: 'approved',
        insuranceBilled: null,
        visitNumber: null,
      },
    ]);

    const result = await extractClaimsWithAI({ kind: 'text', text: SYNTHETIC_EOB_TEXT }, 'reimbursement');

    expect(result.claims).toHaveLength(1);
    const claim = result.claims[0];
    expect(claim.chargeAmount).toBe(275.0); // Billed Amount -> chargeAmount (was previously dropped)
    expect(claim.insuranceReimbursement).toBe(137.5); // Paid Amount -> insuranceReimbursement (already worked)
  });

  it('C/D: preserves DX codes and multiple (non-truncated) modifiers per line', async () => {
    mockLLMResponse([
      {
        patientName: 'JANE TESTPATIENT',
        dateOfService: '01/11/2026',
        cptCodes: '97140',
        chargeAmount: 175.0,
        diagnosisCodes: 'M54.50, M25.512, R26.89, M62.81',
        modifier: '59, GP',
        unitsBilled: 1,
        insuranceReimbursement: 69.24,
        patientAmountPaid: 0,
        patientAmountDue: null,
        oaClaimNumber: '192643',
        checkDate: '03/03/2026',
        checkNumberVirtualCard: null,
        claimStatus: 'approved',
        insuranceBilled: null,
        visitNumber: null,
      },
    ]);

    const result = await extractClaimsWithAI({ kind: 'text', text: SYNTHETIC_EOB_TEXT }, 'reimbursement');

    const claim = result.claims[0];
    expect(claim.diagnosisCodes).toBe('M54.50, M25.512, R26.89, M62.81');
    expect(claim.modifier).toBe('59, GP');
    expect(claim.modifier).not.toBe('59'); // must not truncate to only the first modifier
  });

  it('E: normalizes decimal quantity ("1.000") to a plain number', async () => {
    mockLLMResponse([
      {
        patientName: 'JANE TESTPATIENT',
        dateOfService: '01/11/2026',
        cptCodes: '97162',
        chargeAmount: 275.0,
        diagnosisCodes: null,
        modifier: 'GP',
        unitsBilled: '1.000', // some models/providers may return a string
        insuranceReimbursement: 137.5,
        patientAmountPaid: 0,
        patientAmountDue: null,
        oaClaimNumber: null,
        checkDate: null,
        checkNumberVirtualCard: null,
        claimStatus: 'approved',
        insuranceBilled: null,
        visitNumber: null,
      },
    ]);

    const result = await extractClaimsWithAI({ kind: 'text', text: SYNTHETIC_EOB_TEXT }, 'reimbursement');

    expect(result.claims[0].unitsBilled).toBe(1);
  });

  it('F: preserves multiple CPT lines as separate claim objects', async () => {
    mockLLMResponse([
      {
        patientName: 'JANE TESTPATIENT', dateOfService: '01/11/2026', cptCodes: '97162',
        chargeAmount: 275.0, diagnosisCodes: 'M54.50', modifier: 'GP', unitsBilled: 1,
        insuranceReimbursement: 137.5, patientAmountPaid: 0, patientAmountDue: null,
        oaClaimNumber: '192643', checkDate: '03/03/2026', checkNumberVirtualCard: null,
        claimStatus: 'approved', insuranceBilled: null, visitNumber: null,
      },
      {
        patientName: 'JANE TESTPATIENT', dateOfService: '01/11/2026', cptCodes: '97140',
        chargeAmount: 175.0, diagnosisCodes: 'M54.50', modifier: '59, GP', unitsBilled: 1,
        insuranceReimbursement: 69.24, patientAmountPaid: 0, patientAmountDue: null,
        oaClaimNumber: '192643', checkDate: '03/03/2026', checkNumberVirtualCard: null,
        claimStatus: 'approved', insuranceBilled: null, visitNumber: null,
      },
    ]);

    const result = await extractClaimsWithAI({ kind: 'text', text: SYNTHETIC_EOB_TEXT }, 'reimbursement');

    expect(result.claims).toHaveLength(2);
    expect(result.claims.map(c => c.cptCodes)).toEqual(['97162', '97140']);
  });

  it('G: preserves a zero copay/deductible-equivalent value rather than treating it as missing', async () => {
    mockLLMResponse([
      {
        patientName: 'JANE TESTPATIENT', dateOfService: '01/11/2026', cptCodes: '97162',
        chargeAmount: 275.0, diagnosisCodes: null, modifier: 'GP', unitsBilled: 1,
        insuranceReimbursement: 137.5, patientAmountPaid: 0, patientAmountDue: 0,
        oaClaimNumber: null, checkDate: null, checkNumberVirtualCard: null,
        claimStatus: 'approved', insuranceBilled: null, visitNumber: null,
      },
    ]);

    const result = await extractClaimsWithAI({ kind: 'text', text: SYNTHETIC_EOB_TEXT }, 'reimbursement');

    expect(result.claims[0].patientAmountPaid).toBe(0);
    expect(result.claims[0].patientAmountDue).toBe(0);
  });

  it('H: leaves genuinely absent fields null instead of inventing a value', async () => {
    mockLLMResponse([
      {
        patientName: 'JANE TESTPATIENT', dateOfService: '01/11/2026', cptCodes: '97162',
        chargeAmount: null, diagnosisCodes: null, modifier: null, unitsBilled: null,
        insuranceReimbursement: 137.5, patientAmountPaid: null, patientAmountDue: null,
        oaClaimNumber: null, checkDate: null, checkNumberVirtualCard: null,
        claimStatus: 'approved', insuranceBilled: null, visitNumber: null,
      },
    ]);

    const result = await extractClaimsWithAI({ kind: 'text', text: SYNTHETIC_EOB_TEXT }, 'reimbursement');

    const claim = result.claims[0];
    expect(claim.chargeAmount).toBeNull();
    expect(claim.diagnosisCodes).toBeNull();
    expect(claim.modifier).toBeNull();
    expect(claim.unitsBilled).toBeNull();
  });

  it('K/L: schema has no Allowed/Coinsurance/Copay/Deductible fields, so they can never overwrite Charge or Patient Paid', async () => {
    // Simulate a model that ignores instructions and tries to smuggle Allowed
    // Amount / Coinsurance through under made-up keys — the normalizer in
    // extractClaimsWithAI only ever reads the known ExtractedClaim fields by
    // name, so these extra keys are inert.
    mockLLMResponse([
      {
        patientName: 'JANE TESTPATIENT', dateOfService: '01/11/2026', cptCodes: '97140',
        chargeAmount: 175.0, diagnosisCodes: null, modifier: '59, GP', unitsBilled: 1,
        insuranceReimbursement: 69.24, patientAmountPaid: 0, patientAmountDue: null,
        oaClaimNumber: null, checkDate: null, checkNumberVirtualCard: null,
        claimStatus: 'approved', insuranceBilled: null, visitNumber: null,
        // Not part of the schema, and deliberately DIFFERENT from
        // chargeAmount/patientAmountPaid so a leak would be caught — a model
        // that ignores instructions and tries to smuggle Allowed Amount /
        // Coinsurance through under made-up keys must not have them merged
        // into the real fields.
        allowedAmount: 138.48,
        coinsuranceAmount: 69.24,
      },
    ]);

    const result = await extractClaimsWithAI({ kind: 'text', text: SYNTHETIC_EOB_TEXT }, 'reimbursement');

    const claim = result.claims[0];
    expect(claim.chargeAmount).toBe(175.0); // billed (175.00), not allowed (138.48)
    expect(claim.patientAmountPaid).toBe(0); // copay (0), not coinsurance (69.24)
    expect('allowedAmount' in claim).toBe(false);
    expect('coinsuranceAmount' in claim).toBe(false);
  });
});
