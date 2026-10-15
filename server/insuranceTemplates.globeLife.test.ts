/**
 * server/insuranceTemplates.globeLife.test.ts
 * P4-P13: Globe Life Insurance Co. of New York "Explanation of Payment"
 * template. Fixture text below is a SYNTHETIC reconstruction (anonymized
 * patient name/IDs, same structural layout and column math) of the real
 * sample EOP this template was built against — never the real PDF/patient
 * data. See insuranceTemplates.ts's detectGlobeLife/parseGlobeLifeEOBWithGroups
 * docstrings for the column-mapping rationale.
 */
import { describe, expect, it } from "vitest";
import { tryTemplateExtraction, parseGlobeLifeEOBWithGroups, PatientBoundaryError } from "./insuranceTemplates";

// Two claim blocks for the SAME synthetic patient, each on its own date,
// 3 and 4 service lines respectively (matching the real sample's 7 total
// service lines across two blocks) — including a mid-second-block page
// break, since the real document continues a claim block across pages.
const GLOBE_LIFE_FIXTURE = `
Globe Life Ins of New York
PO Box 3125
Syracuse NY 13220-3125
Check Number:
$2,000.00
Payment Date:
Total Charges:
0099999999
September 30, 2026
Payee ID: 9999999999
Total Payment: $47.73
EXPLANATION OF PAYMENT
Page 1 of 2
Total Patient Responsibility: ($0.00)
Total Contractual Adjustments: ($1,761.32)
Total Other Adjustments: ($190.95)
Provider Adjustments: $0.00
Total Claim Payment: $47.73

JANE SAMPLE PATIENT
Patient Acct #:
Patient:
Medicare ID:
Provider:
Policy #:
Medicare Control #:
Interest:
SYNTHID0000000001 9999999999
$0.00
1000000000001
SYN0000TEST 999999999
Service
Dates(s)
Procedure
(Modifiers)
Medicare
Allowed Adjustments PlanPaid
Patient
Resp
Adjustment
Reason
Billed
Amount
08/31/26-08/31/26 97530 (GP,59) $250.00 $39.81 $210.19 CO-45
08/31/26-08/31/26 97112 (GP) $500.00 $55.06 $444.94 CO-45
08/31/26-08/31/26 97116 (GP) $250.00 $24.57 $225.43 CO-45
Claims Adjustment -$0.09 OA-144
Claims Adjustment $93.74 OA-23
Claims Adjustment $1.91 OA-253
Totals $1,000.00 $119.44 $976.12 $23.88 $0.00

JANE SAMPLE PATIENT
Patient Acct #:
Patient:
Medicare ID:
Provider:
Policy #:
Medicare Control #:
Interest:
SYNTHID0000000002 9999999999
$0.00
1000000000002
SYN0000TEST 999999999
Service
Dates(s)
Procedure
(Modifiers)
Medicare
Allowed Adjustments PlanPaid
Patient
Resp
Adjustment
Reason
Billed
Amount
09/02/26-09/02/26 97750 (GP,59) $250.00 $27.33 $222.67 CO-45
09/02/26-09/02/26 97530 (GP) $250.00 $39.81 $210.19 CO-45
09/02/26-09/02/26 97112 (GP) $250.00 $27.53 $222.47 CO-45
Page 2 of 2
09/02/26-09/02/26 97116 (GP) $250.00 $24.57 $225.43 CO-45
Claims Adjustment $1.91 OA-253
Claims Adjustment $93.57 OA-23
Claims Adjustment -$0.09 OA-144
Totals $1,000.00 $119.24 $976.15 $23.85 $0.00
`;

describe("detectGlobeLife via tryTemplateExtraction", () => {
  it("recognizes a Globe Life EOP and extracts via the dedicated template", () => {
    const result = tryTemplateExtraction(GLOBE_LIFE_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.templateName).toBe("Globe Life Insurance EOB");
  });

  it("does not misfire on unrelated text merely containing the words out of context", () => {
    expect(tryTemplateExtraction("This document is not globe life related at all.")).toBeNull();
  });
});

