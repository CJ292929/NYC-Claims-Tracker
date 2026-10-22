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

const { dbMock } = vi.hoisted(() => {
  // Same messages as the real classes in server/db.ts — the router forwards
  // err.message to the client verbatim.
  class InsurerInUseError extends Error {
    constructor() {
      super("This insurance company is used by existing records and cannot be permanently deleted.");
    }
  }
  class InsurerCatalogEntryNotFoundError extends Error {}
  class InsurerDeletedError extends Error {
    constructor() {
      super("This insurance company was permanently deleted. Choose a different insurance company.");
    }
  }
  return {
    dbMock: {
      listInsurerCatalog: vi.fn(),
      getInsurerCatalogEntryByNormalizedName: vi.fn(),
      getInsurerCatalogEntryById: vi.fn(),
      createInsurerCatalogEntry: vi.fn(),
      deactivateInsurerCatalogEntry: vi.fn(),
      reactivateInsurerCatalogEntry: vi.fn(),
      permanentlyDeleteInsurerCatalogEntry: vi.fn(),
      createPatient: vi.fn(),
      updatePatient: vi.fn(),
      getPatientById: vi.fn(),
      InsurerInUseError,
      InsurerCatalogEntryNotFoundError,
      InsurerDeletedError,
    },
  };
});

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
  isActive: true,
  deactivatedAt: null as Date | null,
  reactivatedAt: null as Date | null,
};

const INACTIVE_CATALOG_ROW = {
  ...CATALOG_ROW,
  id: "55555555-5555-4555-8555-555555555555",
  name: "Old Insurer Co",
  isActive: false,
  deactivatedAt: new Date("2026-02-01T00:00:00Z"),
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
    }, expect.anything());
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
    }, expect.anything());
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

  it("re-adding a deliberately-deleted (inactive) name reactivates the existing row instead of inserting a duplicate", async () => {
    dbMock.getInsurerCatalogEntryByNormalizedName.mockResolvedValue(INACTIVE_CATALOG_ROW);
    dbMock.reactivateInsurerCatalogEntry.mockResolvedValue({ ...INACTIVE_CATALOG_ROW, isActive: true, reactivatedAt: new Date() });
    const result = await ownerCaller().insurance.create({ name: "old insurer co" });
    expect(dbMock.reactivateInsurerCatalogEntry).toHaveBeenCalledWith(INACTIVE_CATALOG_ROW.id, expect.anything());
    expect(dbMock.createInsurerCatalogEntry).not.toHaveBeenCalled();
    expect(result.isActive).toBe(true);
  });
});

