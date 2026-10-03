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
        eq: () => Promise.resolve({ data: [], error: null }),
      }),
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

const ALLISON = patient("11111111-1111-4111-8111-111111111111", "ALLISON AUYEUNG");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.getAllPatients.mockResolvedValue([ALLISON]);
  dbMock.upsertClaimRecord.mockResolvedValue("claim-id");
  supabaseMock.from.mockReturnValue({
    select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
  });
});

describe("repro: group ownership across matched + skipped groups", () => {
  it("a skipped group's claim lines must never be written under the matched group's patient", async () => {
    const allisonGroup = {
      patientName: "ALLISON AUYEUNG",
      claims: [
        { dateOfService: "2020-04-10", cptCodes: "97110", chargeAmount: 125, insuranceReimbursement: 125 },
        { dateOfService: "2020-04-13", cptCodes: "97110", chargeAmount: 125, insuranceReimbursement: 125 },
        { dateOfService: "2020-04-15", cptCodes: "97110", chargeAmount: 125, insuranceReimbursement: 125 },
        { dateOfService: "2020-04-17", cptCodes: "97110", chargeAmount: 125, insuranceReimbursement: 125 },
      ],
    };
    const rahmanGroup = {
      patientName: "SYED RAHMAN", // not in roster -> must be skipped
      claims: [
        { dateOfService: "2021-01-13", cptCodes: "97112", chargeAmount: 90, insuranceReimbursement: 90 },
        { dateOfService: "2021-01-20", cptCodes: "97112", chargeAmount: 90, insuranceReimbursement: 90 },
        { dateOfService: "2021-01-27", cptCodes: "97112", chargeAmount: 90, insuranceReimbursement: 90 },
        { dateOfService: "2021-02-03", cptCodes: "97112", chargeAmount: 90, insuranceReimbursement: 90 },
      ],
    };

    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      patientGroups: [allisonGroup, rahmanGroup],
    });

    expect(result.results[0]).toMatchObject({ matched: true, patientId: ALLISON.id, claimsImported: 4 });
    expect(result.results[1]).toMatchObject({ matched: false, claimsImported: 0 });

    // Exactly 4 upserts, all for ALLISON, all with ALLISON's own dates/CPTs.
    expect(dbMock.upsertClaimRecord).toHaveBeenCalledTimes(4);
    const calls = dbMock.upsertClaimRecord.mock.calls.map(c => c[0]);
    for (const call of calls) {
      expect(call.patientId).toBe(ALLISON.id);
      expect(call.cptCodes).toBe("97110");
    }
    const dates = calls.map(c => c.dateOfService.toISOString().slice(0, 10)).sort();
    expect(dates).toEqual(["2020-04-10", "2020-04-13", "2020-04-15", "2020-04-17"]);
  });

  it("skipped group ordered BEFORE the matched group still isolates claim lines", async () => {
    const rahmanGroup = {
      patientName: "SYED RAHMAN",
      claims: [
        { dateOfService: "2021-01-13", cptCodes: "97112", chargeAmount: 90, insuranceReimbursement: 90 },
        { dateOfService: "2021-01-20", cptCodes: "97112", chargeAmount: 90, insuranceReimbursement: 90 },
      ],
    };
    const allisonGroup = {
      patientName: "ALLISON AUYEUNG",
      claims: [
        { dateOfService: "2020-04-10", cptCodes: "97110", chargeAmount: 125, insuranceReimbursement: 125 },
      ],
    };

    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      patientGroups: [rahmanGroup, allisonGroup],
    });

    expect(result.results[0]).toMatchObject({ matched: false, claimsImported: 0 });
    expect(result.results[1]).toMatchObject({ matched: true, patientId: ALLISON.id, claimsImported: 1 });
    expect(dbMock.upsertClaimRecord).toHaveBeenCalledTimes(1);
    const call = dbMock.upsertClaimRecord.mock.calls[0][0];
    expect(call.patientId).toBe(ALLISON.id);
    expect(call.dateOfService.toISOString().slice(0, 10)).toBe("2020-04-10");
  });

  it("cptLines-nested groups: a skipped group's line items never bleed into the matched group's writes", async () => {
    const allisonGroup = {
      patientName: "ALLISON AUYEUNG",
      claims: [
        {
          dateOfService: "2020-04-10",
          cptLines: [
            { cptCodes: "97110", chargeAmount: 125, insuranceReimbursement: 125 },
          ],
        },
      ],
    };
    const rahmanGroup = {
      patientName: "SYED RAHMAN",
      claims: [
        {
          dateOfService: "2021-01-13",
          cptLines: [
            { cptCodes: "97112", chargeAmount: 90, insuranceReimbursement: 90 },
          ],
        },
      ],
    };

    await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      patientGroups: [allisonGroup, rahmanGroup],
    });

    expect(dbMock.upsertClaimRecord).toHaveBeenCalledTimes(1);
    const call = dbMock.upsertClaimRecord.mock.calls[0][0];
    expect(call.patientId).toBe(ALLISON.id);
    expect(call.cptCodes).toBe("97110");
    expect(call.dateOfService.toISOString().slice(0, 10)).toBe("2020-04-10");
  });

  it("an explicit confirmation for one ambiguous group never attaches a sibling group's claims", async () => {
    const BOB = patient("22222222-2222-4222-8222-222222222222", "BOB JONES");
    dbMock.getAllPatients.mockResolvedValue([ALLISON, BOB]);

    const ambiguousGroup = { // "ALLISON AUYEUNG MARIE" -> candidate match on ALLISON (middle name)
      patientName: "ALLISON MARIE AUYEUNG",
      claims: [
        { dateOfService: "2022-05-01", cptCodes: "99999", chargeAmount: 50, insuranceReimbursement: 50 },
      ],
    };
    const bobGroup = {
      patientName: "BOB JONES",
      claims: [
        { dateOfService: "2022-06-01", cptCodes: "11111", chargeAmount: 60, insuranceReimbursement: 60 },
      ],
    };

    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      patientGroups: [ambiguousGroup, bobGroup],
      confirmedMatches: [{ groupIndex: 0, patientId: ALLISON.id }],
    });

    expect(result.results[0]).toMatchObject({ matched: true, patientId: ALLISON.id, claimsImported: 1 });
    expect(result.results[1]).toMatchObject({ matched: true, patientId: BOB.id, claimsImported: 1 });
    expect(dbMock.upsertClaimRecord).toHaveBeenCalledTimes(2);
    const calls = dbMock.upsertClaimRecord.mock.calls.map(c => c[0]);
    const forAllison = calls.find(c => c.patientId === ALLISON.id);
    const forBob = calls.find(c => c.patientId === BOB.id);
    expect(forAllison.cptCodes).toBe("99999");
    expect(forBob.cptCodes).toBe("11111");
  });

  it("two groups that both safely match (no skip, no confirmation needed) never cross-write each other's lines", async () => {
    const BOB = patient("22222222-2222-4222-8222-222222222222", "BOB JONES");
    dbMock.getAllPatients.mockResolvedValue([ALLISON, BOB]);

    const allisonGroup = {
      patientName: "ALLISON AUYEUNG",
      claims: [
        { dateOfService: "2020-04-10", cptCodes: "97110", chargeAmount: 125, insuranceReimbursement: 125 },
        { dateOfService: "2020-04-13", cptCodes: "97110", chargeAmount: 125, insuranceReimbursement: 125 },
      ],
    };
    const bobGroup = {
      patientName: "BOB JONES",
      claims: [
        { dateOfService: "2021-01-13", cptCodes: "97112", chargeAmount: 90, insuranceReimbursement: 90 },
      ],
    };

    const result = await ownerCaller().claims.bulkImportFromEOB({
      uploadType: "reimbursement",
      patientGroups: [allisonGroup, bobGroup],
    });

    expect(result.results[0]).toMatchObject({ matched: true, patientId: ALLISON.id, claimsImported: 2 });
    expect(result.results[1]).toMatchObject({ matched: true, patientId: BOB.id, claimsImported: 1 });
    expect(dbMock.upsertClaimRecord).toHaveBeenCalledTimes(3);
    const calls = dbMock.upsertClaimRecord.mock.calls.map(c => c[0]);
    const forAllison = calls.filter(c => c.patientId === ALLISON.id);
    const forBob = calls.filter(c => c.patientId === BOB.id);
    expect(forAllison).toHaveLength(2);
    expect(forBob).toHaveLength(1);
    expect(forAllison.every(c => c.cptCodes === "97110")).toBe(true);
    expect(forBob.every(c => c.cptCodes === "97112")).toBe(true);
  });

  // ── Duplicate-name confirmation and invalid/conflicting confirmations are
  //    already covered end-to-end by server/bulkImportFromEOB.router.test.ts:
  //      - "two patients sharing the exact same dashboard name both surface
  //         as candidates, never auto-picked" (duplicate-name confirmation)
  //      - "a confirmation naming a patient id that doesn't exist is ignored"
  //      - "a confirmation naming a real patient who was never a candidate
  //         for this group is ignored"
  //      - "a confirmedMatches entry with an out-of-range groupIndex is
  //         rejected"
  //      - "two conflicting confirmations for the same groupIndex are
  //         rejected"
  //    Not duplicated here -- see that file for those cases.
});
