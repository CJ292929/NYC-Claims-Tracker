/**
 * server/clearDateOfService.router.test.ts
 *
 * Router-level (DB mocked) coverage for visits.clearDateOfService: it writes
 * ONLY date_of_service = null on the selected row, through the audited
 * write path with the patient as an ownership guard and its own audit
 * action; it uses the normal session-edit gate (Staff included, no Claims
 * access needed); and its refusals become user-facing messages. The audited
 * RPC itself (atomic row + audit write, no-op on a repeat) is proven against
 * real Postgres in clearDateOfService.pg.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser, ClinicStaffInfo } from "./_core/sdk";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    updateVisitRecord: vi.fn(),
    setAuthPeriodExpired: vi.fn(),
  },
}));
vi.mock("./db", () => dbMock);
vi.mock("./supabase", () => ({ supabase: { from: vi.fn(() => { throw new Error("supabase must not be reached"); }) } }));

import { appRouter } from "./routers";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const VISIT_ID = "33333333-3333-4333-8333-333333333333";

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
const pgError = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.updateVisitRecord.mockResolvedValue(undefined);
});

describe("visits.clearDateOfService", () => {
  it("clears only date_of_service on the exact row, audited, with the patient as ownership guard", async () => {
    const out = await callerFor(STAFF).visits.clearDateOfService({ id: VISIT_ID, patientId: PATIENT_ID });
    expect(out).toEqual({ success: true });
    expect(dbMock.updateVisitRecord).toHaveBeenCalledTimes(1);
    const [id, data, actor, options] = dbMock.updateVisitRecord.mock.calls[0];
    expect(id).toBe(VISIT_ID);
    // Exactly one key: no status, period, count, claim or money field.
    expect(data).toEqual({ dateOfService: null });
    expect(actor).toEqual(expect.objectContaining({ actorDisplay: expect.any(String) }));
    expect(options).toEqual({ action: "SESSION_DATE_OF_SERVICE_CLEARED", patientId: PATIENT_ID });
    // Never touches the period-level expiry mark.
    expect(dbMock.setAuthPeriodExpired).not.toHaveBeenCalled();
  });

  it("uses the normal session-edit gate: signed-out and must-change-password are refused", async () => {
    const input = { id: VISIT_ID, patientId: PATIENT_ID };
    await expect(callerFor(null).visits.clearDateOfService(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(callerFor(MUST_CHANGE).visits.clearDateOfService(input)).rejects.toBeTruthy();
    expect(dbMock.updateVisitRecord).not.toHaveBeenCalled();
  });

  it("rejects non-UUID ids before reaching the database", async () => {
    await expect(callerFor(STAFF).visits.clearDateOfService({ id: "nope", patientId: PATIENT_ID })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMock.updateVisitRecord).not.toHaveBeenCalled();
  });

  it("maps a missing row and a patient mismatch to useful errors", async () => {
    dbMock.updateVisitRecord.mockRejectedValueOnce(pgError("P0030"));
    await expect(callerFor(STAFF).visits.clearDateOfService({ id: VISIT_ID, patientId: PATIENT_ID }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("Session not found") });
    dbMock.updateVisitRecord.mockRejectedValueOnce(pgError("P0031"));
    await expect(callerFor(STAFF).visits.clearDateOfService({ id: VISIT_ID, patientId: PATIENT_ID }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("does not belong") });
  });

  it("surfaces unexpected failures instead of reporting success", async () => {
    dbMock.updateVisitRecord.mockRejectedValueOnce(new Error("connection reset"));
    await expect(callerFor(STAFF).visits.clearDateOfService({ id: VISIT_ID, patientId: PATIENT_ID })).rejects.toBeTruthy();
  });
});
