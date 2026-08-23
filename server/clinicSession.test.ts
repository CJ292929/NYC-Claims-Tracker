/**
 * server/clinicSession.test.ts
 * S2: clinic staff session enforcement. Every authenticated request
 * re-resolves clinic_users by id (sdk.authenticateClinicSession), so
 * archived status and stale token_version reject already-issued sessions,
 * not just block new logins. Owner OAuth sessions must never touch
 * clinic_users at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClinicUser, User } from "../drizzle/schema";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    getClinicUserById: vi.fn(),
    getUserByOpenId: vi.fn(),
    upsertUser: vi.fn(),
  },
}));

vi.mock("./db", () => dbMock);
// jose refuses a zero-length HMAC key, and JWT_SECRET is unset in this test
// environment (see .env / process env) — stub a fixed test secret so
// sign/verify round-trip like they would with a real ENV.cookieSecret.
vi.mock("./_core/env", () => ({
  ENV: { appId: "test-app-id", cookieSecret: "test-only-session-signing-secret", oAuthServerUrl: "" },
}));

import { sdk } from "./_core/sdk";

function makeReq(sessionToken: string) {
  return { headers: { cookie: `app_session_id=${sessionToken}` } } as any;
}

const FAKE_CLINIC_USER: ClinicUser = {
  id: "22222222-2222-2222-2222-222222222222",
  username: "nurse.jane",
  passwordHash: "irrelevant-to-session-resolution",
  name: "Jane Nurse",
  email: "jane@example.com",
  department: "PT",
  role: "staff",
  status: "active",
  mustChangePassword: false,
  tokenVersion: 3,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  lastLoginAt: new Date("2026-01-02T00:00:00Z"),
  archivedAt: null,
};

const FAKE_BRIDGED_USER: User = {
  id: "33333333-3333-3333-3333-333333333333",
  openId: "clinic_nurse.jane",
  name: "nurse.jane",
  email: null,
  loginMethod: "password",
  role: "user",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  lastSignedIn: new Date("2026-01-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.getUserByOpenId.mockResolvedValue(FAKE_BRIDGED_USER);
  dbMock.upsertUser.mockResolvedValue(undefined);
});

describe("clinic staff session enforcement", () => {
  it("H: matching token_version is accepted and attaches a safe clinic identity", async () => {
    dbMock.getClinicUserById.mockResolvedValue(FAKE_CLINIC_USER);
    const token = await sdk.createClinicSessionToken({
      clinicUserId: FAKE_CLINIC_USER.id,
      username: FAKE_CLINIC_USER.username,
      tokenVersion: FAKE_CLINIC_USER.tokenVersion,
    });

    const user = await sdk.authenticateRequest(makeReq(token));

    expect(user.clinicUser).toMatchObject({
      clinicUserId: FAKE_CLINIC_USER.id,
      username: "nurse.jane",
      role: "staff",
      mustChangePassword: false,
    });
    // The client-facing clinic identity never carries passwordHash or
    // token_version — see the S2 report's session architecture notes.
    expect(user.clinicUser).not.toHaveProperty("passwordHash");
    expect(user.clinicUser).not.toHaveProperty("tokenVersion");
  });

  it("I: stale token_version (session predates a password change) is rejected", async () => {
    dbMock.getClinicUserById.mockResolvedValue(FAKE_CLINIC_USER); // current version 3
    const token = await sdk.createClinicSessionToken({
      clinicUserId: FAKE_CLINIC_USER.id,
      username: FAKE_CLINIC_USER.username,
      tokenVersion: 2, // stale — one behind current
    });

    await expect(sdk.authenticateRequest(makeReq(token))).rejects.toThrow();
  });

  it("J: archived status rejects an otherwise-valid, previously-issued session", async () => {
    const token = await sdk.createClinicSessionToken({
      clinicUserId: FAKE_CLINIC_USER.id,
      username: FAKE_CLINIC_USER.username,
      tokenVersion: FAKE_CLINIC_USER.tokenVersion,
    });
    // Token was valid when issued; the account has since been archived.
    dbMock.getClinicUserById.mockResolvedValue({ ...FAKE_CLINIC_USER, status: "archived" });

    await expect(sdk.authenticateRequest(makeReq(token))).rejects.toThrow();
  });

  it("rejects a clinic session whose clinicUserId no longer resolves to any row", async () => {
    const token = await sdk.createClinicSessionToken({
      clinicUserId: FAKE_CLINIC_USER.id,
      username: FAKE_CLINIC_USER.username,
      tokenVersion: FAKE_CLINIC_USER.tokenVersion,
    });
    dbMock.getClinicUserById.mockResolvedValue(undefined);

    await expect(sdk.authenticateRequest(makeReq(token))).rejects.toThrow();
  });

  it("K: an owner OAuth session resolves without ever calling getClinicUserById", async () => {
    const token = await sdk.createSessionToken("owner-open-id-123", { name: "Owner" });

    const user = await sdk.authenticateRequest(makeReq(token));

    expect(dbMock.getClinicUserById).not.toHaveBeenCalled();
    expect(dbMock.getUserByOpenId).toHaveBeenCalledWith("owner-open-id-123");
    expect(user.clinicUser).toBeUndefined();
  });
});
