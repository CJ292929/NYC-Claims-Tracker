/**
 * server/_core/superAdmin.ts — P4-P23
 *
 * The ONE authoritative definition of "Super Admin" — the only identity
 * allowed to see or touch Claims data (claim rows, claim financial totals,
 * claim history, exports, CMS1500/EOB extraction and imports).
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
 *
 * Every Claims gate — superAdminProcedure (tRPC), requireSuperAdmin
 * (raw Express routes), and the response-redaction helpers in
 * server/claimsRedaction.ts — calls this function, so there is exactly one
 * place to change if a real Super Admin role is introduced later.
 */
import type { AuthenticatedUser } from "./sdk";

export function isSuperAdmin(user: Pick<AuthenticatedUser, "role" | "clinicUser"> | null | undefined): boolean {
  return !!user && !user.clinicUser && user.role === "admin";
}