describe("insurance.delete — soft delete (P4-P13)", () => {
  beforeEach(() => {
    dbMock.getInsurerCatalogEntryById.mockResolvedValue(CATALOG_ROW);
    dbMock.deactivateInsurerCatalogEntry.mockResolvedValue({ ...CATALOG_ROW, isActive: false, deactivatedAt: new Date() });
  });

  it("owner admin can deactivate an insurer", async () => {
    const result = await ownerCaller().insurance.delete({ id: CATALOG_ROW.id });
    expect(result.isActive).toBe(false);
    expect(dbMock.deactivateInsurerCatalogEntry).toHaveBeenCalledWith(CATALOG_ROW.id, expect.anything());
  });

  it("clinic admin can deactivate an insurer", async () => {
    await expect(clinicAdminCaller().insurance.delete({ id: CATALOG_ROW.id })).resolves.toMatchObject({ isActive: false });
  });

  it("clinic staff (non-admin) is denied", async () => {
    await expect(clinicStaffCaller().insurance.delete({ id: CATALOG_ROW.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbMock.deactivateInsurerCatalogEntry).not.toHaveBeenCalled();
  });

  it("unauthenticated caller is denied", async () => {
    await expect(callerFor(null).insurance.delete({ id: CATALOG_ROW.id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(dbMock.deactivateInsurerCatalogEntry).not.toHaveBeenCalled();
  });

  it("404s on an unknown id instead of writing", async () => {
    dbMock.getInsurerCatalogEntryById.mockResolvedValue(undefined);
    await expect(ownerCaller().insurance.delete({ id: CATALOG_ROW.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(dbMock.deactivateInsurerCatalogEntry).not.toHaveBeenCalled();
  });

  it("never touches patient/visit/claim data — only calls the catalog deactivate helper", async () => {
    await ownerCaller().insurance.delete({ id: CATALOG_ROW.id });
    expect(dbMock.deactivateInsurerCatalogEntry).toHaveBeenCalledTimes(1);
    expect(dbMock.createInsurerCatalogEntry).not.toHaveBeenCalled();
  });
});

describe("insurance.reactivate — deliberate restore (P4-P13)", () => {
  beforeEach(() => {
    dbMock.getInsurerCatalogEntryById.mockResolvedValue(INACTIVE_CATALOG_ROW);
    dbMock.reactivateInsurerCatalogEntry.mockResolvedValue({ ...INACTIVE_CATALOG_ROW, isActive: true, reactivatedAt: new Date() });
  });

  it("owner admin can reactivate an insurer", async () => {
    const result = await ownerCaller().insurance.reactivate({ id: INACTIVE_CATALOG_ROW.id });
    expect(result.isActive).toBe(true);
  });

  it("clinic staff (non-admin) is denied", async () => {
    await expect(clinicStaffCaller().insurance.reactivate({ id: INACTIVE_CATALOG_ROW.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbMock.reactivateInsurerCatalogEntry).not.toHaveBeenCalled();
  });

  it("unauthenticated caller is denied", async () => {
    await expect(callerFor(null).insurance.reactivate({ id: INACTIVE_CATALOG_ROW.id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("404s on an unknown id instead of writing", async () => {
    dbMock.getInsurerCatalogEntryById.mockResolvedValue(undefined);
    await expect(ownerCaller().insurance.reactivate({ id: INACTIVE_CATALOG_ROW.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(dbMock.reactivateInsurerCatalogEntry).not.toHaveBeenCalled();
  });
});

describe("insurance.permanentDelete — permanent delete (P4-P21)", () => {
  beforeEach(() => {
    dbMock.permanentlyDeleteInsurerCatalogEntry.mockResolvedValue(undefined);
  });

  it("owner admin can permanently delete an unused insurer, targeting the exact catalog id", async () => {
    await expect(ownerCaller().insurance.permanentDelete({ id: CATALOG_ROW.id }))
      .resolves.toEqual({ success: true, id: CATALOG_ROW.id });
    expect(dbMock.permanentlyDeleteInsurerCatalogEntry).toHaveBeenCalledWith(
      CATALOG_ROW.id,
      expect.objectContaining({ actorType: "owner" })
    );
  });

  it("clinic admin can permanently delete an unused insurer", async () => {
    await expect(clinicAdminCaller().insurance.permanentDelete({ id: CATALOG_ROW.id })).resolves.toMatchObject({ success: true });
    expect(dbMock.permanentlyDeleteInsurerCatalogEntry).toHaveBeenCalledWith(
      CATALOG_ROW.id,
      expect.objectContaining({ actorType: "clinic_user" })
    );
  });

  it("clinic staff (non-admin) is denied server-side", async () => {
    await expect(clinicStaffCaller().insurance.permanentDelete({ id: CATALOG_ROW.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbMock.permanentlyDeleteInsurerCatalogEntry).not.toHaveBeenCalled();
  });

  it("unauthenticated caller is denied", async () => {
    await expect(callerFor(null).insurance.permanentDelete({ id: CATALOG_ROW.id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(dbMock.permanentlyDeleteInsurerCatalogEntry).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid id (no fuzzy/name targeting)", async () => {
    await expect(ownerCaller().insurance.permanentDelete({ id: "Aetna" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMock.permanentlyDeleteInsurerCatalogEntry).not.toHaveBeenCalled();
  });

  it("a referenced insurer is refused with the readable in-use message", async () => {
    dbMock.permanentlyDeleteInsurerCatalogEntry.mockRejectedValue(new dbMock.InsurerInUseError());
    await expect(ownerCaller().insurance.permanentDelete({ id: CATALOG_ROW.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This insurance company is used by existing records and cannot be permanently deleted.",
    });
  });

  it("an already-deleted id is a readable NOT_FOUND", async () => {
    dbMock.permanentlyDeleteInsurerCatalogEntry.mockRejectedValue(new dbMock.InsurerCatalogEntryNotFoundError("x"));
    await expect(ownerCaller().insurance.permanentDelete({ id: CATALOG_ROW.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "This insurance company no longer exists. It may already have been deleted.",
    });
  });

  it("never falls back to the soft-delete path or touches patient data", async () => {
    await ownerCaller().insurance.permanentDelete({ id: CATALOG_ROW.id });
    expect(dbMock.deactivateInsurerCatalogEntry).not.toHaveBeenCalled();
    expect(dbMock.updatePatient).not.toHaveBeenCalled();
    expect(dbMock.createPatient).not.toHaveBeenCalled();
  });
});

describe("patients.create/update — assigning a permanently deleted insurer (P4-P21)", () => {
  it("create surfaces the deleted-insurer guard as a readable CONFLICT", async () => {
    dbMock.createPatient.mockRejectedValue(new dbMock.InsurerDeletedError());
    await expect(clinicStaffCaller().patients.create({ name: "Jane Doe", insurance: "Typo Insurer" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This insurance company was permanently deleted. Choose a different insurance company.",
    });
  });

  it("update surfaces the deleted-insurer guard as a readable CONFLICT", async () => {
    dbMock.getPatientById.mockResolvedValue({ id: CATALOG_ROW.id, name: "Jane Doe", insurance: "Aetna" });
    dbMock.updatePatient.mockRejectedValue(new dbMock.InsurerDeletedError());
    await expect(
      clinicStaffCaller().patients.update({ id: CATALOG_ROW.id, insurance: "Typo Insurer" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
