/**
 * client/src/lib/claimsAccess.test.ts — P4-P23
 * Client-side Claims capability, identity-scoped cache purging, and the
 * per-session field merge used by the authorization/session table.
 */
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { authIdentityKey, canAccessClaims } from "./authGate";
import {
  identityTransition,
  isAuthMeQueryKey,
  isClaimsQueryKey,
  purgeClaimsQueries,
  purgeIdentityScopedQueries,
} from "./claimsCache";
import { mergeSavedSessionField, normalizeRemarksDraft } from "./sessionFieldSave";

const owner = { authType: "owner" as const, id: "o1", role: "admin" as const, isSuperAdmin: true, canAccessClaims: true };
const clinicAdmin = { authType: "clinic" as const, id: "u2", clinicUserId: "c2", role: "admin" as const, mustChangePassword: false, isSuperAdmin: false, canAccessClaims: true };
const clinicStaff = { authType: "clinic" as const, id: "u3", clinicUserId: "c3", role: "staff" as const, mustChangePassword: false, isSuperAdmin: false, canAccessClaims: false };

describe("canAccessClaims", () => {
  it("is true for the Owner/Super Admin and Clinic Admins, false for Staff (P4-P25)", () => {
    expect(canAccessClaims(owner)).toBe(true);
    expect(canAccessClaims(clinicAdmin)).toBe(true);
    expect(canAccessClaims(clinicStaff)).toBe(false);
  });

  it("fails closed while identity is unknown or the server flag is missing", () => {
    expect(canAccessClaims(null)).toBe(false);
    expect(canAccessClaims(undefined)).toBe(false);
    // An admin role alone (e.g. an older server response without the flag) is not enough.
    expect(canAccessClaims({ authType: "owner", role: "admin" })).toBe(false);
    expect(canAccessClaims({ authType: "clinic", role: "admin", mustChangePassword: false })).toBe(false);
  });

  it("fails closed when the server flag and the shared role predicate disagree", () => {
    expect(canAccessClaims({ ...clinicStaff, canAccessClaims: true })).toBe(false);
    expect(canAccessClaims({ ...clinicAdmin, mustChangePassword: true })).toBe(false);
    expect(canAccessClaims({ authType: "owner", role: "user", canAccessClaims: true })).toBe(false);
  });
});

describe("authIdentityKey / identityTransition", () => {
  it("distinguishes accounts and capability changes", () => {
    const keys = [owner, clinicAdmin, clinicStaff].map(authIdentityKey);
    expect(new Set(keys).size).toBe(3);
    expect(authIdentityKey({ ...owner, canAccessClaims: false })).not.toBe(authIdentityKey(owner));
    expect(authIdentityKey(null)).toBeNull();
  });

  it("purges on sign-out, account switch, or role change — never while loading", () => {
    const a = authIdentityKey(owner);
    const b = authIdentityKey(clinicStaff);
    expect(identityTransition(undefined, a)).toBe("none"); // first resolution
    expect(identityTransition(a, undefined)).toBe("none"); // refetching
    expect(identityTransition(a, a)).toBe("none");
    expect(identityTransition(a, null)).toBe("purge-all");
    expect(identityTransition(a, b)).toBe("purge-all");
    expect(identityTransition(null, b)).toBe("purge-all");
  });
});

describe("claims cache purging", () => {
  function seeded() {
    const qc = new QueryClient();
    qc.setQueryData([["claims", "getByPatientAndPeriod"], { input: { patientId: "p", authPeriod: 1 }, type: "query" }], [{ insurance_reimbursement: 99 }]);
    qc.setQueryData([["claims", "getStatusCounts"], { type: "query" }], { counts: {} });
    qc.setQueryData([["patients", "list"], { type: "query" }], [{ id: "p" }]);
    qc.setQueryData([["auth", "me"], { type: "query" }], owner);
    return qc;
  }
  const keys = (qc: QueryClient) => qc.getQueryCache().getAll().map(q => (q.queryKey[0] as string[]).join("."));

  it("recognizes tRPC v11 keys", () => {
    expect(isClaimsQueryKey([["claims", "getStatusCounts"]])).toBe(true);
    expect(isClaimsQueryKey([["visits", "listByPatient"]])).toBe(false);
    expect(isAuthMeQueryKey([["auth", "me"]])).toBe(true);
    expect(isClaimsQueryKey(["claims"])).toBe(false); // not a tRPC key shape
  });

  it("purgeClaimsQueries removes only claims data", () => {
    const qc = seeded();
    purgeClaimsQueries(qc);
    expect(keys(qc).sort()).toEqual(["auth.me", "patients.list"]);
  });

  it("purgeIdentityScopedQueries keeps only auth.me", () => {
    const qc = seeded();
    purgeIdentityScopedQueries(qc);
    expect(keys(qc)).toEqual(["auth.me"]);
  });
});

describe("mergeSavedSessionField", () => {
  const rows = [
    { id: "v1", assignmentOfBenefits: null, submissionStatus: null, remarks: null, sessionNumber: 1 },
    { id: "v2", assignmentOfBenefits: "no" as const, submissionStatus: "hold" as const, remarks: "keep", sessionNumber: 2 },
  ];
  const response = { id: "v1", assignmentOfBenefits: "yes" as const, submissionStatus: "ready_to_file" as const, remarks: "server copy" };

  it("writes only the saved field, only on the saved row", () => {
    const merged = mergeSavedSessionField(rows, response, "assignmentOfBenefits")!;
    expect(merged[0]).toEqual({ ...rows[0], assignmentOfBenefits: "yes" });
    expect(merged[1]).toBe(rows[1]);
  });

  it("tolerates an empty cache", () => {
    expect(mergeSavedSessionField(undefined, response, "remarks")).toBeUndefined();
  });

  it("normalizes remark drafts", () => {
    expect(normalizeRemarksDraft("  \n ")).toBeNull();
    expect(normalizeRemarksDraft("a\nb")).toBe("a\nb");
  });
});
