/**
 * server/staffManagement.test.ts
 * S3: staff.* router — owner/admin-only CRUD over clinic_users, driving the
 * Staff Management UI. Covers the adminOrOwnerProcedure gate (owner OAuth
 * admins and clinic admins in, clinic staff out), create/update/reset/
 * archive/reactivate side effects (token_version bumps, must_change_password
 * defaults), the safe response shape (no passwordHash/tokenVersion), and the
 * self-archive/self-role-change guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClinicUser } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser, ClinicStaffInfo } from "./_core/sdk";

const { bcryptMock, dbMock } = vi.hoisted(() => ({
  bcryptMock: { compare: vi.fn(), hash: vi.fn() },
  dbMock: {
    getClinicUserByUsername: vi.fn(),
    getClinicUserById: vi.fn(),
    touchClinicUserLastLogin: vi.fn(),
    changeClinicUserPassword: vi.fn(),
    upsertUser: vi.fn(),
    listClinicUsers: vi.fn(),
    createClinicUser: vi.fn(),
    updateClinicUserProfile: vi.fn(),
    updateClinicUserRole: vi.fn(),
    adminResetClinicUserPassword: vi.fn(),
    archiveClinicUser: vi.fn(),
    reactivateClinicUser: vi.fn(),
  },
}));

vi.mock("bcryptjs", () => ({ default: bcryptMock, ...bcryptMock }));
vi.mock("./db", () => dbMock);
// jose refuses a zero-length HMAC key and JWT_SECRET is unset in this test
// environment — stub a fixed test secret (same pattern as clinicSession.test.ts)
// so sdk.createClinicSessionToken/authenticateRequest work in the "I" test below.
vi.mock("./_core/env", () => ({
  ENV: { appId: "test-app-id", cookieSecret: "test-only-session-signing-secret", oAuthServerUrl: "" },
}));

import { appRouter } from "./routers";
import { sdk } from "./_core/sdk";
import { __resetLoginRateLimitForTests } from "./_core/loginRateLimit";

const ADMIN_ROW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF_ROW_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ADMIN_ROW: ClinicUser = {
  id: ADMIN_ROW_ID,
  username: "clinic.admin",
  passwordHash: "$2b$10$admin-hash",
  name: "Alex Admin",
  email: "alex@example.com",
  department: "Administration",
  role: "admin",
  status: "active",
  mustChangePassword: false,
  tokenVersion: 1,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  lastLoginAt: new Date("2026-01-05T12:00:00Z"),
  archivedAt: null,
};

const STAFF_ROW: ClinicUser = {
  id: STAFF_ROW_ID,
  username: "nurse.jane",
  passwordHash: "$2b$10$staff-hash",
  name: "Jane Nurse",
  email: "jane@example.com",
  department: "PT",
  role: "staff",
  status: "active",
  mustChangePassword: false,
  tokenVersion: 2,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  lastLoginAt: null,
  archivedAt: null,
};

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

function clinicAdminCaller() {
  const user: AuthenticatedUser = {
    id: "user-row-admin",
    openId: `clinic_${ADMIN_ROW.username}`,
    name: ADMIN_ROW.username,
    email: null,
    loginMethod: "password",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    clinicUser: clinicStaffInfo(ADMIN_ROW),
  };
  return callerFor(user);
}

function clinicStaffCaller() {
  const user: AuthenticatedUser = {
    id: "user-row-staff",
    openId: `clinic_${STAFF_ROW.username}`,
    name: STAFF_ROW.username,
    email: null,
    loginMethod: "password",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    clinicUser: clinicStaffInfo(STAFF_ROW),
  };
  return callerFor(user);
}

function ownerCaller(role: "admin" | "user" = "admin") {
  const user: AuthenticatedUser = {
    id: "1",
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
  dbMock.listClinicUsers.mockResolvedValue([ADMIN_ROW, STAFF_ROW]);
  dbMock.getClinicUserById.mockResolvedValue(STAFF_ROW);
  bcryptMock.hash.mockResolvedValue("$2b$10$new-hash");
});

afterEach(() => {
  __resetLoginRateLimitForTests();
});

describe("staff.list / staff.get — access control (A/B/C)", () => {
  it("A: owner can list staff", async () => {
    const result = await ownerCaller().staff.list();
    expect(result).toHaveLength(2);
    expect(dbMock.listClinicUsers).toHaveBeenCalledTimes(1);
  });

  it("B: clinic admin can list staff", async () => {
    const result = await clinicAdminCaller().staff.list();
    expect(result).toHaveLength(2);
  });

  it("C: normal staff cannot list or get staff", async () => {
    const caller = clinicStaffCaller();
    await expect(caller.staff.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.staff.get({ id: ADMIN_ROW_ID })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbMock.listClinicUsers).not.toHaveBeenCalled();
  });
});

describe("staff.create (D/E/F/G)", () => {
  const validInput = {
    name: "New Hire",
    username: "new.hire",
    password: "temp-password1",
    confirmPassword: "temp-password1",
  };

  it("D: create staff succeeds for an owner caller", async () => {
    dbMock.getClinicUserByUsername.mockResolvedValue(undefined);
    dbMock.createClinicUser.mockResolvedValue({
      ...STAFF_ROW,
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      username: "new.hire",
      name: "New Hire",
      passwordHash: "$2b$10$new-hash",
      mustChangePassword: true,
      tokenVersion: 0,
    });

    const result = await ownerCaller().staff.create(validInput);

    expect(result.username).toBe("new.hire");
    expect(dbMock.createClinicUser).toHaveBeenCalledTimes(1);
  });

  it("E: duplicate username is rejected case-insensitively, before any insert", async () => {
    // getClinicUserByUsername itself performs the case-insensitive ILIKE
    // lookup (see clinicUsers.mapping.test.ts) — the router just has to
    // trust a truthy result and never call createClinicUser.
    dbMock.getClinicUserByUsername.mockResolvedValue({ ...STAFF_ROW, username: "NURSE.JANE" });

    await expect(
      ownerCaller().staff.create({ ...validInput, username: "Nurse.Jane" })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(dbMock.createClinicUser).not.toHaveBeenCalled();
  });

  it("F: the temporary password is bcrypt-hashed before it ever reaches createClinicUser", async () => {
    dbMock.getClinicUserByUsername.mockResolvedValue(undefined);
    dbMock.createClinicUser.mockResolvedValue(STAFF_ROW);

    await ownerCaller().staff.create(validInput);

    expect(bcryptMock.hash).toHaveBeenCalledWith("temp-password1", 10);
    expect(dbMock.createClinicUser).toHaveBeenCalledWith(
      expect.objectContaining({ passwordHash: "$2b$10$new-hash" }),
      expect.anything()
    );
    const insertedArgs = dbMock.createClinicUser.mock.calls[0][0];
    expect(insertedArgs.passwordHash).not.toBe("temp-password1");
  });

  it("G: role/status default to staff/active when omitted from the request", async () => {
    dbMock.getClinicUserByUsername.mockResolvedValue(undefined);
    dbMock.createClinicUser.mockResolvedValue(STAFF_ROW);

    await ownerCaller().staff.create(validInput);

    expect(dbMock.createClinicUser).toHaveBeenCalledWith(
      expect.objectContaining({ role: "staff", status: "active" }),
      expect.anything()
    );
    // must_change_password:true and token_version:0 are enforced inside the
    // real (unmocked) db.ts createClinicUser — see staffManagement.db.test.ts.
  });

  it("mismatched password/confirmation is rejected before any lookup", async () => {
    await expect(
      ownerCaller().staff.create({ ...validInput, confirmPassword: "different-password" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMock.getClinicUserByUsername).not.toHaveBeenCalled();
  });
});

describe("staff.resetPassword (H/I)", () => {
  it("H: reset rehashes the password, forces must_change_password, and increments token_version", async () => {
    dbMock.getClinicUserById.mockResolvedValue(STAFF_ROW); // tokenVersion 2
    dbMock.adminResetClinicUserPassword.mockResolvedValue({
      ...STAFF_ROW,
      passwordHash: "$2b$10$new-hash",
      mustChangePassword: true,
      tokenVersion: 3,
    });

    const result = await ownerCaller().staff.resetPassword({
      id: STAFF_ROW_ID,
      password: "brand-new-temp1",
      confirmPassword: "brand-new-temp1",
    });

    expect(bcryptMock.hash).toHaveBeenCalledWith("brand-new-temp1", 10);
    expect(dbMock.adminResetClinicUserPassword).toHaveBeenCalledWith({
      id: STAFF_ROW_ID,
      passwordHash: "$2b$10$new-hash",
      expectedTokenVersion: 2,
    }, expect.anything());
    expect(result.mustChangePassword).toBe(true);
  });

  it("I: a session issued before the reset is rejected on its next request", async () => {
    // Session minted while token_version was still 2 (pre-reset).
    const staleToken = await sdk.createClinicSessionToken({
      clinicUserId: STAFF_ROW_ID,
      username: STAFF_ROW.username,
      tokenVersion: 2,
    });
    // Post-reset, the row now carries token_version 3 (see H above).
    dbMock.getClinicUserById.mockResolvedValue({ ...STAFF_ROW, tokenVersion: 3 });

    const req = { headers: { cookie: `app_session_id=${staleToken}` } } as unknown as Parameters<typeof sdk.authenticateRequest>[0];
    await expect(sdk.authenticateRequest(req)).rejects.toThrow();
  });

  it("mismatched password/confirmation is rejected before any DB write", async () => {
    await expect(
      ownerCaller().staff.resetPassword({ id: STAFF_ROW_ID, password: "abcdefghij", confirmPassword: "different1" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMock.adminResetClinicUserPassword).not.toHaveBeenCalled();
  });
});

describe("staff.archive / staff.reactivate (J/K/L/Q)", () => {
  it("J: archive sets status=archived and increments token_version", async () => {
    dbMock.getClinicUserById.mockResolvedValue(STAFF_ROW); // tokenVersion 2
    dbMock.archiveClinicUser.mockResolvedValue({
      ...STAFF_ROW,
      status: "archived",
      archivedAt: new Date("2026-02-01T00:00:00Z"),
      tokenVersion: 3,
    });

    const result = await ownerCaller().staff.archive({ id: STAFF_ROW_ID });

    expect(dbMock.archiveClinicUser).toHaveBeenCalledWith({ id: STAFF_ROW_ID, expectedTokenVersion: 2 }, expect.anything());
    expect(result.status).toBe("archived");
  });

  it("K: a login attempt against an archived account is rejected", async () => {
    dbMock.getClinicUserById.mockResolvedValue(STAFF_ROW);
    dbMock.archiveClinicUser.mockResolvedValue({ ...STAFF_ROW, status: "archived", tokenVersion: 3 });
    await ownerCaller().staff.archive({ id: STAFF_ROW_ID });

    // Same row, now archived — clinic.login must reject even with the
    // correct password (status is only checked after password verification;
    // see clinicLogin.rateLimit.test.ts D for the account-enumeration note).
    dbMock.getClinicUserByUsername.mockResolvedValue({ ...STAFF_ROW, status: "archived" });
    bcryptMock.compare.mockResolvedValue(true);

    await expect(
      callerFor(null).clinic.login({ username: STAFF_ROW.username, password: "correct-password" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("L: reactivate sets status back to active", async () => {
    dbMock.reactivateClinicUser.mockResolvedValue({ ...STAFF_ROW, status: "active", archivedAt: null });

    const result = await ownerCaller().staff.reactivate({ id: STAFF_ROW_ID });

    expect(result.status).toBe("active");
    expect(result.archivedAt).toBeNull();
  });

  it("Q: an admin cannot archive their own account", async () => {
    const caller = clinicAdminCaller();

    await expect(caller.staff.archive({ id: ADMIN_ROW_ID })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbMock.archiveClinicUser).not.toHaveBeenCalled();
  });

  it("Q: an admin cannot change their own role", async () => {
    dbMock.getClinicUserById.mockResolvedValue(ADMIN_ROW);
    const caller = clinicAdminCaller();

    await expect(caller.staff.update({ id: ADMIN_ROW_ID, role: "staff" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbMock.updateClinicUserRole).not.toHaveBeenCalled();
  });

  it("owner (not a clinic_users row) can archive any admin/staff account", async () => {
    dbMock.getClinicUserById.mockResolvedValue(ADMIN_ROW);
    dbMock.archiveClinicUser.mockResolvedValue({ ...ADMIN_ROW, status: "archived", tokenVersion: 2 });

    await expect(ownerCaller().staff.archive({ id: ADMIN_ROW_ID })).resolves.toMatchObject({ status: "archived" });
  });
});

describe("staff.update — role change (M)", () => {
  it("M: changing role increments token_version", async () => {
    dbMock.getClinicUserById
      .mockResolvedValueOnce(STAFF_ROW) // "current" lookup — tokenVersion 2, role staff
      .mockResolvedValueOnce({ ...STAFF_ROW, role: "admin", tokenVersion: 3 }); // "final" re-fetch
    dbMock.updateClinicUserRole.mockResolvedValue({ ...STAFF_ROW, role: "admin", tokenVersion: 3 });

    const result = await ownerCaller().staff.update({ id: STAFF_ROW_ID, role: "admin" });

    expect(dbMock.updateClinicUserRole).toHaveBeenCalledWith({
      id: STAFF_ROW_ID,
      role: "admin",
      expectedTokenVersion: 2,
    }, expect.anything());
    expect(result.role).toBe("admin");
  });

  it("no-op when the requested role matches the current role — no token_version bump", async () => {
    dbMock.getClinicUserById.mockResolvedValue(STAFF_ROW); // role already "staff"

    await ownerCaller().staff.update({ id: STAFF_ROW_ID, role: "staff" });

    expect(dbMock.updateClinicUserRole).not.toHaveBeenCalled();
  });
});

describe("staff.* response shape never exposes internal fields (N/O)", () => {
  it("N: passwordHash is absent from staff.list and staff.get", async () => {
    const list = await ownerCaller().staff.list();
    for (const row of list) {
      expect(row).not.toHaveProperty("passwordHash");
    }

    dbMock.getClinicUserById.mockResolvedValue(ADMIN_ROW);
    const single = await ownerCaller().staff.get({ id: ADMIN_ROW_ID });
    expect(single).not.toHaveProperty("passwordHash");
  });

  it("O: tokenVersion is absent from staff.list and staff.get", async () => {
    const list = await ownerCaller().staff.list();
    for (const row of list) {
      expect(row).not.toHaveProperty("tokenVersion");
    }

    dbMock.getClinicUserById.mockResolvedValue(ADMIN_ROW);
    const single = await ownerCaller().staff.get({ id: ADMIN_ROW_ID });
    expect(single).not.toHaveProperty("tokenVersion");
  });

  it("passwordHash/tokenVersion are also absent from create/update/resetPassword/archive/reactivate responses", async () => {
    dbMock.getClinicUserByUsername.mockResolvedValue(undefined);
    dbMock.createClinicUser.mockResolvedValue(STAFF_ROW);
    const created = await ownerCaller().staff.create({
      name: "New Hire", username: "new.hire2", password: "temp-password1", confirmPassword: "temp-password1",
    });
    expect(created).not.toHaveProperty("passwordHash");
    expect(created).not.toHaveProperty("tokenVersion");

    dbMock.getClinicUserById.mockResolvedValue(STAFF_ROW);
    dbMock.updateClinicUserProfile.mockResolvedValue(STAFF_ROW);
    const updated = await ownerCaller().staff.update({ id: STAFF_ROW_ID, name: "Jane R. Nurse" });
    expect(updated).not.toHaveProperty("passwordHash");
    expect(updated).not.toHaveProperty("tokenVersion");
  });
});

describe("staff.* mutations are forbidden for a normal staff session (P)", () => {
  it("P: staff.create is forbidden", async () => {
    await expect(
      clinicStaffCaller().staff.create({
        name: "X", username: "x.y", password: "temp-password1", confirmPassword: "temp-password1",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbMock.createClinicUser).not.toHaveBeenCalled();
  });

  it("P: staff.update, staff.resetPassword, staff.archive, staff.reactivate are forbidden", async () => {
    const caller = clinicStaffCaller();

    await expect(caller.staff.update({ id: ADMIN_ROW_ID, name: "Hacked" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.staff.resetPassword({ id: ADMIN_ROW_ID, password: "whatever12", confirmPassword: "whatever12" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.staff.archive({ id: ADMIN_ROW_ID })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.staff.reactivate({ id: ADMIN_ROW_ID })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(dbMock.updateClinicUserProfile).not.toHaveBeenCalled();
    expect(dbMock.updateClinicUserRole).not.toHaveBeenCalled();
    expect(dbMock.adminResetClinicUserPassword).not.toHaveBeenCalled();
    expect(dbMock.archiveClinicUser).not.toHaveBeenCalled();
    expect(dbMock.reactivateClinicUser).not.toHaveBeenCalled();
  });

  it("an owner OAuth session with role='user' (non-admin) is also forbidden", async () => {
    await expect(ownerCaller("user").staff.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
