/**
 * client/src/lib/claimReviewRouting.ts
 *
 * P4-P10R: the claim upload preview dialog can route to four different
 * views depending on what the server returned and which upload button
 * triggered it (Reimbursement vs CMS1500). Which view renders is what
 * decides which SAVE path runs: 'cms1500Enrichment' saves through
 * claims.cms1500EnrichmentCommit (visit/diagnosis/modifier/units only,
 * never charge/payment, never inserts a row), while 'reimbursementTable'
 * saves through the legacy per-row claims.upsert (full read/write,
 * including charge/payment, with insert-on-no-match -- correct for
 * Reimbursement/EOB uploads and for manual claim entry, but NOT safe for
 * CMS1500 data).
 *
 * Extracted into a pure function, and the Dashboard component's JSX calls
 * THIS rather than re-deriving the same ternary inline, so a test of this
 * function is a test of the actual production routing decision -- not a
 * parallel reimplementation that could silently drift out of sync with it.
 */

export type ClaimReviewView = "bulk" | "empty" | "cms1500Enrichment" | "reimbursementTable";

export function resolveClaimReviewView(params: {
  eobPatientGroups: unknown[] | null | undefined;
  editingExtractedClaimsLength: number;
  claimUploadType: "reimbursement" | "cms1500";
}): ClaimReviewView {
  if (params.eobPatientGroups && params.eobPatientGroups.length > 0) return "bulk";
  if (params.editingExtractedClaimsLength === 0) return "empty";
  if (params.claimUploadType === "cms1500") return "cms1500Enrichment";
  return "reimbursementTable";
}
