/**
 * shared/claimsAccess.ts — P4-P25
 *
 * The ONE definition of who may see or touch Claims data (claim rows, claim
 * financial totals, claim history, exports, CMS1500/EOB extraction, bulk
 * imports, templates). Imported by the server gates (claimsAccessProcedure,
 * requireClaimsAccess, the response-redaction helpers) AND by the client
 * nav/route/query gates, so the two can never disagree.
 *
 * Allowed:
 *   - the owner / Super Admin: an owner OAuth session whose
 *     public.users.role is "admin" (see server/_core/superAdmin.ts);
 *   - a Clinic Admin: a clinic session whose clinic_users.role is "admin".
 * Denied: clinic Staff, non-admin owner-OAuth users, any clinic session that
 * must change its password first, and signed-out callers.
 *
 * Only roles are consulted — never a username, email, or display name.
 */

export type ClaimsAccessPrincipal =
  | { kind: "owner"; role: string }
  | { kind: "clinic"; role: string; mustChangePassword?: boolean };

export function hasClaimsAccess(principal: ClaimsAccessPrincipal | null | undefined): boolean {
  if (!principal) return false;
  if (principal.kind === "clinic") return principal.role === "admin" && principal.mustChangePassword !== true;
  return principal.role === "admin";
}
