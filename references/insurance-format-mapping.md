# Insurance Format Mapping — Maintenance Guide

This tracks which EOB/CMS1500 formats the AI extraction prompt
(`server/aiClaimExtractor.ts`, `FIELD NAME VARIATIONS` section) currently
recognizes, and the process for extending it when a new insurer's format
shows up.

## The 18 canonical columns

Date of Service, Visit #, CPT Codes, Units, Diagnosis, Modifier, Charge,
Ins. Reimb., Pt. Paid, Pt. Due, Ins. Billed, Date Submitted, Claim #,
Status, Check/Payment Date, Check/EFT #, Appeal Date, Appeal Ref #.

These map 1:1 to `claims_records` columns (`date_of_service`,
`visit_number`, `cpt_codes`, `units_billed`, `diagnosis_codes`, `modifier`,
`charge_amount`, `insurance_reimbursement`, `patient_amount_paid`,
`patient_amount_due`, `insurance_billed`, `claim_submitted_date`,
`expire_bcbs_claim_number`/`oa_claim_number`, `claim_status`, `check_date`,
`check_number_virtual_card`, `date_of_appeal`, `reference_no`) and are the
dashboard's default-visible columns (`place_of_service` and `lmn` also
exist but are hidden by default — see `client/src/pages/Dashboard.tsx`'s
`hiddenClaimsColumns`).

## Formats currently covered

Label conventions the extraction prompt already knows to map by meaning,
not exact text — see the `FIELD NAME VARIATIONS` block for the live
wording. Current coverage, informally, from real files tested this
engagement:

- **Aetna** — "Submitted Charges" (Charge), "Allowed"/"Payable Amount"
  (Ins. Reimb.), "Patient Responsibility" (Pt. Due), CPT/modifier often
  fused (`97162GP`).
- **Cigna** — compact concatenated dates (e.g. `052120260521206`, parsed
  as MMDDYYYY), "Billed Amount", "Allowed Amount".
- **Humana** — explicit `PAID`/`DENIED` status text, "Billed", "Paid",
  "Check Date", "Check Number".
- **BCBS / Optum** — "SERVICE LINE DETAIL" layout, "CHARGE", "PAYMENT
  AMOUNT", "PATIENT RESPONSIBILITY", multi-block claims (one patient can
  have several distinct claim numbers in one document).
- **Government-services / NGS / Anthem-dense** — "NAME LASTNAME,
  FIRSTNAME MID" patient header (middle initial — see
  `server/nameMatch.ts`'s suffix-tolerant matching), "CLAIM INFORMATION
  FORWARDED TO" for per-claim payer, "ICN" for claim number.
- **GEICO / auto-PIP** — "DOS", "PROC CODE", "PROVIDER REIMBURSE"; prints
  a "REDUCTION" column that is the insurer's own contractual reduction,
  *not* patient responsibility (no-fault PIP typically has none).
- **Generic grid remittance** — "LASTNAME FIRSTNAME/ 12345" patient
  header, "HC:CPT:MOD" service description, "Amount Charged", "Paid to
  Provider".

Fields that are legitimately rare/absent across most real EOBs regardless
of format, so frequent nulls there are expected, not a bug: **Visit #**,
**Appeal Date**, **Appeal Ref #**, **Date Submitted** on payer-issued
(non-CMS1500) documents.

## Adding a new format

1. Upload a sample file and check the extraction result against the
   source PDF (which fields came back null or wrong that are actually
   present in the file).
2. Note the exact label text the format uses for that field.
3. Add it to the relevant bullet in `FIELD NAME VARIATIONS`
   (`server/aiClaimExtractor.ts`) — map by meaning, and if the format has
   a genuinely different/non-interchangeable concept (like GEICO's
   REDUCTION), call that out explicitly so the model doesn't conflate it
   with a canonical field it isn't.
4. Re-test with the same sample file.
5. Update this doc's format list with the new insurer and its label
   conventions.

## Quality signal

The per-claim `notes` field carries a `⚠️ Unverified against source`
warning (shown as an amber icon in the upload review screen — see
`verifyClaimAgainstSourceText` in `server/aiClaimExtractor.ts`) whenever a
value, or a CPT+charge combination, can't be found in the source text.
Flag rate per format hasn't been measured yet (would need a DB query over
recent uploads) — see the open health-check item in project notes.
