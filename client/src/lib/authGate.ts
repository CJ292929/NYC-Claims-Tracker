/** Structural shape of trpc.auth.me's response — duck-typed here so this
 * stays independently testable without importing server code into the
 * client bundle. See server/routers.ts auth.me for the authoritative shape. */
export type AuthMeUser =
  | { authType: "owner"; role: "user" | "admin"; isSuperAdmin?: boolean }
  | { authType: "clinic"; role: "admin" | "staff"; mustChangePassword: boolean; isSuperAdmin?: boolean };

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
 * P4-P23: Claims (tab, routes, View Claims links, claim queries, uploads)
 * are Super Admin only. Reads the server-computed `isSuperAdmin` flag from
 * auth.me — the client never re-derives the mapping (see
 * server/_core/superAdmin.ts) — and treats a missing/unknown user (still
 * loading, logged out) as NO access, so nothing claim-related is rendered
 * or fetched before identity is confirmed.
 */
export function canAccessClaims(user: AuthMeUser | null | undefined): boolean {
  return !!user && user.isSuperAdmin === true;
}

/** Stable identity key for cache scoping: changes whenever the signed-in
 *  account or its Claims capability changes. null = signed out. */
export function authIdentityKey(user: (AuthMeUser & { id?: unknown; clinicUserId?: unknown }) | null | undefined): string | null {
  if (!user) return null;
  const who = user.authType === "clinic" ? `clinic:${String(user.clinicUserId ?? user.id ?? "")}` : `owner:${String(user.id ?? "")}`;
  return `${who}|${user.role}|${canAccessClaims(user) ? "claims" : "no-claims"}`;
}
