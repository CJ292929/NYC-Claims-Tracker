/**
 * server/authRequestHold.router.test.ts
 *
 * Router-level (DB mocked) coverage for visits.holdAuthorizationRequest and
 * visits.releaseAuthorizationRequestHold: the authorization gate
 * (normalProtectedProcedure — Staff, Admin and Owner allowed, signed-out and
 * must-change-password refused, no Claims access needed), reason validation,
 * stale-scope refusal, session-derived actor, error mapping, and that Resume
 * re-derives the category from current data. The atomic audited RPCs are
 * proven against real Postgres in authRequestHold.pg.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser, ClinicStaffInfo } from "./_core/sdk";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    getAuthAlertSummaries: vi.fn(),
    holdAuthorizationRequest: vi.fn(),
    releaseAuthorizationRequestHold: vi.fn(),
    updateVisitRecord: vi.fn(),
    approveAndCreateNewBatch: vi.fn(),
    setAuthPeriodExpired: vi.fn(),
  },
}));
vi.mock("./db", () => dbMock);
vi.mock("./supabase", () => ({ supabase: { from: vi.fn(() => { throw new Error("supabase must not be reached"); }) } }));

import { appRouter } from "./routers";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const HOLD_ID = "22222222-2222-4222-8222-222222222222";

function callerFor(user: AuthenticatedUser | null) {
  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}
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
const ADMIN = clinicUser("admin");
const OWNER = {
  id: "owner-1", openId: "owner-id", name: "Synthetic Owner", email: null, loginMethod: "manus", role: "admin",
  createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
} as AuthenticatedUser;
const MUST_CHANGE = clinicUser("staff", { mustChangePassword: true });
const pgError = (code: string) => Object.assign(new Error(code), { code });

function summary(over: Record<string, unknown> = {}) {
  return {
    patientId: PATIENT_ID, patientName: "Synthetic Patient", insurance: "Synthetic Ins",
    urgency: "critical", authStatus: "pending", authPeriod: 2, latestAuthPeriod: 2, hold: null, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.getAuthAlertSummaries.mockResolvedValue([summary()]);
  dbMock.holdAuthorizationRequest.mockResolvedValue({ holdId: HOLD_ID, changed: true });
  dbMock.releaseAuthorizationRequestHold.mockResolvedValue(true);
});

describe("visits.holdAuthorizationRequest", () => {
  it("holds the period the caller saw, with a trimmed reason and the session-derived actor; touches nothing else", async () => {
    const out = await callerFor(STAFF).visits.holdAuthorizationRequest({ patientId: PATIENT_ID, authPeriod: 2, reason: "  Waiting on referral  " });
    expect(out).toEqual({ success: true, holdId: HOLD_ID, changed: true });
    expect(dbMock.getAuthAlertSummaries).toHaveBeenCalledWith(PATIENT_ID);
    expect(dbMock.holdAuthorizationRequest).toHaveBeenCalledWith(
      PATIENT_ID, 2, 2, "Waiting on referral",
      { actorId: "clinic-staff-1", actorType: "clinic_user", actorDisplay: "Clinic staff" },
    );
    expect(dbMock.updateVisitRecord).not.toHaveBeenCalled();
    expect(dbMock.approveAndCreateNewBatch).not.toHaveBeenCalled();
    expect(dbMock.setAuthPeriodExpired).not.toHaveBeenCalled();
  });

  it("passes the newest period separately so an older active period can be held", async () => {
    dbMock.getAuthAlertSummaries.mockResolvedValue([summary({ authPeriod: 1, latestAuthPeriod: 2 })]);
    await callerFor(STAFF).visits.holdAuthorizationRequest({ patientId: PATIENT_ID, authPeriod: 1, reason: "r" });
    expect(dbMock.holdAuthorizationRequest).toHaveBeenCalledWith(PATIENT_ID, 1, 2, "r", expect.anything());
  });

  it("supports a patient with no period yet (authPeriod null)", async () => {
    dbMock.getAuthAlertSummaries.mockResolvedValue([summary({ authPeriod: null, latestAuthPeriod: null, urgency: "ok", authStatus: "none" })]);
    await callerFor(STAFF).visits.holdAuthorizationRequest({ patientId: PATIENT_ID, authPeriod: null, reason: "r" });
    expect(dbMock.holdAuthorizationRequest).toHaveBeenCalledWith(PATIENT_ID, null, null, "r", expect.anything());
  });

  it("requires a nonblank reason of at most 500 characters", async () => {
    for (const reason of ["", "   ", "\n\t", "x".repeat(501)]) {
      await expect(callerFor(STAFF).visits.holdAuthorizationRequest({ patientId: PATIENT_ID, authPeriod: 2, reason }))
        .rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(dbMock.holdAuthorizationRequest).not.toHaveBeenCalled();
  });

  it("refuses a stale screen: the period the caller saw is no longer the target period", async () => {
    dbMock.getAuthAlertSummaries.mockResolvedValue([summary({ authPeriod: 3, latestAuthPeriod: 3 })]);
    await expect(callerFor(STAFF).visits.holdAuthorizationRequest({ patientId: PATIENT_ID, authPeriod: 2, reason: "r" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(dbMock.holdAuthorizationRequest).not.toHaveBeenCalled();
  });

  it("a retry is reported as unchanged (the RPC writes no second audit row)", async () => {
    dbMock.holdAuthorizationRequest.mockResolvedValue({ holdId: HOLD_ID, changed: false });
    const out = await callerFor(STAFF).visits.holdAuthorizationRequest({ patientId: PATIENT_ID, authPeriod: 2, reason: "r" });
    expect(out.changed).toBe(false);
  });

  it("maps RPC refusals to user-facing errors", async () => {
    const input = { patientId: PATIENT_ID, authPeriod: 2, reason: "r" };
    for (const [pg, trpc] of [["P0020", "NOT_FOUND"], ["P0050", "CONFLICT"], ["P0051", "CONFLICT"], ["22023", "BAD_REQUEST"]] as const) {
      dbMock.holdAuthorizationRequest.mockRejectedValueOnce(pgError(pg));
      await expect(callerFor(STAFF).visits.holdAuthorizationRequest(input)).rejects.toMatchObject({ code: trpc });
    }
    dbMock.getAuthAlertSummaries.mockResolvedValue([]);
    await expect(callerFor(STAFF).visits.holdAuthorizationRequest(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("visits.releaseAuthorizationRequestHold (Remove Hold / Resume)", () => {
  it("releases, then re-derives the category from current data", async () => {
    dbMock.getAuthAlertSummaries.mockResolvedValue([summary({ urgency: "critical", hold: null })]);
    const out = await callerFor(STAFF).visits.releaseAuthorizationRequestHold({ patientId: PATIENT_ID, holdId: HOLD_ID });
    expect(dbMock.releaseAuthorizationRequestHold).toHaveBeenCalledWith(PATIENT_ID, HOLD_ID, expect.objectContaining({ actorType: "clinic_user" }));
    expect(out).toEqual({ success: true, changed: true, category: "attention", urgency: "critical" });
  });

  it("a patient whose authorization was approved meanwhile resumes as on track, not into an alert", async () => {
    dbMock.getAuthAlertSummaries.mockResolvedValue([summary({ urgency: "ok", authStatus: "approved", authPeriod: 3, latestAuthPeriod: 3 })]);
    const out = await callerFor(STAFF).visits.releaseAuthorizationRequestHold({ patientId: PATIENT_ID, holdId: HOLD_ID });
    expect(out.category).toBe("ok");
  });

  it("a retry / concurrent resume is unchanged", async () => {
    dbMock.releaseAuthorizationRequestHold.mockResolvedValue(false);
    const out = await callerFor(STAFF).visits.releaseAuthorizationRequestHold({ patientId: PATIENT_ID, holdId: HOLD_ID });
    expect(out.changed).toBe(false);
  });

  it("maps a missing patient or hold to NOT_FOUND", async () => {
    for (const pg of ["P0020", "P0052"]) {
      dbMock.releaseAuthorizationRequestHold.mockRejectedValueOnce(pgError(pg));
      await expect(callerFor(STAFF).visits.releaseAuthorizationRequestHold({ patientId: PATIENT_ID, holdId: HOLD_ID }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
});

describe("permissions (same gate as Mark Requested / Approve)", () => {
  it("Staff, Admin and Owner may hold and resume; the actor comes from the session", async () => {
    for (const [user, actorType] of [[STAFF, "clinic_user"], [ADMIN, "clinic_user"], [OWNER, "owner"]] as const) {
      await callerFor(user).visits.holdAuthorizationRequest({ patientId: PATIENT_ID, authPeriod: 2, reason: "r" });
      await callerFor(user).visits.releaseAuthorizationRequestHold({ patientId: PATIENT_ID, holdId: HOLD_ID });
      expect(dbMock.holdAuthorizationRequest).toHaveBeenLastCalledWith(PATIENT_ID, 2, 2, "r", expect.objectContaining({ actorType }));
    }
    expect(dbMock.holdAuthorizationRequest).toHaveBeenCalledTimes(3);
  });

  it("signed-out and must-change-password callers are refused before any DB call", async () => {
    await expect(callerFor(null).visits.holdAuthorizationRequest({ patientId: PATIENT_ID, authPeriod: 2, reason: "r" }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(callerFor(null).visits.releaseAuthorizationRequestHold({ patientId: PATIENT_ID, holdId: HOLD_ID }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(callerFor(MUST_CHANGE).visits.holdAuthorizationRequest({ patientId: PATIENT_ID, authPeriod: 2, reason: "r" })).rejects.toBeTruthy();
    expect(dbMock.getAuthAlertSummaries).not.toHaveBeenCalled();
    expect(dbMock.holdAuthorizationRequest).not.toHaveBeenCalled();
    expect(dbMock.releaseAuthorizationRequestHold).not.toHaveBeenCalled();
  });
});
