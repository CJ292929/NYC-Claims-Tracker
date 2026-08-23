/** Structural shape of trpc.auth.me's response — duck-typed here so this
 * stays independently testable without importing server code into the
 * client bundle. See server/routers.ts auth.me for the authoritative shape. */
export type AuthMeUser =
  | { authType: "owner"; role: "user" | "admin" }
  | { authType: "clinic"; mustChangePassword: boolean };

/**
 * True only for a clinic staff session with must_change_password=true.
 * Owner OAuth sessions never have authType "clinic", so this is always false
 * for them regardless of any other field — the gate cannot affect owner auth.
 */
export function isForcedPasswordChange(user: AuthMeUser | null | undefined): boolean {
  return !!user && user.authType === "clinic" && user.mustChangePassword;
}
