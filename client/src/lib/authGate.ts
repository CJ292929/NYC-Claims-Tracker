/** Structural shape of trpc.auth.me's response — duck-typed here so this
 * stays independently testable without importing server code into the
 * client bundle. See server/routers.ts auth.me for the authoritative shape. */
export type AuthMeUser =
  | { authType: "owner"; role: "user" | "admin" }
  | { authType: "clinic"; role: "admin" | "staff"; mustChangePassword: boolean };

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
