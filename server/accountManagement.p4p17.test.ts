/**
 * server/accountManagement.p4p17.test.ts
 * P4-P17: coverage specific to this phase's new account-management and
 * activity-log rules, on top of the pre-existing staffManagement.test.ts
 * suite:
 *   - Only the true owner (OAuth identity, never a clinic session) may
 *     grant/revoke admin privileges — a clinic admin can still edit profile
 *     fields but is rejected on a role change, even for someone else's
 *     account (not just their own, which staffManagement.test.ts already
 *     covers).
 *   - The "last active account manager" guard (surfaced via
 *     LastActiveAccountManagerError) blocks archiving or demoting the only
 *     remaining active admin, independent of who's performing the action.
 *   - activityLog.list is owner/admin only, same gate as Staff Management.
 *   - Every mutation router derives its actor exclusively from ctx.user —
 *     there is no actorId-shaped field in any mutation's input schema for a
 *     client to spoof, and a bogus extra field is silently stripped by Zod
 *     rather than read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClinicUser } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser, ClinicStaffInfo } from "./_core/sdk";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    getClinicUserById: vi.fn(),
    listClinicUsers: vi.fn(),
    updateClinicUserRole: vi.fn(),
    updateClinicUserProfile: vi.fn(),
    archiveClinicUser: vi.fn(),
    listActivityLog: vi.fn(),
    createPatient: vi.fn(),
    LastActiveAccountManagerError: class LastActiveAccountManagerError extends Error {
      constructor() {
        super("This is the only active admin account — it cannot be demoted or deactivated.");
        this.name = "LastActiveAccountManagerError";
      }
    },
    ClinicUserConflictError: class ClinicUserConflictError extends Error {
      constructor(id: string) {
        super(`Staff account ${id} changed during this request`);
        this.name = "ClinicUserConflictError";
      }
    },
  },
}));

vi.mock("./db", () => dbMock);
vi.mock("./_core/env", () => ({
  ENV: { appId: "test-app-id", cookieSecret: "test-only-session-signing-secret", oAuthServerUrl: "" },
}));

import { appRouter } from "./routers";
import { __resetLoginRateLimitForTests } from "./_core/loginRateLimit";

const ADMIN_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ADMIN_A: ClinicUser = {
  id: ADMIN_A_ID,
  username: "admin.a",
  passwordHash: "$2b$10$a",
  name: "Admin A",
  email: null,
  department: null,
  role: "admin",
  status: "active",
  mustChangePassword: false,
  tokenVersion: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastLoginAt: null,
  archivedAt: null,
};

const ADMIN_B: ClinicUser = { ...ADMIN_A, id: ADMIN_B_ID, username: "admin.b", name: "Admin B" };

function callerFor(user: AuthenticatedUser | null) {
  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

function clinicStaffInfo(row: ClinicUser, overrides: Partial<ClinicStaffInfo> = {}): ClinicStaffInfo {
  return {
    clinicUserId: row.id,
    username: row.username,
    name: row.name,
    email: row.email,
    department: row.department,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
    ...overrides,
  };
}

function clinicAdminCaller(row: ClinicUser) {
  const user: AuthenticatedUser = {
    id: `user-row-${row.id}`,
    openId: `clinic_${row.username}`,
    name: row.username,
    email: null,
    loginMethod: "password",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    clinicUser: clinicStaffInfo(row),
  };
  return callerFor(user);
}

function clinicStaffCaller() {
  const user: AuthenticatedUser = {
    id: "user-row-staff",
    openId: "clinic_staff.user",
    name: "staff.user",
    email: null,
    loginMethod: "password",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    clinicUser: clinicStaffInfo(ADMIN_A, { role: "staff", clinicUserId: "clinic-staff-1" }),
  };
  return callerFor(user);
}

function ownerCaller(role: "admin" | "user" = "admin") {
  const user: AuthenticatedUser = {
    id: "owner-1",
    openId: "owner-id",
    name: "Owner",
    email: "owner@example.com",
    loginMethod: "manus",
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return callerFor(user);
}

beforeEach(() => {
  __resetLoginRateLimitForTests();
  vi.clearAllMocks();
});

describe("staff.update — role changes are owner-only, not just self-protected", () => {
  it("a clinic admin cannot change a DIFFERENT staff member's role (owner-only, independent of self-protection)", async () => {
    dbMock.getClinicUserById.mockResolvedValue(ADMIN_B);

    await expect(
      clinicAdminCaller(ADMIN_A).staff.update({ id: ADMIN_B_ID, role: "staff" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbMock.updateClinicUserRole).not.toHaveBeenCalled();
  });

  it("the owner (OAuth identity) can change any staff member's role", async () => {
    dbMock.getClinicUserById
      .mockResolvedValueOnce(ADMIN_B)
      .mockResolvedValueOnce({ ...ADMIN_B, role: "staff" });
    dbMock.updateClinicUserRole.mockResolvedValue({ ...ADMIN_B, role: "staff" });

    const result = await ownerCaller().staff.update({ id: ADMIN_B_ID, role: "staff" });
    expect(dbMock.updateClinicUserRole).toHaveBeenCalledTimes(1);
    expect(result.role).toBe("staff");
  });

  it("a clinic admin can still edit a different staff member's profile fields (name/email/department) without touching role", async () => {
    dbMock.getClinicUserById
      .mockResolvedValueOnce(ADMIN_B)
      .mockResolvedValueOnce(ADMIN_B);
    dbMock.updateClinicUserProfile.mockResolvedValue(ADMIN_B);

    await clinicAdminCaller(ADMIN_A).staff.update({ id: ADMIN_B_ID, name: "Admin B Renamed" });
    expect(dbMock.updateClinicUserRole).not.toHaveBeenCalled();
    expect(dbMock.updateClinicUserProfile).toHaveBeenCalledWith(ADMIN_B_ID, { name: "Admin B Renamed" });
  });
});

describe("last active account manager guard", () => {
  it("archiving the only active admin is rejected with a readable error, not a generic 500", async () => {
    dbMock.getClinicUserById.mockResolvedValue(ADMIN_B);
    dbMock.archiveClinicUser.mockRejectedValue(new dbMock.LastActiveAccountManagerError());

    await expect(
      ownerCaller().staff.archive({ id: ADMIN_B_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("demoting the only active admin to staff is rejected the same way", async () => {
    dbMock.getClinicUserById.mockResolvedValue(ADMIN_B);
    dbMock.updateClinicUserRole.mockRejectedValue(new dbMock.LastActiveAccountManagerError());

    await expect(
      ownerCaller().staff.update({ id: ADMIN_B_ID, role: "staff" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("activityLog.list — owner/admin only", () => {
  it("owner can read the activity log", async () => {
    dbMock.listActivityLog.mockResolvedValue({ rows: [], total: 0 });
    await expect(ownerCaller().activityLog.list({})).resolves.toEqual({ rows: [], total: 0 });
  });

  it("clinic admin can read the activity log", async () => {
    dbMock.listActivityLog.mockResolvedValue({ rows: [], total: 0 });
    await expect(clinicAdminCaller(ADMIN_A).activityLog.list({})).resolves.toEqual({ rows: [], total: 0 });
  });

  it("normal staff cannot read the activity log", async () => {
    await expect(clinicStaffCaller().activityLog.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbMock.listActivityLog).not.toHaveBeenCalled();
  });

  it("unauthenticated caller is denied", async () => {
    await expect(callerFor(null).activityLog.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("actor identity cannot be spoofed by the client", () => {
  it("patients.create's input schema has no actor-shaped field, and a client-supplied one is silently dropped (never read)", async () => {
    dbMock.createPatient.mockResolvedValue("new-patient-id");

    await clinicAdminCaller(ADMIN_A).patients.create({
      name: "Jane Doe",
      insurance: "",
      // @ts-expect-error -- deliberately probing for a spoof vector that must not exist
      actorId: "someone-elses-id",
      // @ts-expect-error
      createdBy: "someone-elses-id",
    });

    // createPatient's second argument is always derived by the router via
    // getActorContext(ctx.user) — never forwarded from input — so the actor
    // reaching db.ts here can only be this caller's own clinic_user id.
    const [, actorArg] = dbMock.createPatient.mock.calls[0];
    expect(actorArg).toEqual({ actorId: ADMIN_A_ID, actorType: "clinic_user", actorDisplay: "Admin A" });
  });
});
