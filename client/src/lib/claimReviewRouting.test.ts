/**
 * client/src/lib/claimReviewRouting.test.ts
 *
 * P4-P10R: resolveClaimReviewView is the function Dashboard.tsx's claim
 * upload preview dialog actually calls to pick which view (and therefore
 * which save path) renders. These tests exercise the real routing
 * decision, not a parallel reimplementation of it -- the key correctness
 * requirement is that a CMS1500 upload NEVER resolves to
 * 'reimbursementTable' (the legacy claims.upsert path, which writes
 * charge/payment fields and inserts on no match), regardless of what
 * shape the server's response took (single-patient vs. a patientGroups
 * array that happened to contain this patient).
 */
import { describe, expect, it } from "vitest";
import { resolveClaimReviewView } from "./claimReviewRouting";

describe("resolveClaimReviewView", () => {
  it("routes a CMS1500 upload with single-patient extracted claims to the enrichment-only view, never the reimbursement table", () => {
    const view = resolveClaimReviewView({
      eobPatientGroups: null,
      editingExtractedClaimsLength: 3,
      claimUploadType: "cms1500",
    });
    expect(view).toBe("cms1500Enrichment");
  });

  it("routes a reimbursement upload with single-patient extracted claims to the reimbursement table", () => {
    const view = resolveClaimReviewView({
      eobPatientGroups: null,
      editingExtractedClaimsLength: 3,
      claimUploadType: "reimbursement",
    });
    expect(view).toBe("reimbursementTable");
  });

  it("routes to 'bulk' whenever the server returned a non-empty patientGroups array, regardless of upload type", () => {
    const groups = [{ patientName: "JOHN SMITH" }];
    expect(resolveClaimReviewView({ eobPatientGroups: groups, editingExtractedClaimsLength: 0, claimUploadType: "cms1500" })).toBe("bulk");
    expect(resolveClaimReviewView({ eobPatientGroups: groups, editingExtractedClaimsLength: 0, claimUploadType: "reimbursement" })).toBe("bulk");
  });

  it("an empty patientGroups array does NOT route to 'bulk' -- falls through to the single-patient branches", () => {
    const view = resolveClaimReviewView({ eobPatientGroups: [], editingExtractedClaimsLength: 2, claimUploadType: "cms1500" });
    expect(view).toBe("cms1500Enrichment");
  });

  it("routes to 'empty' when nothing has been extracted yet, before checking upload type", () => {
    expect(resolveClaimReviewView({ eobPatientGroups: null, editingExtractedClaimsLength: 0, claimUploadType: "cms1500" })).toBe("empty");
    expect(resolveClaimReviewView({ eobPatientGroups: null, editingExtractedClaimsLength: 0, claimUploadType: "reimbursement" })).toBe("empty");
  });

  it("bulk mode takes priority over the empty check (a patientGroups response can legitimately have zero claims inside each group's list yet still need the bulk review UI)", () => {
    const groups = [{ patientName: "JOHN SMITH" }];
    expect(resolveClaimReviewView({ eobPatientGroups: groups, editingExtractedClaimsLength: 0, claimUploadType: "reimbursement" })).toBe("bulk");
  });
});
