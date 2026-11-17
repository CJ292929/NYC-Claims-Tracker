/**
 * server/periodSessionCorrection.router.test.ts — P4-P32
 *
 * Router-level (DB mocked) coverage for entering Sessions Authorized after
 * patient creation: visits.approveAuthorization's explicit `initial` mode,
 * visits.correctPeriodSessions, their permission gate, their refusal
 * messages, and that an unrelated patient edit never reaches an
 * authorization-count write. The database rules themselves are proven in
 * periodSessionCorrection.pg.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser, ClinicStaffInfo } from "./_core/sdk";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    approveAndCreateNewBatch: vi.fn(),
    createInitialAuthorization: vi.fn(),
    correctAuthPeriodSessions: vi.fn(),
    getPatientById: vi.fn(),
    updatePatient: vi.fn(),
  },
}));
vi.mock("./db", () => dbMock);
vi.mock("./supabase", () => ({ supabase: { from: vi.fn(() => { throw new Error("supabase must not be reached"); }) } }));

import { appRouter } from "./routers";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function callerFor(user: AuthenticatedUser | null) {
  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

/** Synthetic Clinic Staff identity (no Claims access). */
function clinicUser(role: ClinicStaffInfo["role"], extra: Partial<ClinicStaffInfo> = {}): AuthenticatedUser {
  return {
    id: "u-1", openId: `clinic_${role}`, name: "User", email: null, loginMethod: "password", role: "user",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    clinicUser: {
      clinicUserId: `clinic-${role}-1`, username: `${role}.user`, name: `Clinic ${role}`,
      email: null, department: null, role, mustChangePassword: false, ...extra,
    },
  } as AuthenticatedUser;
}
const STAFF = clinicUser("staff");
const MUST_CHANGE = clinicUser("staff", { mustChangePassword: true });

const pgError = (code: string, message = "", details?: string) => Object.assign(new Error(message), { code, details });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.createInitialAuthorization.mockResolvedValue({ newVisitIds: Array.from({ length: 16 }, (_, i) => `v${i}`) });
  dbMock.approveAndCreateNewBatch.mockResolvedValue({ newVisitIds: ["a"] });
  dbMock.correctAuthPeriodSessions.mockResolvedValue({ changed: true, sessionsAuthorized: 20, added: 4, removed: 0 });
});

describe("visits.approveAuthorization — initial mode", () => {
  it("initial: true creates the initial period through createInitialAuthorization, never the renewal path", async () => {
    const out = await callerFor(STAFF).visits.approveAuthorization({
      patientId: PATIENT_ID, sessionsAuthorized: 16, authDate: "2026-11-10", initial: true,
    });
    expect(out).toEqual({ success: true, newVisitCount: 16, authPeriod: 1 });
    expect(dbMock.createInitialAuthorization).toHaveBeenCalledWith(
      PATIENT_ID, 16, new Date("2026-11-10T00:00:00Z"), undefined, undefined, expect.objectContaining({ actorDisplay: expect.any(String) }),
    );
    expect(dbMock.approveAndCreateNewBatch).not.toHaveBeenCalled();
  });

  it("a retry after the initial period exists is refused with CONFLICT, not turned into a renewal", async () => {
    dbMock.createInitialAuthorization.mockRejectedValue(pgError("P0044"));
    await expect(callerFor(STAFF).visits.approveAuthorization({ patientId: PATIENT_ID, sessionsAuthorized: 16, initial: true }))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("already has an authorization period") });
    expect(dbMock.approveAndCreateNewBatch).not.toHaveBeenCalled();
  });

  it("without initial, a patient with no period gets a clear PRECONDITION_FAILED, not a raw error", async () => {
    dbMock.approveAndCreateNewBatch.mockRejectedValue(pgError("P0034"));
    await expect(callerFor(STAFF).visits.approveAuthorization({ patientId: PATIENT_ID, sessionsAuthorized: 16 }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("Record Initial Authorization") });
    expect(dbMock.createInitialAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a non-integer or out-of-range count before any write", async () => {
    for (const sessionsAuthorized of [0, 2.5, 201]) {
      await expect(callerFor(STAFF).visits.approveAuthorization({ patientId: PATIENT_ID, sessionsAuthorized, initial: true }))
        .rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(dbMock.createInitialAuthorization).not.toHaveBeenCalled();
  });
});

describe("visits.correctPeriodSessions", () => {
  const input = { patientId: PATIENT_ID, authPeriod: 2, sessionsAuthorized: 20, expectedCurrent: 16, reason: "Payer letter says 20" };

  it("Staff (same gate as approval / expiry) can correct; the reason and expected count are passed through", async () => {
    const out = await callerFor(STAFF).visits.correctPeriodSessions(input);
    expect(out).toEqual({ success: true, changed: true, sessionsAuthorized: 20, added: 4, removed: 0 });
    expect(dbMock.correctAuthPeriodSessions).toHaveBeenCalledWith(PATIENT_ID, 2, 20, 16, "Payer letter says 20", expect.anything());
  });

  it("signed-out and must-change-password sessions are refused before any write", async () => {
    await expect(callerFor(null).visits.correctPeriodSessions(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(callerFor(MUST_CHANGE).visits.correctPeriodSessions(input)).rejects.toBeTruthy();
    expect(dbMock.correctAuthPeriodSessions).not.toHaveBeenCalled();
  });

  it("rejects a count below 1 or a non-integer", async () => {
    for (const sessionsAuthorized of [0, -3, 1.5]) {
      await expect(callerFor(STAFF).visits.correctPeriodSessions({ ...input, sessionsAuthorized })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(dbMock.correctAuthPeriodSessions).not.toHaveBeenCalled();
  });

  it.each([
    ["P0040", "CONFLICT", "marked Expired"],
    ["P0041", "BAD_REQUEST", "lower than the 13 completed"],
    ["P0042", "CONFLICT", "remove session(s) 15, 16"],
    ["P0043", "CONFLICT", "changed by someone else"],
    ["P0034", "NOT_FOUND", "Period 2 was not found"],
  ])("explains refusal %s", async (pgCode, trpcCode, text) => {
    dbMock.correctAuthPeriodSessions.mockRejectedValue(
      pgError(pgCode, pgCode === "P0041" ? "sessions_below_completed: 10 is below the 13 completed sessions of period 2" : "", "15, 16"),
    );
    await expect(callerFor(STAFF).visits.correctPeriodSessions(input))
      .rejects.toMatchObject({ code: trpcCode, message: expect.stringContaining(text) });
  });
});

describe("patients.update — unrelated edits never touch authorization counts", () => {
  it("a name-only edit writes the patient row only", async () => {
    dbMock.getPatientById.mockResolvedValue({ id: PATIENT_ID, name: "Synthetic A", insurance: "Synthetic Ins" });
    await callerFor(STAFF).patients.update({ id: PATIENT_ID, name: "Synthetic B" });
    expect(dbMock.updatePatient).toHaveBeenCalledWith(PATIENT_ID, { name: "Synthetic B" }, expect.anything());
    expect(dbMock.correctAuthPeriodSessions).not.toHaveBeenCalled();
    expect(dbMock.createInitialAuthorization).not.toHaveBeenCalled();
    expect(dbMock.approveAndCreateNewBatch).not.toHaveBeenCalled();
  });
});
