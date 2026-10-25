import { hasClaimsAccess } from "@shared/claimsAccess";

/** Structural shape of trpc.auth.me's response — duck-typed here so this
 * stays independently testable without importing server code into the
 * client bundle. See server/routers.ts auth.me for the authoritative shape. */
export type AuthMeUser =
  | { authType: "owner"; role: "user" | "admin"; isSuperAdmin?: boolean; canAccessClaims?: boolean }
  | { authType: "clinic"; role: "admin" | "staff"; mustChangePassword: boolean; isSuperAdmin?: boolean; canAccessClaims?: boolean };

/**
 * True only for a clinic staff session with must_change_password=true.
 * Owner OAuth sessions never have authType "clinic", so this is always false
 * for them regardless of any other field — the gate cannot affect owner auth.
 */
export function isForcedPasswordChange(user: AuthMeUser | null | undefined): boolean {
  return !!user && user.authType === "clinic" && user.mustChangePassword;
}

/**
 * True for owner OAuth admins and clinic admins alike — mirrors the server's
 * adminOrOwnerProcedure gate (see server/_core/trpc.ts) so the Staff
 * Management nav item/route only ever shows for sessions that can actually
 * reach the staff.* endpoints. Client-side gating is UX only; the real
 * enforcement is server-side.
 */
export function canManageStaff(user: AuthMeUser | null | undefined): boolean {
  return !!user && user.role === "admin";
}

/**
 * P4-P25: Claims (tab, routes, View Claims links, claim queries, uploads,
 * exports, templates) are for the Owner/Super Admin and Clinic Admins only —
 * never Staff. Applies the same shared predicate the server gates use
 * (shared/claimsAccess.ts) AND requires the server-computed
 * `canAccessClaims` flag from auth.me, so if the two ever disagree the UI
 * fails closed. A missing/unknown user (still loading, logged out) is NO
 * access, so nothing claim-related is rendered or fetched before identity
 * is confirmed.
 */
export function canAccessClaims(user: AuthMeUser | null | undefined): boolean {
  if (!user || user.canAccessClaims !== true) return false;
  return hasClaimsAccess(
    user.authType === "clinic"
      ? { kind: "clinic", role: user.role, mustChangePassword: user.mustChangePassword }
      : { kind: "owner", role: user.role }
  );
}

/** Stable identity key for cache scoping: changes whenever the signed-in
 *  account or its Claims capability changes. null = signed out. */
export function authIdentityKey(user: (AuthMeUser & { id?: unknown; clinicUserId?: unknown }) | null | undefined): string | null {
  if (!user) return null;
  const who = user.authType === "clinic" ? `clinic:${String(user.clinicUserId ?? user.id ?? "")}` : `owner:${String(user.id ?? "")}`;
  return `${who}|${user.role}|${canAccessClaims(user) ? "claims" : "no-claims"}`;
}
