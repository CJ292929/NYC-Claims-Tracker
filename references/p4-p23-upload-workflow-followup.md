# CMS1500-first upload workflow: follow-up design (not implemented in P4-P23)

> **Status: implemented in P4-P24.** See
> `supabase/migrations/20261026000000_p4_p24_cms1500_first_claim_lines.sql`,
> `shared/claimImport.ts` (field ownership and matching rules),
> `server/claimImport.ts`, `server/cms1500Vision.ts` and
> `client/src/components/claims/ClaimImportDialog.tsx`. Where P4-P24
> deliberately differs from the proposal below:
>
> - CMS1500 does **not** persist the Box 24F charge (the established rule
>   that CMS1500 never writes money stands). Charges are read only to check
>   the lines against Box 28. Billed amount comes from the EOB.
> - Visit numbers are never derived from a Box 24 row position or units.
> - Line identity is (document SHA-256, source line key), with partial
>   UNIQUE indexes, rather than reusing `source_line_index`. Cross-document
>   correspondence is never positional; ambiguous matches need a choice.
> - Patients have no DOB or member ID in this app, so groups are matched by
>   name only. A near match or an unreadable name always needs explicit
>   confirmation.
> - Scanned pages are rendered and each page is read twice; values the two
>   reads disagree on are left blank and flagged rather than picked.
>
> The rest of this note is kept as the original design record.

P4-P23 restricted Claims to the Super Admin and replaced the session-table
financial columns. It deliberately **did not** change how uploads persist.
This note records the remaining scope and a proposed design so the next phase
starts from an agreed plan.

## Requested behavior (outstanding)

1. **CMS1500 first, then EOB / Insurance Reimbursement.**
2. **Bulk CMS1500 uploads** (many forms or many patients per batch).
3. **Bulk EOB / Insurance Reimbursement uploads.**
4. **Recognition of the supplied three-page black-and-white CMS1500 PDF.**

All of these stay Super Admin only. They go through `superAdminProcedure` and
`requireSuperAdmin`, which this phase already applies to
`/api/claims/upload-extract`, `claims.bulkImportFromEOB`, and
`claims.cms1500Enrichment*`.

## Current behavior (unchanged by P4-P23)

- The reimbursement (EOB) upload **creates** `claims_records` rows through
  `claims.upsert` and `claims.bulkImportFromEOB`.
- A CMS1500 upload only **enriches** rows that already exist
  (`claims.cms1500EnrichmentPreview` → `cms1500EnrichmentCommit`). It patches
  visit number, diagnosis codes, modifier, and units, and returns
  `no_claims`/`no_match` when no reimbursement row exists yet. So today the
  EOB has to come first, which is the reverse of the requested order.
- Repeated same-date, same-CPT lines are kept apart by `source_line_index`
  (P4-P14), which also keeps re-imports idempotent.

## Proposed design

**Roles of the two documents**

- **CMS1500 establishes the clinical service lines.** Each 24A–24J line
  becomes one claim line: date of service, place of service, CPT/HCPCS,
  modifiers, units, charge, rendering NPI, and the diagnosis codes resolved
  from that line's 24E pointer letters against box 21 (A–L).
- **EOB reconciles financial adjudication** onto the existing lines:
  allowed/paid amounts, patient responsibility, claim status, check/EFT, and
  adjustment reasons. If an EOB line has no CMS1500 line to match, it becomes
  a review item. It must never be silently dropped, and it must not
  overwrite a different line.

**Line identity and idempotency**

- Key: (patient, date of service, CPT, modifier set, `source_line_index`
  within the same DOS + CPT). This keeps the P4-P14 semantics so legitimately
  repeated lines remain distinct.
- Provenance: add a nullable `source` / `source_document_id` (and a
  per-document content hash). Then:
  - re-uploading the same CMS1500 is a no-op,
  - a retried request after a partial failure is safe,
  - EOB matching can prefer lines that came from a CMS1500.
- Historical compatibility: rows created by the current EOB-first path have
  no CMS1500 provenance. Treat them as valid lines, so a later CMS1500 can
  attach to them through the existing enrichment matcher rather than create
  duplicates. Do **not** backfill or rewrite historical financial values.
- Each document is committed in one audited transaction, following the
  P4-P17R `*_with_audit` pattern, with one `import_batch_id` per upload.

**Bulk uploads**

- One request per file. The server processes files independently, and each
  file reports its own result (saved / needs review / failed with reason).
  A batch must never fail or succeed as a whole.
- Patients are matched by name + DOB + member ID, never by name alone.
  Anything ambiguous goes to review.
- Use the existing single-flight and request guards
  (`client/src/lib/concurrencyGuards.ts`) for double-submit and stale
  responses. Bound the server-side concurrency for the vision/OCR step.

**Recognizing the supplied CMS1500 (three pages, black and white)**

The sample is an **image-only** scan of a standard NUCC 02/12 CMS-1500. It has
no text layer, so `pdftotext`/pdfjs extraction returns nothing, and the
current text templates cannot read it. Recognition needs OCR or AI vision on
**every page**:

- 3 pages, all sharing the same header boxes 1–23 and 25–33. Page footers
  read "continued – page N of 3".
- Service lines run up to 6 per page: 6 + 6 + 4 = 16 lines in the sample,
  across 4 dates of service. Each date repeats the same four CPTs (97110,
  97112, 97530, 97140 with modifier 59, plus GP on every line). Each line is
  1 unit at $175.00.
- Box 28 (total charge) is printed **only on the last page**. The other pages
  leave it blank. Use it to check the extracted lines add up (16 × $175 =
  $2,800.00) instead of reading it from each page.
- Box 21 lists six ICD-10 codes (A–F). Each line's 24E pointer string, such as
  `ABCD`, `ABED`, or `CEDF`, must be resolved per line, in pointer order, to
  that line's own diagnosis codes. Do not attach the whole box-21 list to
  every line.
- Merge pages into one claim using the shared header (patient account no.,
  insured ID, billing NPI, and the CIC/claim number at the top). Dedupe lines
  only by the line-identity key above, so lines that legitimately repeat
  across pages are kept.

**Tests to add with the implementation:** a page-by-page fixture for this
layout (synthetic values only), pointer→code mapping per line, the
last-page-only total check, repeated CPT lines across pages, re-upload
idempotency, retry after a partial failure, CMS1500-then-EOB reconciliation,
an EOB with no matching line (goes to review), and bulk per-file isolation.
