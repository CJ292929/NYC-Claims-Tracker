/**
 * server/superAdminClaimsAccess.test.ts — P4-P23
 *
 * Router-level (real appRouter, mocked ./db) coverage for:
 *   - every claims.* procedure — enumerated from the router itself, so a
 *     procedure added later is covered automatically — is Super Admin only;
 *   - shared patient/visit/history/activity-log responses omit Claims
 *     fields for clinic admins and staff, and keep them for the Super Admin;
 *   - Claims-financial writes through shared endpoints are rejected;
 *   - visits.updateSessionFields validation, partial updates, and gating.
 *
 * These are MOCKED-DB tests (the db module is replaced). Real Postgres
 * transaction/audit behavior is covered separately in
 * server/sessionWorkflowFields.pg.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser, ClinicStaffInfo } from "./_core/sdk";

const { dbMock } = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    dbMock: {
      getAllPatients: fn(),
      getPatientById: fn(),
      updatePatient: fn(),
      getVisitsByPatientId: fn(),
      getVisitRecordById: fn(),
      createVisitRecord: fn(),
      updateVisitRecord: fn(),
      listHistoryForEntity: fn(),
      listActivityLog: fn(),
      getClaimsByPatientAndPeriod: fn(),
      createClaimRecord: fn(),
      updateClaimRecord: fn(),
      deleteClaimRecordWithAudit: fn(),
      upsertClaimRecord: fn(),
      findCms1500EnrichmentCandidates: fn(),
      patientHasAnyClaimRecords: fn(),
      applyCms1500Enrichment: fn(),
      classifyClaimFollowUp: fn(),
      sortByFollowUpUrgency: fn(),
      aggregateClaimStatusCounts: fn(),
      InsurerDeletedError: class extends Error {},
      ClaimRecordNotFoundError: class extends Error {},
      ClaimRecordPatientMismatchError: class extends Error {},
      ClaimLineIdentityAmbiguousError: class extends Error {},
    },
  };
});

vi.mock("./db", () => dbMock);

// claims.markResolved / getFollowUpClaims / getStatusCounts / update import
// the supabase client directly — fail loudly if one is ever reached.
const supabaseFrom = vi.fn(() => {
  throw new Error("supabase must not be reached by a denied caller");
});
vi.mock("./supabase", () => ({ supabase: { from: supabaseFrom } }));

import { appRouter } from "./routers";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const VISIT_ID = "22222222-2222-4222-8222-222222222222";

function callerFor(user: AuthenticatedUser | null) {
  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

function baseUser(overrides: Partial<AuthenticatedUser>): AuthenticatedUser {
  return {
    id: "u-1",
    openId: "open-id",
    name: "User",
    email: null,
    loginMethod: "password",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...overrides,
  } as AuthenticatedUser;
}

function clinicUser(role: ClinicStaffInfo["role"], extra: Partial<ClinicStaffInfo> = {}): AuthenticatedUser {
  return baseUser({
    openId: `clinic_${role}`,
    clinicUser: {
      clinicUserId: `clinic-${role}-1`,
      username: `${role}.user`,
      name: `Clinic ${role}`,
      email: null,
      department: null,
      role,
      mustChangePassword: false,
      ...extra,
    },
  });
}

/** Synthetic identities — no real account data. */
const SUPER_ADMIN = baseUser({ id: "owner-1", openId: "owner-open-id", name: "Owner", loginMethod: "google", role: "admin" });
const CLINIC_ADMIN = clinicUser("admin");
const CLINIC_STAFF = clinicUser("staff");
// An owner-OAuth-style session WITHOUT the admin role is not the owner.
const NON_ADMIN_OAUTH = baseUser({ id: "oauth-2", openId: "someone-else", role: "user" });

const CLAIM_PROCEDURES = Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures)
  .filter(path => path.startsWith("claims."))
  .map(path => path.slice("claims.".length));

