/**
 * server/actorIdentity.ts — P4-P17
 *
 * Single place that turns a tRPC ctx.user into "who did this" for audit
 * purposes. ctx.user.id and ctx.user.clinicUser?.clinicUserId are primary
 * keys in TWO DIFFERENT identity tables (public.users for owner OAuth,
 * public.clinic_users for individual staff accounts) — they are never the
 * same person just because one happens to be present. Every call site that
 * used to write `ctx.user.clinicUser?.clinicUserId ?? ctx.user.id ?? null`
 * into a single actor_id column lost that distinction; actorType below is
 * what lets a later reader (the History/Activity Log UI) resolve the id
 * against the correct table instead of guessing.
 *
 * actorDisplay is a point-in-time snapshot of the actor's name, captured at
 * write time and stored directly on the audit row (see the *_with_audit
 * Postgres functions) — so attribution for an event stays readable even
 * after the underlying account is later renamed, deactivated, or (in the
 * owner's case) is simply a different person than whoever holds that OAuth
 * identity today.
 *
 * Derived EXCLUSIVELY from the server-verified session context — never from
 * any client-supplied field — so a request body can't spoof an actor.
 */
import type { AuthenticatedUser } from "./_core/sdk";

export type ActorType = "clinic_user" | "owner";

export type ActorContext = {
  actorId: string;
  actorType: ActorType;
  actorDisplay: string;
};

export function getActorContext(user: AuthenticatedUser): ActorContext {
  if (user.clinicUser) {
    return {
      actorId: user.clinicUser.clinicUserId,
      actorType: "clinic_user",
      actorDisplay: user.clinicUser.name || user.clinicUser.username,
    };
  }
  return {
    actorId: user.id,
    actorType: "owner",
    actorDisplay: user.name || "Owner",
  };
}
