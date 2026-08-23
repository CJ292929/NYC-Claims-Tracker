/**
 * server/clinicPasswordChange.test.ts
 * S2: clinic.changePassword — narrowly scoped to the currently authenticated
 * clinic user (identity derived from session, never from client input).
 * Rehashes the password, clears must_change_password, and rotates
 * token_version so every previously issued session is invalidated, then
 * issues a fresh session carrying the new token_version.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClinicUser } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./_core/sdk";

const { bcryptMock, dbMock, createClinicSessionToken } = vi.hoisted(() => ({
  bcryptMock: { compare: vi.fn(), hash: vi.fn() },
  dbMock: {
    getClinicUserById: vi.fn(),
    changeClinicUserPassword: vi.fn(),
  },
  createClinicSessionToken: vi.fn(),
}));

vi.mock("bcryptjs", () => ({ default: bcryptMock, ...bcryptMock }));
vi.mock("./db", () => dbMock);
vi.mock("./_core/sdk", () => ({ sdk: { createClinicSessionToken } }));

import { appRouter } from "./routers";
import { __resetLoginRateLimitForTests } from "./_core/loginRateLimit";

const CLINIC_USER_ID = "22222222-2222-2222-2222-222222222222";

const CURRENT_ROW: ClinicUser = {
  id: CLINIC_USER_ID,
  username: "nurse.jane",
  passwordHash: "$2a$10$old-hash",
  name: "Jane Nurse",
  email: "jane@example.com",
  department: "PT",
  role: "staff",
  status: "active",
  mustChangePassword: true,
  tokenVersion: 3,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  lastLoginAt: null,
  archivedAt: null,
};

function makeClinicCaller(ip = "203.0.113.10") {
  const setCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];

  const user: AuthenticatedUser = {
    id: "33333333-3333-3333-3333-333333333333",
    openId: "clinic_nurse.jane",
    name: "nurse.jane",
    email: null,
    loginMethod: "password",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    clinicUser: {
      clinicUserId: CLINIC_USER_ID,
      username: "nurse.jane",
      name: "Jane Nurse",
      email: "jane@example.com",
      department: "PT",
      role: "staff",
      mustChangePassword: true,
    },
  };

  const ctx: TrpcContext = {
    user,
    req: {
      protocol: "https",
      headers: { "x-forwarded-for": ip },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as TrpcContext["req"],
    res: {
      cookie: (name: string, value: string, options: Record<string, unknown>) => {
        setCookies.push({ name, value, options });
      },
      clearCookie: () => {},
    } as unknown as TrpcContext["res"],
  };

  return { caller: appRouter.createCaller(ctx), setCookies };
}

function makeOwnerCaller() {
  const user: AuthenticatedUser = {
    id: "1",
    openId: "owner-id",
    name: "Owner",
    email: null,
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

beforeEach(() => {
  __resetLoginRateLimitForTests();
  vi.clearAllMocks();
  dbMock.getClinicUserById.mockResolvedValue(CURRENT_ROW);
  bcryptMock.hash.mockResolvedValue("$2a$10$new-hash");
  createClinicSessionToken.mockResolvedValue("fresh-session-token");
});

afterEach(() => {
  __resetLoginRateLimitForTests();
});

describe("clinic.changePassword", () => {
  it("O: wrong current password is rejected and nothing is written", async () => {
    bcryptMock.compare.mockResolvedValue(false);
    const { caller } = makeClinicCaller();

    await expect(
      caller.clinic.changePassword({ currentPassword: "wrong", newPassword: "brand-new-password" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "Current password is incorrect" });

    expect(dbMock.changeClinicUserPassword).not.toHaveBeenCalled();
    expect(createClinicSessionToken).not.toHaveBeenCalled();
  });

  it("Q: an identical old/new password is rejected before any write", async () => {
    bcryptMock.compare.mockResolvedValue(true);
    const { caller } = makeClinicCaller();

    await expect(
      caller.clinic.changePassword({ currentPassword: "same-password1", newPassword: "same-password1" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(dbMock.changeClinicUserPassword).not.toHaveBeenCalled();
  });

  it("rejects a new password shorter than the minimum length via zod, before touching the DB", async () => {
    const { caller } = makeClinicCaller();

    await expect(
      caller.clinic.changePassword({ currentPassword: "correct-current", newPassword: "short" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(dbMock.getClinicUserById).not.toHaveBeenCalled();
  });

  it("R/S/T: a valid change rehashes the password and rotates token_version in one update", async () => {
    bcryptMock.compare.mockResolvedValue(true);
    dbMock.changeClinicUserPassword.mockResolvedValue({
      ...CURRENT_ROW,
      passwordHash: "$2a$10$new-hash",
      mustChangePassword: false,
      tokenVersion: 4,
    });
    const { caller } = makeClinicCaller();

    const result = await caller.clinic.changePassword({
      currentPassword: "correct-current",
      newPassword: "brand-new-password",
    });

    expect(result).toEqual({ success: true });
    expect(bcryptMock.hash).toHaveBeenCalledWith("brand-new-password", 10);
    // must_change_password:false is set unconditionally by changeClinicUserPassword
    // (server/db.ts) as part of the same single-row UPDATE as the rehash + token bump.
    expect(dbMock.changeClinicUserPassword).toHaveBeenCalledWith({
      id: CLINIC_USER_ID,
      passwordHash: "$2a$10$new-hash",
      expectedTokenVersion: 3,
    });
  });

  it("U/V: issues a refreshed session carrying the new token_version, not the session's stale one", async () => {
    bcryptMock.compare.mockResolvedValue(true);
    dbMock.changeClinicUserPassword.mockResolvedValue({ ...CURRENT_ROW, tokenVersion: 4 });
    const { caller, setCookies } = makeClinicCaller();

    await caller.clinic.changePassword({ currentPassword: "correct-current", newPassword: "brand-new-password" });

    expect(createClinicSessionToken).toHaveBeenCalledWith({
      clinicUserId: CLINIC_USER_ID,
      username: "nurse.jane",
      tokenVersion: 4,
    });
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]?.value).toBe("fresh-session-token");
  });

  it("surfaces a conflict instead of silently overwriting when token_version already moved concurrently", async () => {
    bcryptMock.compare.mockResolvedValue(true);
    // The compare-and-swap UPDATE matched no row: someone else changed it first.
    dbMock.changeClinicUserPassword.mockResolvedValue(undefined);
    const { caller } = makeClinicCaller();

    await expect(
      caller.clinic.changePassword({ currentPassword: "correct-current", newPassword: "brand-new-password" })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(createClinicSessionToken).not.toHaveBeenCalled();
  });

  it("Y: an archived account is rejected even mid-session, before any password check", async () => {
    bcryptMock.compare.mockResolvedValue(true);
    dbMock.getClinicUserById.mockResolvedValue({ ...CURRENT_ROW, status: "archived" });
    const { caller } = makeClinicCaller();

    await expect(
      caller.clinic.changePassword({ currentPassword: "correct-current", newPassword: "brand-new-password" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(bcryptMock.compare).not.toHaveBeenCalled();
  });

  it("rejects an owner OAuth session outright — this mutation is clinic-staff-only", async () => {
    const ownerCaller = makeOwnerCaller();

    await expect(
      ownerCaller.clinic.changePassword({ currentPassword: "x", newPassword: "brand-new-password" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("never accepts a clinicUserId from the client — input schema has no such field", async () => {
    const { caller } = makeClinicCaller();
    bcryptMock.compare.mockResolvedValue(true);
    dbMock.changeClinicUserPassword.mockResolvedValue({ ...CURRENT_ROW, tokenVersion: 4 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (caller.clinic.changePassword as any)({
      currentPassword: "correct-current",
      newPassword: "brand-new-password",
      clinicUserId: "attacker-supplied-id",
    });

    expect(dbMock.changeClinicUserPassword).toHaveBeenCalledWith(
      expect.objectContaining({ id: CLINIC_USER_ID })
    );
  });
});
