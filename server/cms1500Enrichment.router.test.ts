/**
 * server/cms1500Enrichment.router.test.ts
 *
 * P4-P10: exercises the claims.cms1500EnrichmentPreview /
 * cms1500EnrichmentCommit tRPC procedures end-to-end against a mocked ./db
 * module, covering the staff-facing contract: preview never writes, commit
 * only patches the rows/fields the preview resolved, and an absent
 * reimbursement upload produces the "upload reimbursement first" guidance.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./_core/sdk";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    patientHasAnyClaimRecords: vi.fn(),
    findCms1500EnrichmentCandidates: vi.fn(),
    applyCms1500Enrichment: vi.fn(async () => {}),
    getAllPatients: vi.fn(async () => []),
    upsertClaimRecord: vi.fn(async () => "claim-id"),
  },
}));

vi.mock("./db", () => dbMock);

import { appRouter } from "./routers";

function ownerCaller() {
  const owner: AuthenticatedUser = {
    id: "owner-1",
    openId: "owner-open-id",
    name: "Owner",
    email: "owner@example.com",
    loginMethod: "google",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  const ctx: TrpcContext = {
    user: owner,
    req: { protocol: "https", headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("claims.cms1500EnrichmentPreview", () => {
  it("reports 'no_claims' with upload-reimbursement-first guidance when the patient has zero rows", async () => {
    dbMock.patientHasAnyClaimRecords.mockResolvedValue(false);
    dbMock.findCms1500EnrichmentCandidates.mockResolvedValue([]);

    const caller = ownerCaller();
    const result = await caller.claims.cms1500EnrichmentPreview({
      patientId: PATIENT_ID,
      lines: [{ lineKey: "l1", dateOfService: "2026-09-01", cptCodes: "97110" }],
    });

    expect(result.hasAnyClaims).toBe(false);
    expect(result.results[0].status).toBe("no_claims");
    expect(dbMock.applyCms1500Enrichment).not.toHaveBeenCalled(); // preview never writes
  });

  it("reports 'no_match' (not 'no_claims') when the patient has rows but none match this date/CPT", async () => {
    dbMock.patientHasAnyClaimRecords.mockResolvedValue(true);
    dbMock.findCms1500EnrichmentCandidates.mockResolvedValue([]);

    const caller = ownerCaller();
    const result = await caller.claims.cms1500EnrichmentPreview({
      patientId: PATIENT_ID,
      lines: [{ lineKey: "l1", dateOfService: "2026-09-01", cptCodes: "97110" }],
    });

    expect(result.results[0].status).toBe("no_match");
  });

  it("reports 'matched' with the single candidate's id when exactly one row matches AND it has reimbursement evidence", async () => {
    dbMock.patientHasAnyClaimRecords.mockResolvedValue(true);
    dbMock.findCms1500EnrichmentCandidates.mockResolvedValue([
      { id: "33333333-3333-4333-8333-333333333333", authPeriod: 2, chargeAmount: 100, insuranceReimbursement: 80, patientAmountPaid: 0, patientAmountDue: 0, visitNumber: null, diagnosisCodes: null, modifier: null, unitsBilled: null, hasReimbursementEvidence: true },
    ]);

    const caller = ownerCaller();
    const result = await caller.claims.cms1500EnrichmentPreview({
      patientId: PATIENT_ID,
      lines: [{ lineKey: "l1", dateOfService: "2026-05-19", cptCodes: "97110" }],
    });

    expect(result.results[0].status).toBe("matched");
    expect(result.results[0].claimRecordId).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("reports 'matched_unconfirmed' (not auto-'matched') when the single candidate has NO reimbursement evidence -- provenance is unknown", async () => {
    dbMock.patientHasAnyClaimRecords.mockResolvedValue(true);
    dbMock.findCms1500EnrichmentCandidates.mockResolvedValue([
      { id: "33333333-3333-4333-8333-333333333333", authPeriod: 1, chargeAmount: 100, insuranceReimbursement: null, patientAmountPaid: null, patientAmountDue: null, visitNumber: null, diagnosisCodes: null, modifier: null, unitsBilled: null, hasReimbursementEvidence: false },
    ]);

    const caller = ownerCaller();
    const result = await caller.claims.cms1500EnrichmentPreview({
      patientId: PATIENT_ID,
      lines: [{ lineKey: "l1", dateOfService: "2026-05-19", cptCodes: "97110" }],
    });

    expect(result.results[0].status).toBe("matched_unconfirmed");
    // Still carries the candidate id so the client CAN commit it, but only
    // after an explicit staff confirmation -- never auto-included.
    expect(result.results[0].claimRecordId).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("reports 'matched' when the single candidate's reimbursement field is an explicit zero -- a denied/zero-payment EOB is still valid evidence, not treated as missing", async () => {
    dbMock.patientHasAnyClaimRecords.mockResolvedValue(true);
    dbMock.findCms1500EnrichmentCandidates.mockResolvedValue([
      { id: "33333333-3333-4333-8333-333333333333", authPeriod: 1, chargeAmount: 100, insuranceReimbursement: 0, patientAmountPaid: 0, patientAmountDue: 0, visitNumber: null, diagnosisCodes: null, modifier: null, unitsBilled: null, hasReimbursementEvidence: true },
    ]);

    const caller = ownerCaller();
    const result = await caller.claims.cms1500EnrichmentPreview({
      patientId: PATIENT_ID,
      lines: [{ lineKey: "l1", dateOfService: "2026-05-19", cptCodes: "97110" }],
    });

    expect(result.results[0].status).toBe("matched");
  });

  it("reports 'needs_selection' with all candidates when more than one row matches", async () => {
    dbMock.patientHasAnyClaimRecords.mockResolvedValue(true);
    dbMock.findCms1500EnrichmentCandidates.mockResolvedValue([
      { id: "33333333-3333-4333-8333-333333333333", authPeriod: 1 }, { id: "44444444-4444-4444-8444-444444444444", authPeriod: 2 },
    ]);

    const caller = ownerCaller();
    const result = await caller.claims.cms1500EnrichmentPreview({
      patientId: PATIENT_ID,
      lines: [{ lineKey: "l1", dateOfService: "2026-05-19", cptCodes: "97110" }],
    });

    expect(result.results[0].status).toBe("needs_selection");
    expect(result.results[0].candidates).toHaveLength(2);
  });
});

describe("claims.cms1500EnrichmentCommit", () => {
  it("applies enrichment only to the resolved claimRecordId, passing through visit/diagnosis/modifier/units", async () => {
    const caller = ownerCaller();
    const result = await caller.claims.cms1500EnrichmentCommit({
      patientId: PATIENT_ID,
      lines: [{
        lineKey: "l1",
        claimRecordId: "33333333-3333-4333-8333-333333333333",
        dateOfService: "2026-05-19",
        cptCodes: "97110",
        visitNumber: 2,
        diagnosisCodes: "M54.5",
        modifier: "GP",
        unitsBilled: 1,
      }],
    });

    expect(result.results[0]).toEqual({ lineKey: "l1", status: "saved" });
    expect(dbMock.applyCms1500Enrichment).toHaveBeenCalledWith(expect.objectContaining({
      claimRecordId: "33333333-3333-4333-8333-333333333333",
      patientId: PATIENT_ID,
      cptCodes: "97110",
      visitNumber: 2,
      diagnosisCodes: "M54.5",
      modifier: "GP",
      unitsBilled: 1,
    }));
    // The commit payload never carries a charge/payment field at all.
    const callArg = dbMock.applyCms1500Enrichment.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("chargeAmount");
    expect(callArg).not.toHaveProperty("insuranceReimbursement");
  });

  it("reports a per-line failure (not a thrown request) when the server-side re-validation rejects the selection", async () => {
    dbMock.applyCms1500Enrichment.mockRejectedValueOnce(new Error("Selected claim row does not belong to this patient or no longer matches the service date/CPT code."));

    const caller = ownerCaller();
    const result = await caller.claims.cms1500EnrichmentCommit({
      patientId: PATIENT_ID,
      lines: [{ lineKey: "l1", claimRecordId: "33333333-3333-4333-8333-333333333333", dateOfService: "2026-05-19", cptCodes: "97110", modifier: "GP" }],
    });

    expect(result.results[0].status).toBe("failed");
    expect(result.results[0].error).toMatch(/does not belong/i);
  });

  it("is idempotent -- committing the identical resolved line twice calls applyCms1500Enrichment twice with the same arguments (no duplicate-row concept at this layer)", async () => {
    const caller = ownerCaller();
    const line = { lineKey: "l1", claimRecordId: "33333333-3333-4333-8333-333333333333", dateOfService: "2026-05-19", cptCodes: "97110", modifier: "GP" };

    await caller.claims.cms1500EnrichmentCommit({ patientId: PATIENT_ID, lines: [line] });
    await caller.claims.cms1500EnrichmentCommit({ patientId: PATIENT_ID, lines: [line] });

    expect(dbMock.applyCms1500Enrichment).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = dbMock.applyCms1500Enrichment.mock.calls;
    expect(firstCall[0]).toMatchObject({ claimRecordId: "33333333-3333-4333-8333-333333333333", modifier: "GP" });
    expect(secondCall[0]).toMatchObject({ claimRecordId: "33333333-3333-4333-8333-333333333333", modifier: "GP" });
  });
});
