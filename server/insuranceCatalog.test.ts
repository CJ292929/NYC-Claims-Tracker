/**
 * server/insuranceCatalog.test.ts
 * P4-P7: insurance.* router — the shared insurer catalog backing patient
 * forms, insurance filters, and the generic claims import path. Covers the
 * adminOrOwnerProcedure gate on create (owner/clinic-admin in, clinic staff
 * and unauthenticated callers out), read access for any authenticated
 * dashboard user, blank-name rejection, and case/whitespace duplicate
 * rejection (both the server's pre-check and the DB unique-index backstop).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser, ClinicStaffInfo } from "./_core/sdk";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    listInsurerCatalog: vi.fn(),
    getInsurerCatalogEntryByNormalizedName: vi.fn(),
    createInsurerCatalogEntry: vi.fn(),
  },
}));

vi.mock("./db", () => dbMock);
vi.mock("./_core/env", () => ({
  ENV: { appId: "test-app-id", cookieSecret: "test-only-session-signing-secret", oAuthServerUrl: "" },
}));

import { appRouter } from "./routers";
import { __resetLoginRateLimitForTests } from "./_core/loginRateLimit";

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

function clinicStaffInfo(overrides: Partial<ClinicStaffInfo>): ClinicStaffInfo {
  return {
    clinicUserId: "clinic-user-id",
    username: "jane",
    name: "Jane",
    email: null,
    department: null,
    role: "staff",
    mustChangePassword: false,
    ...overrides,
  };
}

function clinicAdminCaller() {
  const user: AuthenticatedUser = {
    id: "user-row-admin",
    openId: "clinic_admin",
    name: "admin",
    email: null,
    loginMethod: "password",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    clinicUser: clinicStaffInfo({ role: "admin" }),
  };
  return callerFor(user);
}

function clinicStaffCaller() {
  const user: AuthenticatedUser = {
    id: "user-row-staff",
    openId: "clinic_staff",
    name: "staff",
    email: null,
    loginMethod: "password",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    clinicUser: clinicStaffInfo({ role: "staff" }),
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

const CATALOG_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Aetna",
  aliases: [] as string[],
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

beforeEach(() => {
  __resetLoginRateLimitForTests();
  vi.clearAllMocks();
  dbMock.listInsurerCatalog.mockResolvedValue([CATALOG_ROW]);
  dbMock.getInsurerCatalogEntryByNormalizedName.mockResolvedValue(undefined);
});

afterEach(() => {
  __resetLoginRateLimitForTests();
});

describe("insurance.list — read access", () => {
  it("any authenticated dashboard user (owner, clinic admin, clinic staff) can list insurers", async () => {
    await expect(ownerCaller().insurance.list()).resolves.toEqual([CATALOG_ROW]);
    await expect(clinicAdminCaller().insurance.list()).resolves.toEqual([CATALOG_ROW]);
    await expect(clinicStaffCaller().insurance.list()).resolves.toEqual([CATALOG_ROW]);
  });

  it("unauthenticated caller is denied", async () => {
    await expect(callerFor(null).insurance.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("insurance.create — access control", () => {
  const validInput = { name: "Aegis One Inc." };

  it("owner admin can create an insurer", async () => {
    dbMock.createInsurerCatalogEntry.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Aegis One Inc.",
      aliases: [],
      createdAt: new Date(),
    });
    const result = await ownerCaller().insurance.create(validInput);
    expect(result.name).toBe("Aegis One Inc.");
    // normalized_name is DB-generated (not application-supplied) — see
    // db.ts createInsurerCatalogEntry — so only `name` is ever passed here.
    expect(dbMock.createInsurerCatalogEntry).toHaveBeenCalledWith({
      name: "Aegis One Inc.",
    });
  });

  it("clinic admin can create an insurer", async () => {
    dbMock.createInsurerCatalogEntry.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      name: "UMR",
      aliases: [],
      createdAt: new Date(),
    });
    await expect(clinicAdminCaller().insurance.create({ name: "UMR" })).resolves.toMatchObject({ name: "UMR" });
  });

  it("clinic staff (non-admin) is denied", async () => {
    await expect(clinicStaffCaller().insurance.create(validInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbMock.createInsurerCatalogEntry).not.toHaveBeenCalled();
  });

  it("unauthenticated caller is denied", async () => {
    await expect(callerFor(null).insurance.create(validInput)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(dbMock.createInsurerCatalogEntry).not.toHaveBeenCalled();
  });
});

describe("insurance.create — validation and duplicates", () => {
  it("rejects a blank name", async () => {
    await expect(ownerCaller().insurance.create({ name: "" })).rejects.toBeDefined();
    expect(dbMock.createInsurerCatalogEntry).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only name", async () => {
    await expect(ownerCaller().insurance.create({ name: "   " })).rejects.toBeDefined();
    expect(dbMock.createInsurerCatalogEntry).not.toHaveBeenCalled();
  });

  it("trims the name before persisting", async () => {
    dbMock.createInsurerCatalogEntry.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      name: "Hanover",
      aliases: [],
      createdAt: new Date(),
    });
    await ownerCaller().insurance.create({ name: "  Hanover  " });
    expect(dbMock.createInsurerCatalogEntry).toHaveBeenCalledWith({
      name: "Hanover",
    });
  });

  it("rejects a case/whitespace duplicate via the pre-check", async () => {
    dbMock.getInsurerCatalogEntryByNormalizedName.mockResolvedValue(CATALOG_ROW);
    await expect(ownerCaller().insurance.create({ name: "  AETNA  " })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dbMock.createInsurerCatalogEntry).not.toHaveBeenCalled();
  });

  it("rejects a duplicate caught only by the DB's unique-index backstop (race condition)", async () => {
    // Pre-check sees no existing row (simulating a concurrent insert that
    // landed between the check and this insert), but the DB insert itself
    // fails with a unique-violation.
    dbMock.getInsurerCatalogEntryByNormalizedName.mockResolvedValue(undefined);
    dbMock.createInsurerCatalogEntry.mockRejectedValue({ code: "23505", message: "duplicate key value" });
    await expect(ownerCaller().insurance.create({ name: "Aetna" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
