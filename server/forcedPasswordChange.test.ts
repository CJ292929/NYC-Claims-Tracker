/**
 * server/forcedPasswordChange.test.ts
 * S2.1: must_change_password enforcement moves server-side. A clinic session
 * with mustChangePassword=true must be rejected by every normal protected
 * procedure (normalProtectedProcedure / adminProcedure), while still being
 * able to reach auth.me, auth.logout, and clinic.changePassword — see
 * server/_core/trpc.ts's blockForcedPasswordChange middleware.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_CHANGE_REQUIRED_ERR_MSG } from "../shared/const";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser, ClinicStaffInfo } from "./_core/sdk";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    getAllPatients: vi.fn(),
  },
}));

vi.mock("./db", () => dbMock);

import { appRouter } from "./routers";

const CLINIC_USER_ID = "22222222-2222-2222-2222-222222222222";

function clinicStaff(overrides: Partial<ClinicStaffInfo> = {}): ClinicStaffInfo {
  return {
    clinicUserId: CLINIC_USER_ID,
    username: "nurse.jane",
    name: "Jane Nurse",
    email: "jane@example.com",
    department: "PT",
    role: "staff",
    mustChangePassword: true,
    ...overrides,
  };
}

function callerFor(user: AuthenticatedUser | null) {
  const ctx: TrpcContext = {
    user,
    req: {
      protocol: "https",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as TrpcContext["req"],
    res: {
      cookie: () => {},
      clearCookie: () => {},
    } as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

function clinicUser(staffOverrides: Partial<ClinicStaffInfo> = {}): AuthenticatedUser {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    openId: "clinic_nurse.jane",
    name: "nurse.jane",
    email: null,
    loginMethod: "password",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    clinicUser: clinicStaff(staffOverrides),
  };
}

function ownerUser(): AuthenticatedUser {
  return {
    id: "1",
    openId: "owner-id",
    name: "Owner",
    email: "owner@example.com",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.getAllPatients.mockResolvedValue([]);
});

describe("S2.1 server-side must_change_password enforcement", () => {
  it("A: clinic session with mustChangePassword=true is rejected by a normal protected procedure", async () => {
    const caller = callerFor(clinicUser({ mustChangePassword: true }));

    await expect(caller.patients.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: PASSWORD_CHANGE_REQUIRED_ERR_MSG,
    });
    expect(dbMock.getAllPatients).not.toHaveBeenCalled();
  });

  it("B: clinic session with mustChangePassword=false passes through a normal protected procedure", async () => {
    const caller = callerFor(clinicUser({ mustChangePassword: false }));

    await expect(caller.patients.list()).resolves.toEqual([]);
    expect(dbMock.getAllPatients).toHaveBeenCalledTimes(1);
  });

  it("C: owner OAuth session is never affected by the forced-change gate", async () => {
    const caller = callerFor(ownerUser());

    await expect(caller.patients.list()).resolves.toEqual([]);
    expect(dbMock.getAllPatients).toHaveBeenCalledTimes(1);
  });

  it("D: auth.me remains reachable during a forced password change", async () => {
    const caller = callerFor(clinicUser({ mustChangePassword: true }));

    await expect(caller.auth.me()).resolves.toMatchObject({
      authType: "clinic",
      mustChangePassword: true,
    });
  });

  it("E: auth.logout remains reachable during a forced password change", async () => {
    const caller = callerFor(clinicUser({ mustChangePassword: true }));

    await expect(caller.auth.logout()).resolves.toEqual({ success: true });
  });

  it("F: clinic.changePassword itself is exempt from the gate it enforces on everything else", async () => {
    // clinic.changePassword builds on protectedProcedure (not
    // normalProtectedProcedure) precisely so it stays reachable — its own
    // internal checks (current-password, archived, etc.) are covered in
    // clinicPasswordChange.test.ts and are independent of this gate.
    const caller = callerFor(clinicUser({ mustChangePassword: true }));

    await expect(
      caller.clinic.changePassword({ currentPassword: "x", newPassword: "y" })
    ).rejects.not.toMatchObject({ message: PASSWORD_CHANGE_REQUIRED_ERR_MSG });
  });

  it("G: a clinic admin with mustChangePassword=true is blocked by an admin procedure, before the role check", async () => {
    // adminProcedure is built on top of normalProtectedProcedure, so the
    // forced-change gate runs first — role can't be used to bypass it.
    const caller = callerFor(clinicUser({ role: "admin", mustChangePassword: true }));

    await expect(
      caller.system.notifyOwner({ title: "t", content: "c" })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: PASSWORD_CHANGE_REQUIRED_ERR_MSG,
    });
  });

  it("J: once mustChangePassword flips to false (post-change session), normal procedures are allowed again", async () => {
    const blockedCaller = callerFor(clinicUser({ mustChangePassword: true }));
    await expect(blockedCaller.patients.list()).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Represents the freshly issued session clinic.changePassword returns
    // (see clinicPasswordChange.test.ts U/V) — same identity, gate cleared.
    const clearedCaller = callerFor(clinicUser({ mustChangePassword: false }));
    await expect(clearedCaller.patients.list()).resolves.toEqual([]);
  });
});
