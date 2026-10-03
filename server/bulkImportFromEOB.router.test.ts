/**
 * server/bulkImportFromEOB.router.test.ts
 *
 * Covers the P4-P1 Cigna-import fix: bulkImportFromEOB must use the same
 * matching policy as the client preview (shared/nameMatch.ts), must never
 * auto-import a name that only produced an ambiguous "candidate" (e.g. a
 * spelled-out middle name), and must honor an explicit staff confirmation
 * for exactly the group it was given for -- while still reporting accurate
 * matched/unmatched/ambiguous results either way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./_core/sdk";
import type { Patient } from "../drizzle/schema";

const { dbMock, supabaseMock } = vi.hoisted(() => ({
  dbMock: {
    getAllPatients: vi.fn(),
    upsertClaimRecord: vi.fn(async () => "claim-id"),
  },
  supabaseMock: {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => Promise.resolve({ data: [], error: null }), // no prior visit_records -> auth period defaults to 1
      }),
    })),
  },
}));

vi.mock("./db", () => dbMock);
vi.mock("./supabase", () => ({ supabase: supabaseMock }));

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

function patient(id: string, name: string): Patient {
  return {
    id,
    name,
    insurance: "Cigna",
    authDate: null,
    authValidUntil: null,
    isActive: true,
    dischargeDate: null,
    dischargeReason: null,
    claimsStatus: "none",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

const JOHN_SMITH = patient("11111111-1111-4111-8111-111111111111", "JOHN SMITH");

function oneClaimGroup(patientName: string) {
  return {
    patientName,
    claims: [{ dateOfService: "2026-03-05", cptCodes: "97110", chargeAmount: 100, insuranceReimbursement: 80 }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.getAllPatients.mockResolvedValue([JOHN_SMITH]);
  dbMock.upsertClaimRecord.mockResolvedValue("claim-id");
  supabaseMock.from.mockReturnValue({
    select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
  });
});

describe("claims.bulkImportFromEOB — matching consistency", () => {
  it("a safe exact match auto-imports without any confirmation", async () => {
    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      patientGroups: [oneClaimGroup("JOHN SMITH")],
    });

    expect(result.results[0]).toMatchObject({ matched: true, patientId: JOHN_SMITH.id, claimsImported: 1 });
    expect(dbMock.upsertClaimRecord).toHaveBeenCalledTimes(1);
  });

  it("a spelled-out middle name is reported as an unmatched candidate, and nothing is imported", async () => {
    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      patientGroups: [oneClaimGroup("JOHN MICHAEL SMITH")],
    });

    expect(result.results[0]).toMatchObject({ matched: false, claimsImported: 0, ambiguousCandidates: 1 });
    expect(dbMock.upsertClaimRecord).not.toHaveBeenCalled();
  });

  it("a completely unrelated name is reported as unmatched with no ambiguous candidates", async () => {
    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      patientGroups: [oneClaimGroup("ALLISON AUYEUNG")],
    });

    expect(result.results[0].matched).toBe(false);
    expect(result.results[0].ambiguousCandidates).toBeUndefined();
    expect(dbMock.upsertClaimRecord).not.toHaveBeenCalled();
  });

  it("an explicit staff confirmation for the ambiguous group imports it, and only it", async () => {
    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      patientGroups: [oneClaimGroup("JOHN MICHAEL SMITH")],
      confirmedMatches: [{ groupIndex: 0, patientId: JOHN_SMITH.id }],
    });

    expect(result.results[0]).toMatchObject({ matched: true, patientId: JOHN_SMITH.id, claimsImported: 1 });
    expect(dbMock.upsertClaimRecord).toHaveBeenCalledTimes(1);
  });

  it("a confirmation naming a patient id that doesn't exist is ignored, not trusted blindly", async () => {
    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      patientGroups: [oneClaimGroup("JOHN MICHAEL SMITH")],
      confirmedMatches: [{ groupIndex: 0, patientId: "99999999-9999-4999-8999-999999999999" }],
    });

    expect(result.results[0].matched).toBe(false);
    expect(dbMock.upsertClaimRecord).not.toHaveBeenCalled();
  });

  // ── P4-P1R: a confirmation must only resolve to a patient who was actually
  //    an eligible candidate for THAT group -- a real, existing patient id
  //    that just has nothing to do with this group's extracted name must be
  //    rejected exactly like a nonexistent id, never silently honored.
  it("a confirmation naming a real patient who was never a candidate for this group is ignored", async () => {
    const UNRELATED = patient("22222222-2222-4222-8222-222222222222", "ALLISON AUYEUNG");
    dbMock.getAllPatients.mockResolvedValue([JOHN_SMITH, UNRELATED]);

    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      // "JOHN MICHAEL SMITH" only ever produces JOHN_SMITH as a candidate
      // (middle-name difference) -- UNRELATED shares no tokens with it at all.
      patientGroups: [oneClaimGroup("JOHN MICHAEL SMITH")],
      confirmedMatches: [{ groupIndex: 0, patientId: UNRELATED.id }],
    });

    expect(result.results[0].matched).toBe(false);
    expect(dbMock.upsertClaimRecord).not.toHaveBeenCalled();
  });

  // ── P4-P1R: groupIndex validation -- a confirmedMatches entry pointing at
  //    a group that doesn't exist in this request must be rejected outright
  //    rather than silently ignored, since silently ignoring it could mask a
  //    client-side indexing bug that misattributes confirmations to groups.
  it("a confirmedMatches entry with an out-of-range groupIndex is rejected", async () => {
    await expect(
      ownerCaller().claims.bulkImportFromEOB({
        uploadType: "reimbursement",
        patientGroups: [oneClaimGroup("JOHN MICHAEL SMITH")],
        confirmedMatches: [{ groupIndex: 5, patientId: JOHN_SMITH.id }],
      })
    ).rejects.toThrow(/groupIndex/i);
    expect(dbMock.upsertClaimRecord).not.toHaveBeenCalled();
  });

  // ── P4-P1R: two conflicting confirmations for the same group must be
  //    rejected rather than silently resolved by taking the last one --
  //    that's an ambiguous/malformed instruction, not something to guess at.
  it("two conflicting confirmations for the same groupIndex are rejected", async () => {
    const OTHER = patient("33333333-3333-4333-8333-333333333333", "JOHN SMITH");
    await expect(
      ownerCaller().claims.bulkImportFromEOB({
        uploadType: "reimbursement",
        patientGroups: [oneClaimGroup("JOHN MICHAEL SMITH")],
        confirmedMatches: [
          { groupIndex: 0, patientId: JOHN_SMITH.id },
          { groupIndex: 0, patientId: OTHER.id },
        ],
      })
    ).rejects.toThrow(/duplicate confirmation/i);
    expect(dbMock.upsertClaimRecord).not.toHaveBeenCalled();
  });

  // ── P4-P1R: duplicate exact-name patients in the roster must never be
  //    silently resolved to "whichever sorts first" -- both must surface as
  //    candidates requiring an explicit staff pick, and only the confirmed
  //    one gets the claim.
  it("two patients sharing the exact same dashboard name both surface as candidates, never auto-picked", async () => {
    const JOHN_SMITH_2 = patient("44444444-4444-4444-8444-444444444444", "JOHN SMITH");
    dbMock.getAllPatients.mockResolvedValue([JOHN_SMITH, JOHN_SMITH_2]);

    const unconfirmed = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      patientGroups: [oneClaimGroup("JOHN SMITH")],
    });
    expect(unconfirmed.results[0]).toMatchObject({ matched: false, ambiguousCandidates: 2 });
    expect(dbMock.upsertClaimRecord).not.toHaveBeenCalled();

    vi.clearAllMocks();
    dbMock.getAllPatients.mockResolvedValue([JOHN_SMITH, JOHN_SMITH_2]);
    dbMock.upsertClaimRecord.mockResolvedValue("claim-id");
    supabaseMock.from.mockReturnValue({
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    });

    const confirmed = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      patientGroups: [oneClaimGroup("JOHN SMITH")],
      confirmedMatches: [{ groupIndex: 0, patientId: JOHN_SMITH_2.id }],
    });
    expect(confirmed.results[0]).toMatchObject({ matched: true, patientId: JOHN_SMITH_2.id });
    expect(dbMock.upsertClaimRecord).toHaveBeenCalledTimes(1);
  });
});
