/**
 * server/_core/superAdmin.ts — P4-P23
 *
 * The ONE authoritative definition of "Super Admin" (reported as
 * auth.me.isSuperAdmin). P4-P25: Claims access is no longer Super Admin
 * only — Clinic Admins have it too — and is decided by
 * server/_core/claimsAccess.ts / shared/claimsAccess.ts, not here.
 *
 * Mapping: there is no separate Super Admin role column in this codebase.
 * The existing verified owner identity IS the Super Admin:
 *   - an owner OAuth session (no clinicUser attached — clinic sessions are
 *     always bridged with clinicUser set by sdk.authenticateClinicSession),
 *   - whose public.users.role is "admin" (upsertUser only ever assigns
 *     "admin" to ENV.ownerOpenId; every clinic bridge row is "user").
 * This is the same predicate staff.update already uses for "only the owner
 * can change account roles". It deliberately does NOT include clinic admins
 * (clinic_users.role = "admin"), and never looks at a username, email, or
 * display name.
 */
import type { AuthenticatedUser } from "./sdk";

export function isSuperAdmin(user: Pick<AuthenticatedUser, "role" | "clinicUser"> | null | undefined): boolean {
  return !!user && !user.clinicUser && user.role === "admin";
}