describe("parseGlobeLifeEOBWithGroups — patient/claim block extraction", () => {
  const groups = parseGlobeLifeEOBWithGroups(GLOBE_LIFE_FIXTURE);

  it("groups all claim blocks under the one patient", () => {
    expect(groups).toHaveLength(1);
    expect(groups[0].patientName).toBe("JANE SAMPLE PATIENT");
  });

  it("produces two date groups (one per claim block) with 3 and 4 service lines", () => {
    const claims = groups[0].claims;
    expect(claims).toHaveLength(2);
    const byDate = new Map(claims.map(c => [c.dateOfService, c]));
    expect(byDate.get("2026-08-31")!.cptLines).toHaveLength(3);
    expect(byDate.get("2026-09-02")!.cptLines).toHaveLength(4);
  });

  it("preserves CPT codes, modifiers, and billed amounts per line", () => {
    const first = groups[0].claims.find(c => c.dateOfService === "2026-08-31")!;
    expect(first.cptLines.map(l => l.cptCodes)).toEqual(["97530", "97112", "97116"]);
    expect(first.cptLines.map(l => l.modifier)).toEqual(["GP,59", "GP", "GP"]);
    expect(first.cptLines.map(l => l.chargeAmount)).toEqual([250, 500, 250]);
  });

  it("preserves service dates across the page-break-continued second block", () => {
    const second = groups[0].claims.find(c => c.dateOfService === "2026-09-02")!;
    expect(second.cptLines.map(l => l.cptCodes)).toEqual(["97750", "97530", "97112", "97116"]);
  });

  it("never confuses Medicare Allowed or Adjustments with Plan Paid on any line", () => {
    for (const claim of groups[0].claims) {
      for (const line of claim.cptLines) {
        expect(line.insuranceReimbursement).toBeNull();
      }
    }
  });

  it("never invents a per-line Patient Resp / Patient Paid value from the blank source cells", () => {
    for (const claim of groups[0].claims) {
      for (const line of claim.cptLines) {
        expect(line.patientAmountDue).toBeNull();
        expect(line.patientAmountPaid).toBeNull();
      }
    }
  });

  it("surfaces each block's true Plan Paid / Patient Resp ONLY as an unresolved claim-level total, never written onto any cptLine", () => {
    const first = groups[0].claims.find(c => c.dateOfService === "2026-08-31")!;
    const second = groups[0].claims.find(c => c.dateOfService === "2026-09-02")!;
    expect(first.unresolvedClaimTotal).toEqual({ planPaid: 23.88, patientResponsibility: 0, cptCount: 3 });
    expect(second.unresolvedClaimTotal).toEqual({ planPaid: 23.85, patientResponsibility: 0, cptCount: 4 });
    // The two blocks' Plan Paid totals sum to the document's Total Payment ($47.73).
    expect(first.unresolvedClaimTotal!.planPaid + second.unresolvedClaimTotal!.planPaid).toBeCloseTo(47.73, 2);
  });

  it("populates the shared document-level check number and payment date on every line", () => {
    for (const claim of groups[0].claims) {
      expect(claim.checkNumberVirtualCard).toBe("0099999999");
      expect(claim.checkDate).toBe("2026-09-30");
    }
  });

  it("uses each block's own Medicare Control # as the claim identifier", () => {
    const first = groups[0].claims.find(c => c.dateOfService === "2026-08-31")!;
    const second = groups[0].claims.find(c => c.dateOfService === "2026-09-02")!;
    expect(first.oaClaimNumber).toBe("1000000000001");
    expect(second.oaClaimNumber).toBe("1000000000002");
  });
});

describe("parseGlobeLifeEOBWithGroups — multi-patient boundary safety", () => {
  it("throws PatientBoundaryError rather than guessing when a second block header survives inside one section", () => {
    // A second "NAME <blank line> Patient Acct #:" header landing inside
    // the FIRST block's body, before its own Totals row -- the extra blank
    // line (an OCR/layout artifact) fails the strict split boundary, so it
    // stays merged into section 1 instead of starting a new section,
    // leaving no safe way to attribute section 1's lines to either patient.
    const malformed = GLOBE_LIFE_FIXTURE.replace(
      "08/31/26-08/31/26 97116 (GP) $250.00 $24.57 $225.43 CO-45",
      "08/31/26-08/31/26 97116 (GP) $250.00 $24.57 $225.43 CO-45\nANOTHER PATIENT\n\nPatient Acct #:\nMedicare Control #:\n123456789012"
    );
    expect(() => parseGlobeLifeEOBWithGroups(malformed)).toThrow(PatientBoundaryError);
  });
});
