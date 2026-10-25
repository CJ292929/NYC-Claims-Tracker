/**
 * server/claimsDelete.router.test.ts
 * P4-P12: claims.delete — deleting one claim_records row.
 * Covers the adminOrOwnerProcedure gate (owner/clinic admins in, clinic
 * staff and unauthenticated out), server-side re-validation of the claim's
 * patient association, not-found/already-deleted handling, and that a
 * failed delete or failed audit write never reports success.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClinicUser } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser, ClinicStaffInfo } from "./_core/sdk";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    deleteClaimRecordWithAudit: vi.fn(),
    ClaimRecordNotFoundError: class ClaimRecordNotFoundError extends Error {
      constructor(id: string) {
        super(`Claim record ${id} not found`);
        this.name = "ClaimRecordNotFoundError";
      }
    },
    ClaimRecordPatientMismatchError: class ClaimRecordPatientMismatchError extends Error {
      constructor(id: string, expectedPatientId: string) {
        super(`Claim record ${id} does not belong to patient ${expectedPatientId}`);
        this.name = "ClaimRecordPatientMismatchError";
      }
    },
  },
}));

vi.mock("./db", () => dbMock);

import { appRouter } from "./routers";

const CLAIM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function callerFor(user: AuthenticatedUser | null) {
  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

function clinicStaffInfo(overrides: Partial<ClinicStaffInfo>): ClinicStaffInfo {
  return {
    clinicUserId: "clinic-user-1",
    username: "clinic.user",
    name: "Clinic User",
    email: "clinic@example.com",
    department: "PT",
    role: "staff",
    mustChangePassword: false,
    ...overrides,
  };
}

function ownerAdminCaller() {
  const user: AuthenticatedUser = {
    id: "owner-1",
    openId: "owner-open-id",
    name: "Owner",
    email: "owner@example.com",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return callerFor(user);
}

function clinicAdminCaller() {
  const user: AuthenticatedUser = {
    id: "user-row-admin",
    openId: "clinic_admin.user",
    name: "admin.user",
    email: null,
    loginMethod: "password",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    clinicUser: clinicStaffInfo({ clinicUserId: "clinic-admin-1", role: "admin" }),
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
    clinicUser: clinicStaffInfo({ clinicUserId: "clinic-staff-1", role: "staff" }),
  };
  return callerFor(user);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.deleteClaimRecordWithAudit.mockResolvedValue(undefined);
});

describe("claims.delete authorization", () => {
  it("owner admin can delete a claim", async () => {
    const result = await ownerAdminCaller().claims.delete({ id: CLAIM_ID, patientId: PATIENT_ID });
    expect(result).toEqual({ success: true });
    expect(dbMock.deleteClaimRecordWithAudit).toHaveBeenCalledWith({
      claimId: CLAIM_ID,
      patientId: PATIENT_ID,
      actorId: "owner-1",
      actorType: "owner",
      actorDisplay: "Owner",
    });
  });

  // P4-P25: Clinic Admins have Claims access again; Staff do not.
  it("clinic admin can delete a claim", async () => {
    const result = await clinicAdminCaller().claims.delete({ id: CLAIM_ID, patientId: PATIENT_ID });
    expect(result).toEqual({ success: true });
    expect(dbMock.deleteClaimRecordWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: CLAIM_ID, patientId: PATIENT_ID, actorType: "clinic_user" })
    );
  });

  it("denies clinic staff (non-admin)", async () => {
    await expect(
      clinicStaffCaller().claims.delete({ id: CLAIM_ID, patientId: PATIENT_ID })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbMock.deleteClaimRecordWithAudit).not.toHaveBeenCalled();
  });

  it("denies unauthenticated callers", async () => {
    await expect(
      callerFor(null).claims.delete({ id: CLAIM_ID, patientId: PATIENT_ID })
    ).rejects.toThrow();
    expect(dbMock.deleteClaimRecordWithAudit).not.toHaveBeenCalled();
  });
});

describe("claims.delete validation and failure handling", () => {
  it("rejects an incorrect patient association without reporting success", async () => {
    dbMock.deleteClaimRecordWithAudit.mockRejectedValue(
      new dbMock.ClaimRecordPatientMismatchError(CLAIM_ID, PATIENT_ID)
    );

    await expect(
      ownerAdminCaller().claims.delete({ id: CLAIM_ID, patientId: PATIENT_ID })
    ).rejects.toThrow(/does not belong/i);
  });

  it("reports a clear error for a missing/already-deleted claim, not a generic failure", async () => {
    dbMock.deleteClaimRecordWithAudit.mockRejectedValue(
      new dbMock.ClaimRecordNotFoundError(CLAIM_ID)
    );

    await expect(
      ownerAdminCaller().claims.delete({ id: CLAIM_ID, patientId: PATIENT_ID })
    ).rejects.toThrow(/not found|already been deleted/i);
  });

  it("does not report success when the underlying delete/audit write fails", async () => {
    dbMock.deleteClaimRecordWithAudit.mockRejectedValue(new Error("db unavailable"));

    await expect(
      ownerAdminCaller().claims.delete({ id: CLAIM_ID, patientId: PATIENT_ID })
    ).rejects.toThrow();
  });
});
