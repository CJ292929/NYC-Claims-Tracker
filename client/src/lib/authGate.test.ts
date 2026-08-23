/**
 * client/src/lib/authGate.test.ts
 * S2: forced first-password-change gate. App.tsx's ProtectedRoute redirects
 * to /change-password based solely on isForcedPasswordChange's output, so
 * covering the predicate directly covers the routing decision (see
 * App.routeIdentity.test.ts for why this project tests routing logic at the
 * source/pure-function level instead of via component rendering).
 */
import { describe, expect, it } from "vitest";
import { canManageStaff, isForcedPasswordChange } from "./authGate";

describe("isForcedPasswordChange", () => {
  it("L: gates a clinic session with mustChangePassword=true", () => {
    expect(isForcedPasswordChange({ authType: "clinic", role: "staff", mustChangePassword: true })).toBe(true);
  });

  it("M: does not gate a clinic session with mustChangePassword=false", () => {
    expect(isForcedPasswordChange({ authType: "clinic", role: "staff", mustChangePassword: false })).toBe(false);
  });

  it("N: never gates an owner OAuth session, regardless of role", () => {
    expect(isForcedPasswordChange({ authType: "owner", role: "admin" })).toBe(false);
    expect(isForcedPasswordChange({ authType: "owner", role: "user" })).toBe(false);
  });

  it("treats no session (still loading / logged out) as not gated", () => {
    expect(isForcedPasswordChange(null)).toBe(false);
    expect(isForcedPasswordChange(undefined)).toBe(false);
  });
});

// S3: gates the Staff Management nav item/route — mirrors the server's
// adminOrOwnerProcedure (owner OAuth admins + clinic admins in, everyone else out).
describe("canManageStaff", () => {
  it("allows an owner OAuth session with role=admin", () => {
    expect(canManageStaff({ authType: "owner", role: "admin" })).toBe(true);
  });

  it("denies an owner OAuth session with role=user", () => {
    expect(canManageStaff({ authType: "owner", role: "user" })).toBe(false);
  });

  it("allows a clinic session with role=admin", () => {
    expect(canManageStaff({ authType: "clinic", role: "admin", mustChangePassword: false })).toBe(true);
  });

  it("denies a clinic session with role=staff", () => {
    expect(canManageStaff({ authType: "clinic", role: "staff", mustChangePassword: false })).toBe(false);
  });

  it("treats no session (still loading / logged out) as not allowed", () => {
    expect(canManageStaff(null)).toBe(false);
    expect(canManageStaff(undefined)).toBe(false);
  });
});
