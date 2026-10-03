/**
 * server/bulkImportFromEOB.cms1500.router.test.ts
 *
 * P4-P10R: exercises claims.bulkImportFromEOB's uploadType: 'cms1500' branch
 * end-to-end -- the multi-patient bulk path has no per-line selection or
 * provenance-confirmation UI, so every skip case (no reimbursement
 * uploaded, no matching row, ambiguous candidates, unconfirmed provenance)
 * must be SKIPPED (never guessed), reported with per-line detail (date +
 * CPT + reason), not just a count, and point staff at the single-patient
 * CMS1500 review. A genuinely safe single-candidate-with-evidence match
 * must still enrich normally, with charge/payment fields never touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./_core/sdk";
import type { Patient } from "../drizzle/schema";

const { dbMock, supabaseMock } = vi.hoisted(() => ({
  dbMock: {
    getAllPatients: vi.fn(),
    upsertClaimRecord: vi.fn(async () => "claim-id"),
    patientHasAnyClaimRecords: vi.fn(),
    findCms1500EnrichmentCandidates: vi.fn(),
    applyCms1500Enrichment: vi.fn(async () => {}),
  },
  supabaseMock: {
    from: vi.fn(() => ({
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    })),
  },
}));

vi.mock("./db", () => dbMock);
vi.mock("./supabase", () => ({ supabase: supabaseMock }));

import { appRouter } from "./routers";

function ownerCaller() {
  const owner: AuthenticatedUser = {
    id: "owner-1", openId: "owner-open-id", name: "Owner", email: "owner@example.com",
    loginMethod: "google", role: "admin", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  };
  const ctx: TrpcContext = {
    user: owner,
    req: { protocol: "https", headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

function patient(id: string, name: string): Patient {
  return {
    id, name, insurance: "Cigna", authDate: null, authValidUntil: null, isActive: true,
    dischargeDate: null, dischargeReason: null, claimsStatus: "none",
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

const JOHN_SMITH = patient("11111111-1111-4111-8111-111111111111", "JOHN SMITH");

function cms1500Group(dateOfService: string, cptCodes: string) {
  return {
    patientName: "JOHN SMITH",
    claims: [{ dateOfService, cptCodes, visitNumber: 2, diagnosisCodes: "M54.5", modifier: "GP", unitsBilled: 1 }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.getAllPatients.mockResolvedValue([JOHN_SMITH]);
});

describe("claims.bulkImportFromEOB — cms1500 branch", () => {
  it("enriches normally when exactly one candidate has reimbursement evidence -- never touches charge/payment", async () => {
    dbMock.patientHasAnyClaimRecords.mockResolvedValue(true);
    dbMock.findCms1500EnrichmentCandidates.mockResolvedValue([
      { id: "r1", authPeriod: 1, chargeAmount: 100, insuranceReimbursement: 80, patientAmountPaid: 0, patientAmountDue: 0, visitNumber: null, diagnosisCodes: null, modifier: null, unitsBilled: null, hasReimbursementEvidence: true },
    ]);

    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "cms1500",
      patientGroups: [cms1500Group("2026-05-19", "97110")],
    });

    expect(result.results[0]).toMatchObject({ matched: true, claimsImported: 1 });
    expect(result.results[0].skippedCms1500Lines).toBeUndefined();
    expect(dbMock.applyCms1500Enrichment).toHaveBeenCalledTimes(1);
    const call = dbMock.applyCms1500Enrichment.mock.calls[0][0];
    expect(call).not.toHaveProperty("chargeAmount");
    expect(call).not.toHaveProperty("insuranceReimbursement");
    expect(dbMock.upsertClaimRecord).not.toHaveBeenCalled(); // cms1500 never uses the insert-capable path
  });

  it("skips with 'no_reimbursement_uploaded' and per-line detail when the patient has zero claim rows at all", async () => {
    dbMock.patientHasAnyClaimRecords.mockResolvedValue(false);
    dbMock.findCms1500EnrichmentCandidates.mockResolvedValue([]);

    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "cms1500",
      patientGroups: [cms1500Group("2026-05-19", "97110")],
    });

    expect(result.results[0].claimsImported).toBe(0);
    expect(result.results[0].skippedNoReimbursementUploaded).toBe(1);
    expect(result.results[0].skippedCms1500Lines).toEqual([
      { dateOfService: "2026-05-19", cptCodes: "97110", reason: "no_reimbursement_uploaded" },
    ]);
    expect(dbMock.applyCms1500Enrichment).not.toHaveBeenCalled();
  });

  it("skips with 'no_match' and per-line detail when the patient has rows but none match this date/CPT", async () => {
    dbMock.patientHasAnyClaimRecords.mockResolvedValue(true);
    dbMock.findCms1500EnrichmentCandidates.mockResolvedValue([]);

    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "cms1500",
      patientGroups: [cms1500Group("2026-09-01", "97110")],
    });

    expect(result.results[0].skippedNoMatch).toBe(1);
    expect(result.results[0].skippedCms1500Lines).toEqual([
      { dateOfService: "2026-09-01", cptCodes: "97110", reason: "no_match" },
    ]);
  });

  it("skips with 'needs_selection' and per-line detail (never guesses) when multiple candidate rows match", async () => {
    dbMock.patientHasAnyClaimRecords.mockResolvedValue(true);
    dbMock.findCms1500EnrichmentCandidates.mockResolvedValue([
      { id: "r1", authPeriod: 1, hasReimbursementEvidence: true },
      { id: "r2", authPeriod: 2, hasReimbursementEvidence: true },
    ]);

    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "cms1500",
      patientGroups: [cms1500Group("2026-05-19", "97110")],
    });

    expect(result.results[0].skippedNeedsSelection).toBe(1);
    expect(result.results[0].skippedCms1500Lines).toEqual([
      { dateOfService: "2026-05-19", cptCodes: "97110", reason: "needs_selection" },
    ]);
    expect(dbMock.applyCms1500Enrichment).not.toHaveBeenCalled();
  });

  it("skips with 'unconfirmed_provenance' and per-line detail when the single candidate has no reimbursement evidence -- this bulk flow can't ask for confirmation inline", async () => {
    dbMock.patientHasAnyClaimRecords.mockResolvedValue(true);
    dbMock.findCms1500EnrichmentCandidates.mockResolvedValue([
      { id: "r1", authPeriod: 1, hasReimbursementEvidence: false },
    ]);

    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "cms1500",
      patientGroups: [cms1500Group("2026-05-19", "97110")],
    });

    expect(result.results[0].skippedUnconfirmedProvenance).toBe(1);
    expect(result.results[0].skippedCms1500Lines).toEqual([
      { dateOfService: "2026-05-19", cptCodes: "97110", reason: "unconfirmed_provenance" },
    ]);
    expect(dbMock.applyCms1500Enrichment).not.toHaveBeenCalled();
  });
});
