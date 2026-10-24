/**
 * client/src/lib/claimsCache.ts — P4-P23
 *
 * React Query keeps every fetched response in memory until it is removed.
 * Claims responses are Super Admin only, so cached data must not outlive the
 * identity that fetched it: on sign-out, on a switch to a different account,
 * or when the signed-in account loses Claims access, the cache is purged
 * (see IdentityCacheGuard in App.tsx and handleSignOut in Dashboard.tsx).
 *
 * tRPC v11 query keys look like [["claims", "getByPatientAndPeriod"], {...}].
 */
import type { QueryClient } from "@tanstack/react-query";

function routerPath(queryKey: readonly unknown[]): readonly unknown[] | null {
  const head = queryKey[0];
  return Array.isArray(head) ? head : null;
}

export function isClaimsQueryKey(queryKey: readonly unknown[]): boolean {
  return routerPath(queryKey)?.[0] === "claims";
}

export function isAuthMeQueryKey(queryKey: readonly unknown[]): boolean {
  const path = routerPath(queryKey);
  return path?.[0] === "auth" && path?.[1] === "me";
}

/** Drops every cached query except auth.me itself (which is what decides
 *  the new identity) — used when the signed-in identity changes. */
export function purgeIdentityScopedQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: query => !isAuthMeQueryKey(query.queryKey) });
}

/** Drops cached Claims responses only — used whenever the current identity
 *  has no Claims access, as a backstop to the per-query `enabled` gates. */
export function purgeClaimsQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: query => isClaimsQueryKey(query.queryKey) });
}

/** Decides what a change in auth identity key requires. `undefined` means
 *  identity hasn't been resolved yet (auth.me still loading); `null` means
 *  signed out. */
export function identityTransition(
  previousKey: string | null | undefined,
  nextKey: string | null | undefined,
): "none" | "purge-all" {
  if (nextKey === undefined) return "none";
  if (previousKey === undefined) return "none";
  return previousKey === nextKey ? "none" : "purge-all";
}
