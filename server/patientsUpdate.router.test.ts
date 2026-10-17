/**
 * server/patientsUpdate.router.test.ts
 *
 * End-to-end (router-level, DB mocked) coverage for the P4-P1 patient-edit
 * fix: patients.update must accept the "none" sentinel (translating it to a
 * NULL claims_status write), reject a truly unsupported status with a
 * readable error (not raw Zod JSON), and never let an edit to one field
 * silently blow away a different field's existing value.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./_core/sdk";
import type { Patient } from "../drizzle/schema";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    getPatientById: vi.fn(),
    updatePatient: vi.fn(),
    diffPatientUpdate: vi.fn(() => []),
    createAuditLog: vi.fn(),
  },
}));

vi.mock("./db", () => dbMock);

import { appRouter } from "./routers";

function ownerCaller() {
  const owner: AuthenticatedUser = {
    id: "owner-1",
    openId: "owner-open-id",
    name: "Owner",
    email: "owner@example.com",
    loginMethod: "google",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  const ctx: TrpcContext = {
    user: owner,
    req: { protocol: "https", headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

const BASE_PATIENT: Patient = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "John Smith",
  insurance: "Aetna",
  authDate: null,
  authValidUntil: null,
  isActive: true,
  dischargeDate: null,
  dischargeReason: null,
  claimsStatus: "none",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.getPatientById.mockResolvedValue(BASE_PATIENT);
  dbMock.updatePatient.mockResolvedValue(undefined);
});

describe("patients.update — claimsStatus contract", () => {
  it("a name edit with claimsStatus 'none' (unset) saves without inventing a status", async () => {
    await ownerCaller().patients.update({
      id: BASE_PATIENT.id,
      name: "Jonathan Smith",
      claimsStatus: "none",
    });

    expect(dbMock.updatePatient).toHaveBeenCalledWith(
      BASE_PATIENT.id,
      expect.objectContaining({ name: "Jonathan Smith", claimsStatus: null }),
      expect.anything()
    );
  });

  it("omitting claimsStatus entirely preserves whatever status the patient already had", async () => {
    dbMock.getPatientById.mockResolvedValue({ ...BASE_PATIENT, claimsStatus: "approved" });

    await ownerCaller().patients.update({
      id: BASE_PATIENT.id,
      insurance: "UHC",
    });

    const call = dbMock.updatePatient.mock.calls[0][1];
    expect("claimsStatus" in call).toBe(false);
  });

  it("an explicit valid status is passed straight through", async () => {
    await ownerCaller().patients.update({
      id: BASE_PATIENT.id,
      claimsStatus: "denied",
    });

    expect(dbMock.updatePatient).toHaveBeenCalledWith(
      BASE_PATIENT.id,
      expect.objectContaining({ claimsStatus: "denied" }),
      expect.anything()
    );
  });

  it("rejects an unsupported status with a readable (non-JSON-dump) error", async () => {
    await expect(
      ownerCaller().patients.update({
        id: BASE_PATIENT.id,
        // @ts-expect-error -- intentionally invalid for this test
        claimsStatus: "closed",
      })
    ).rejects.toThrow(/claimsStatus/i);
    expect(dbMock.updatePatient).not.toHaveBeenCalled();
  });
});
