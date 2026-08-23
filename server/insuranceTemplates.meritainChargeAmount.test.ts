/**
 * server/insuranceTemplates.meritainChargeAmount.test.ts
 *
 * Regression test: the Meritain EOB regex parser already captures each
 * service line's "total charge" column but previously hardcoded chargeAmount
 * to null (leftover from treating Charge as a CMS-1500-only field). This
 * verifies the fix carries the real billed amount through instead of
 * discarding it. Uses a synthetic, fictional EOB fixture — no real PHI.
 */
import { describe, it, expect } from 'vitest';
import { parseMeritainEOBWithGroups } from './insuranceTemplates';

const SYNTHETIC_MERITAIN_EOB = `
Administered by: Meritain Health
EPC Draft #:
12345
Payment Date:
03/03/2026

Patient:   JANE TESTPATIENT  Member #: 000111222
Claim #:   192643
Group Name/Check:   16404/137040261

04/11/2026-04/11/2026 97110 395 175.00 135.00 40.00 0.00 0.00 0.00 0.00 0.00 0.00
Claim Total:
`;

describe('parseMeritainEOBWithGroups — chargeAmount extraction', () => {
  it('B (baseline)/carries the line-item total charge into chargeAmount instead of dropping it', () => {
    const groups = parseMeritainEOBWithGroups(SYNTHETIC_MERITAIN_EOB);

    expect(groups).toHaveLength(1);
    expect(groups[0].patientName).toBe('JANE TESTPATIENT');
    expect(groups[0].claims).toHaveLength(1);

    const line = groups[0].claims[0].cptLines[0];
    expect(line.cptCodes).toBe('97110');
    expect(line.chargeAmount).toBe(175.0); // was previously hardcoded to null
    expect(line.insuranceReimbursement).toBe(135.0); // paid/allowed — must not regress
  });

  it('H: leaves unitsBilled/diagnosisCodes/modifier null since Meritain\'s table genuinely does not print them', () => {
    const groups = parseMeritainEOBWithGroups(SYNTHETIC_MERITAIN_EOB);
    const line = groups[0].claims[0].cptLines[0];

    expect(line.unitsBilled).toBeNull();
    expect(line.diagnosisCodes).toBeNull();
    expect(line.modifier).toBeNull();
  });

  it('does not overwrite Claim #/Ins. Billed with unrelated identifiers', () => {
    const groups = parseMeritainEOBWithGroups(SYNTHETIC_MERITAIN_EOB);
    const claim = groups[0].claims[0];

    expect(claim.oaClaimNumber).toBe('192643');
    expect(claim.insuranceBilled).toBe('16404/137040261');
  });
});