async function callClaims(user: AuthenticatedUser | null, name: string, input: unknown) {
  const claims = callerFor(user).claims as unknown as Record<string, (i: unknown) => Promise<unknown>>;
  return claims[name](input);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("claims.* is Super Admin only", () => {
  it("covers the full claims router (sanity: nothing silently skipped)", () => {
    expect(CLAIM_PROCEDURES).toEqual(expect.arrayContaining([
      "getByPatientAndPeriod", "create", "update", "delete", "upsert", "historyForClaim",
      "cms1500EnrichmentPreview", "cms1500EnrichmentCommit", "bulkImportFromEOB",
      "markResolved", "getFollowUpClaims", "getStatusCounts",
    ]));
  });

  for (const [label, user, code] of [
    ["clinic admin", CLINIC_ADMIN, "FORBIDDEN"],
    ["clinic staff", CLINIC_STAFF, "FORBIDDEN"],
    ["non-admin OAuth session", NON_ADMIN_OAUTH, "FORBIDDEN"],
    ["anonymous", null, "UNAUTHORIZED"],
  ] as const) {
    it(`denies ${label} on every claims procedure, before input parsing or any data access`, async () => {
      for (const name of CLAIM_PROCEDURES) {
        await expect(callClaims(user, name, {}), `claims.${name}`).rejects.toMatchObject({ code });
      }
      for (const mock of Object.values(dbMock)) {
        if (typeof mock === "function" && "mock" in mock) expect(mock).not.toHaveBeenCalled();
      }
      expect(supabaseFrom).not.toHaveBeenCalled();
    });
  }

  it("denial message reveals nothing about claim data", async () => {
    await expect(callClaims(CLINIC_ADMIN, "getByPatientAndPeriod", { patientId: PATIENT_ID, authPeriod: 1 }))
      .rejects.toThrow("Claims access is restricted to the Super Admin (10004)");
  });

  it("lets the Super Admin through the gate (reaches input validation / handler)", async () => {
    for (const name of CLAIM_PROCEDURES) {
      // {} is invalid for most inputs: a BAD_REQUEST proves the auth gate
      // passed; the handful of all-optional inputs reach the handler.
      const outcome = await callClaims(SUPER_ADMIN, name, {}).then(
        () => "ok",
        (e: { code?: string }) => e.code ?? "error",
      );
      expect(outcome, `claims.${name}`).not.toBe("FORBIDDEN");
      expect(outcome, `claims.${name}`).not.toBe("UNAUTHORIZED");
    }
  });

  it("Super Admin can read claims rows", async () => {
    dbMock.getClaimsByPatientAndPeriod.mockResolvedValue([{ id: "c1" }]);
    await expect(callClaims(SUPER_ADMIN, "getByPatientAndPeriod", { patientId: PATIENT_ID, authPeriod: 1 }))
      .resolves.toEqual([{ id: "c1" }]);
  });

  it("a clinic session forced to change its password is still denied", async () => {
    const forced = clinicUser("admin", { mustChangePassword: true });
    await expect(callClaims(forced, "getStatusCounts", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("auth.me capability", () => {
  it("is true only for the owner identity", async () => {
    await expect(callerFor(SUPER_ADMIN).auth.me()).resolves.toMatchObject({ isSuperAdmin: true });
    await expect(callerFor(CLINIC_ADMIN).auth.me()).resolves.toMatchObject({ isSuperAdmin: false });
    await expect(callerFor(CLINIC_STAFF).auth.me()).resolves.toMatchObject({ isSuperAdmin: false });
    await expect(callerFor(NON_ADMIN_OAUTH).auth.me()).resolves.toMatchObject({ isSuperAdmin: false });
  });

  it("a clinic admin whose bridged users row somehow says role=admin is still not Super Admin", async () => {
    const spoofed = { ...CLINIC_ADMIN, role: "admin" } as AuthenticatedUser;
    await expect(callerFor(spoofed).auth.me()).resolves.toMatchObject({ isSuperAdmin: false });
    await expect(callClaims(spoofed, "getStatusCounts", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

const PATIENT = {
  id: PATIENT_ID, name: "Synthetic Patient", insurance: "Test Ins", authDate: null, authValidUntil: null,
  isActive: true, dischargeDate: null, dischargeReason: null, claimsStatus: "denied",
  createdAt: new Date(), updatedAt: new Date(),
};
const VISIT = {
  id: VISIT_ID, patientId: PATIENT_ID, sessionsAuthorized: 10, sessionsRemaining: 9, sessionNumber: 1,
  authPeriod: 1, dateOfService: null, newAuth: null, dateAshSubmitted: null, authStatus: "none",
  insuranceCompany: null, totalInsuranceReimbursement: 120.5, totalPatientDue: 10, totalPatientPaid: 5,
  assignmentOfBenefits: null, submissionStatus: null, remarks: null,
  createdAt: new Date(), updatedAt: new Date(),
};

describe("shared responses omit Claims fields for Admin/Staff", () => {
  for (const [label, user] of [["clinic admin", CLINIC_ADMIN], ["clinic staff", CLINIC_STAFF]] as const) {
    it(`${label}: patients.list / patients.get omit claimsStatus`, async () => {
      dbMock.getAllPatients.mockResolvedValue([PATIENT]);
      dbMock.getPatientById.mockResolvedValue(PATIENT);
      const [listed] = await callerFor(user).patients.list();
      expect(listed).not.toHaveProperty("claimsStatus");
      expect(listed).toMatchObject({ id: PATIENT_ID, name: "Synthetic Patient" });
      expect(await callerFor(user).patients.get({ id: PATIENT_ID })).not.toHaveProperty("claimsStatus");
    });

    it(`${label}: visits.listByPatient omits financial totals, keeps session fields`, async () => {
      dbMock.getVisitsByPatientId.mockResolvedValue([VISIT]);
      const [visit] = await callerFor(user).visits.listByPatient({ patientId: PATIENT_ID });
      for (const key of ["totalInsuranceReimbursement", "totalPatientDue", "totalPatientPaid"]) {
        expect(visit).not.toHaveProperty(key);
      }
      expect(visit).toMatchObject({ sessionsAuthorized: 10, assignmentOfBenefits: null, submissionStatus: null, remarks: null });
    });

    it(`${label}: cannot write session financial totals or claims status via shared endpoints`, async () => {
      await expect(callerFor(user).visits.update({ id: VISIT_ID, totalPatientPaid: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(callerFor(user).visits.create({ patientId: PATIENT_ID, totalPatientDue: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(callerFor(user).patients.update({ id: PATIENT_ID, claimsStatus: "approved" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(dbMock.updateVisitRecord).not.toHaveBeenCalled();
      expect(dbMock.createVisitRecord).not.toHaveBeenCalled();
      expect(dbMock.updatePatient).not.toHaveBeenCalled();
    });

    it(`${label}: still edits nonfinancial authorization fields normally`, async () => {
      dbMock.getPatientById.mockResolvedValue(PATIENT);
      await callerFor(user).visits.update({ id: VISIT_ID, sessionsRemaining: 3, authStatus: "pending" });
      expect(dbMock.updateVisitRecord).toHaveBeenCalledWith(VISIT_ID, { sessionsRemaining: 3, authStatus: "pending" }, expect.anything());
      await callerFor(user).patients.update({ id: PATIENT_ID, name: "Renamed" });
      expect(dbMock.updatePatient).toHaveBeenCalledWith(PATIENT_ID, { name: "Renamed" }, expect.anything());
    });
  }

  it("Super Admin keeps every field and may still write financial totals", async () => {
    dbMock.getAllPatients.mockResolvedValue([PATIENT]);
    dbMock.getVisitsByPatientId.mockResolvedValue([VISIT]);
    expect((await callerFor(SUPER_ADMIN).patients.list())[0]).toMatchObject({ claimsStatus: "denied" });
    expect((await callerFor(SUPER_ADMIN).visits.listByPatient({ patientId: PATIENT_ID }))[0])
      .toMatchObject({ totalInsuranceReimbursement: 120.5, totalPatientDue: 10, totalPatientPaid: 5 });
    await callerFor(SUPER_ADMIN).visits.update({ id: VISIT_ID, totalPatientPaid: 7 });
    expect(dbMock.updateVisitRecord).toHaveBeenCalledWith(VISIT_ID, { totalPatientPaid: 7 }, expect.anything());
  });
});

describe("history and Activity Log redaction", () => {
  const row = (over: Record<string, unknown>) => ({
    id: Math.random().toString(36), entityType: "visit_record", entityId: VISIT_ID, patientId: PATIENT_ID,
    actorId: null, actorType: "owner", actorDisplay: "Owner", action: "VISIT_RECORD_UPDATE",
    beforeData: null, afterData: null, importBatchId: null, createdAt: new Date(), ...over,
  });

  it("visit history: financial-only edits disappear, mixed edits lose only the financial keys", async () => {
    dbMock.listHistoryForEntity.mockResolvedValue([
      row({ beforeData: { total_patient_paid: 1 }, afterData: { total_patient_paid: 2 } }),
      row({ beforeData: { sessions_remaining: 4, total_patient_due: 3 }, afterData: { sessions_remaining: 3, total_patient_due: 9 } }),
      row({ action: "SESSION_FIELDS_UPDATE", beforeData: { remarks: null }, afterData: { remarks: "Called payer" } }),
    ]);
    const rows = await callerFor(CLINIC_STAFF).visits.historyForPatient({ patientId: PATIENT_ID });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ beforeData: { sessions_remaining: 4 }, afterData: { sessions_remaining: 3 } });
    expect(rows[1]).toMatchObject({ afterData: { remarks: "Called payer" } });
    expect(JSON.stringify(rows)).not.toMatch(/total_patient/);
  });

  it("patient history strips claims_status", async () => {
    dbMock.listHistoryForEntity.mockResolvedValue([
      row({ entityType: "patient", action: "PATIENT_UPDATE", beforeData: { name: "A", claims_status: "denied" }, afterData: { name: "B", claims_status: "approved" } }),
    ]);
    const rows = await callerFor(CLINIC_ADMIN).patients.history({ id: PATIENT_ID });
    expect(JSON.stringify(rows)).not.toMatch(/claims_status/);
    expect(rows[0]).toMatchObject({ beforeData: { name: "A" }, afterData: { name: "B" } });
  });

  it("insurer history drops the retained claims count only", async () => {
    dbMock.listHistoryForEntity.mockResolvedValue([
      row({ entityType: "insurer_catalog", action: "INSURER_PERMANENT_DELETE", beforeData: { name: "X", retained_references: { patients: 1, visits: 2, claims: 3 } } }),
    ]);
    const rows = await callerFor(CLINIC_ADMIN).insurance.history({ id: VISIT_ID });
    expect(rows[0].beforeData).toEqual({ name: "X", retained_references: { patients: 1, visits: 2 } });
  });

  it("activity log: clinic admin gets claims excluded in the query and cannot filter to claims", async () => {
    dbMock.listActivityLog.mockResolvedValue({ rows: [row({ entityType: "claim_record", action: "CLAIM_RECORD_UPDATE" })], total: 1 });
    const result = await callerFor(CLINIC_ADMIN).activityLog.list({});
    expect(dbMock.listActivityLog).toHaveBeenCalledWith(expect.objectContaining({ excludeClaims: true }));
    expect(result.rows).toEqual([]); // defense in depth even if the query let one through
    await expect(callerFor(CLINIC_ADMIN).activityLog.list({ entityType: "claim_record" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("activity log: Super Admin sees claims", async () => {
    const claimRow = row({ entityType: "claim_record", action: "CLAIM_RECORD_UPDATE" });
    dbMock.listActivityLog.mockResolvedValue({ rows: [claimRow], total: 1 });
    const result = await callerFor(SUPER_ADMIN).activityLog.list({ entityType: "claim_record" });
    expect(dbMock.listActivityLog).toHaveBeenCalledWith(expect.objectContaining({ excludeClaims: false }));
    expect(result.rows).toEqual([claimRow]);
  });
});

describe("visits.updateSessionFields", () => {
  const saved = { ...VISIT, assignmentOfBenefits: "yes", submissionStatus: "hold", remarks: "Line 1\nLine 2" };

  for (const [label, user] of [["clinic staff", CLINIC_STAFF], ["clinic admin", CLINIC_ADMIN], ["Super Admin", SUPER_ADMIN]] as const) {
    it(`${label} can save, and only the provided field is sent`, async () => {
      dbMock.getVisitRecordById.mockResolvedValue(saved);
      const result = await callerFor(user).visits.updateSessionFields({ id: VISIT_ID, patientId: PATIENT_ID, submissionStatus: "hold" });
      expect(dbMock.updateVisitRecord).toHaveBeenCalledWith(
        VISIT_ID,
        { submissionStatus: "hold" },
        expect.objectContaining({ actorId: expect.any(String) }),
        { action: "SESSION_FIELDS_UPDATE", patientId: PATIENT_ID },
      );
      expect(result).toEqual({ id: VISIT_ID, assignmentOfBenefits: "yes", submissionStatus: "hold", remarks: "Line 1\nLine 2" });
      // response never carries financial fields
      expect(result).not.toHaveProperty("totalPatientPaid");
    });
  }

  it("the actor comes from the verified session, never the input", async () => {
    dbMock.getVisitRecordById.mockResolvedValue(saved);
    await callerFor(CLINIC_STAFF).visits.updateSessionFields({
      id: VISIT_ID, patientId: PATIENT_ID, remarks: "x", ...({ actorId: "spoofed" } as object),
    });
    expect(dbMock.updateVisitRecord.mock.calls[0][2]).toEqual({
      actorId: "clinic-staff-1", actorType: "clinic_user", actorDisplay: "Clinic staff",
    });
  });

  it("supports explicit clears (null) and turns whitespace-only remarks into a clear", async () => {
    dbMock.getVisitRecordById.mockResolvedValue(VISIT);
    await callerFor(CLINIC_STAFF).visits.updateSessionFields({ id: VISIT_ID, patientId: PATIENT_ID, assignmentOfBenefits: null, remarks: "   " });
    expect(dbMock.updateVisitRecord.mock.calls[0][1]).toEqual({ assignmentOfBenefits: null, remarks: null });
  });

  it("rejects invalid dropdown values, over-long remarks, and empty updates", async () => {
    const c = callerFor(CLINIC_STAFF);
    const bad = [
      { assignmentOfBenefits: "maybe" },
      { assignmentOfBenefits: "YES" },
      { submissionStatus: "filed" },
      { remarks: "x".repeat(2001) },
      {},
    ];
    for (const fields of bad) {
      await expect(c.visits.updateSessionFields({ id: VISIT_ID, patientId: PATIENT_ID, ...(fields as object) }))
        .rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(dbMock.updateVisitRecord).not.toHaveBeenCalled();
  });

  it("accepts remarks at exactly the limit", async () => {
    dbMock.getVisitRecordById.mockResolvedValue(VISIT);
    await callerFor(CLINIC_STAFF).visits.updateSessionFields({ id: VISIT_ID, patientId: PATIENT_ID, remarks: "x".repeat(2000) });
    expect(dbMock.updateVisitRecord).toHaveBeenCalledTimes(1);
  });

  it("denies anonymous and forced-password-change sessions", async () => {
    await expect(callerFor(null).visits.updateSessionFields({ id: VISIT_ID, patientId: PATIENT_ID, remarks: "x" }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(callerFor(clinicUser("staff", { mustChangePassword: true })).visits.updateSessionFields({ id: VISIT_ID, patientId: PATIENT_ID, remarks: "x" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbMock.updateVisitRecord).not.toHaveBeenCalled();
  });

  it("maps RPC errors (not found / wrong patient / CHECK violation) and never reports success", async () => {
    for (const [pgCode, trpcCode] of [["P0030", "NOT_FOUND"], ["P0031", "BAD_REQUEST"], ["23514", "BAD_REQUEST"]] as const) {
      dbMock.updateVisitRecord.mockRejectedValueOnce(Object.assign(new Error("rpc"), { code: pgCode }));
      await expect(callerFor(CLINIC_STAFF).visits.updateSessionFields({ id: VISIT_ID, patientId: PATIENT_ID, remarks: "x" }))
        .rejects.toMatchObject({ code: trpcCode });
    }
    dbMock.updateVisitRecord.mockRejectedValueOnce(new Error("audit insert failed"));
    await expect(callerFor(CLINIC_STAFF).visits.updateSessionFields({ id: VISIT_ID, patientId: PATIENT_ID, remarks: "x" }))
      .rejects.toThrow();
    expect(dbMock.getVisitRecordById).not.toHaveBeenCalled();
  });
});
