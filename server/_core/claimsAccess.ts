/**
 * server/_core/claimsAccess.ts — P4-P25
 *
 * Server adapter for the shared Claims-access capability
 * (shared/claimsAccess.ts). Every server-side Claims gate —
 * claimsAccessProcedure (tRPC), requireClaimsAccess (raw Express routes),
 * and the response-redaction calls in server/routers.ts — goes through
 * canAccessClaims, so it always matches what the client renders.
 *
 * A clinic session is identified by clinicUser being set (see
 * sdk.authenticateClinicSession); its role is clinic_users.role. Every other
 * session is owner OAuth, whose role is public.users.role.
 */
import { hasClaimsAccess } from "@shared/claimsAccess";
import type { AuthenticatedUser } from "./sdk";

export function canAccessClaims(user: Pick<AuthenticatedUser, "role" | "clinicUser"> | null | undefined): boolean {
  if (!user) return false;
  if (user.clinicUser) {
    return hasClaimsAccess({ kind: "clinic", role: user.clinicUser.role, mustChangePassword: user.clinicUser.mustChangePassword });
  }
  return hasClaimsAccess({ kind: "owner", role: user.role });
}
