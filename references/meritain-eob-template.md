# Meritain Health EOB Template Analysis

## Document Identification
- **Issuer:** Meritain Health
- **Document Type:** Explanation of Benefits (EOB)
- **Header Keywords:** "Meritain Health", "Explanation of Benefits", "Administered By: Meritain Health"
- **Address:** 1405 Xenium Lane North Suite 140, Minneapolis, MN 55441

## Header Fields (Document Level)
| PDF Label | Maps To |
|---|---|
| EPC Draft # | oaClaimNumber (or reference number) |
| Payment Date | checkDate / dateReceived |
| Payment Week | (informational only) |

## Per-Patient Block Fields
Each patient block starts with "Patient:" line and contains:
| PDF Label | Maps To |
|---|---|
| Patient Name | (patient lookup — not a claim column) |
| Member # | (patient member ID — informational) |
| Claim # | oaClaimNumber |
| Customer Service | (informational) |
| Rendering Provider | (informational) |
| Group Name/Check | insuranceBilled (group/plan name) |
| Network | (informational) |
| Billing NPI | (informational) |

## Line Item Table Columns (per service row)
| PDF Column | Maps To |
|---|---|
| Service Date | dateOfService |
| Code or Description | cptCodes |
| Explanation Code(s) | (explanation codes — map to notes or diagnosisCodes) |
| Total Charge | chargeAmount |
| Allowed Amount/QPA | (allowed amount — informational) |
| Provider Discount | (discount — informational) |
| Other Plan Payment | (other plan — informational) |
| Other Adjustment | (adjustment — informational) |
| Co-Ins | (patient co-insurance) |
| Co-Pay | patientAmountPaid |
| Deductible | (deductible — informational) |
| Non-Cov | (non-covered — informational) |
| Not Payment Amount | insuranceReimbursement |

## Claim Status Mapping
- No explicit "Claim Status" column in this EOB format
- Presence of a payment amount > 0 → "approved"
- Payment amount = 0 with explanation codes → "denied" or "pended"
- Default for this document type → "submitted" (awaiting verification)

## Claim Total Row
- "Claim Total:" row at end of each patient block = summary totals
- Total Charge = sum of chargeAmount for that patient
- Not Payment Amount = total insuranceReimbursement for that patient

## Statement Summary (Page 2)
- Total Charge (document total) = 4,175.00
- Allowed Amount/QPA = 3,375.00
- Provider Discount = 1,000.00
- Not Payment Amount = 3,375.00
- ECHO Service Fee = 67.16
- Total Payment = 3,507.84

## Detection Logic
To auto-detect this template, check for ANY of:
1. Text contains "Meritain Health" near top of document
2. Text contains "Administered By: Meritain Health"
3. Text contains "EPC Draft #"
4. Filename contains "EPP_" prefix (common Meritain download naming)
