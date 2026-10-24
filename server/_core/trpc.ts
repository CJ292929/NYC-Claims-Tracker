import { CLAIMS_ACCESS_DENIED_ERR_MSG, NOT_ADMIN_ERR_MSG, PASSWORD_CHANGE_REQUIRED_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { isSuperAdmin } from "./superAdmin";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // Default tRPC behavior surfaces the raw ZodError (a JSON-ish array of
  // {code, path, message} issues) as `error.message`, which clients then
  // show verbatim in toasts. Collapse it into one readable sentence per
  // field instead.
  errorFormatter(opts) {
    const { shape, error } = opts;
    const zodError = error.cause instanceof ZodError ? error.cause : null;
    if (!zodError) return shape;
    const message = zodError.issues
      .map(issue => {
        const field = issue.path.join(".") || "input";
        return `${field}: ${issue.message}`;
      })
      .join("; ");
    return { ...shape, message: message || shape.message };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

/** Base authenticated procedure — permits a clinic session with
 * mustChangePassword=true through. Only auth.me/auth.logout (publicProcedure,
 * unaffected either way) and clinic.changePassword build on this directly;
 * every other authenticated endpoint must use normalProtectedProcedure so a
 * forced-change staff member can reach exactly those endpoints and nothing
 * else. See normalProtectedProcedure below for the enforced rule. */
export const protectedProcedure = t.procedure.use(requireUser);

/** Use for every normal business procedure (patients/visits/claims/etc).
 * Rejects a clinic session with mustChangePassword=true; owner OAuth and
 * clinic sessions with mustChangePassword=false pass through unaffected.
 * Declared inline (rather than via a standalone t.middleware()) so ctx.user
 * is inferred as already-non-null from protectedProcedure's accumulated
 * context instead of the nullable root context. */
export const normalProtectedProcedure = protectedProcedure.use(async opts => {
  const { ctx, next } = opts;

  // Scoped to clinic sessions only: owner OAuth's ctx.user.clinicUser is
  // always undefined, so this can never deny owner access.
  if (ctx.user.clinicUser?.mustChangePassword) {
    throw new TRPCError({ code: "FORBIDDEN", message: PASSWORD_CHANGE_REQUIRED_ERR_MSG });
  }

  return next({ ctx });
});

// Built on normalProtectedProcedure so a clinic admin whose password must be
// changed is blocked by the same gate as any other clinic staff, before the
// role check ever runs — the forced-change rule can't be bypassed by role.
//
// NOTE: ctx.user.role is the owner-OAuth role field (public.users.role).
// Every clinic session is bridged into public.users with role "user"
// regardless of its actual clinic_users.role (see sdk.authenticateClinicSession),
// so this procedure denies every clinic session — including clinic admins.
// It is only safe to use for owner-only endpoints. For anything a clinic
// admin should also reach, use adminOrOwnerProcedure below instead.
export const adminProcedure = normalProtectedProcedure.use(async opts => {
  const { ctx, next } = opts;

  if (ctx.user.role !== 'admin') {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
  }

  return next({ ctx });
});

/** For endpoints owner OAuth *and* clinic admins should both reach (e.g. staff
 * management) — checks clinic_users.role for a clinic session (ctx.user.role
 * is always "user" for those, see adminProcedure's note above) and falls back
 * to the owner-OAuth role check otherwise. */
export const adminOrOwnerProcedure = normalProtectedProcedure.use(async opts => {
  const { ctx, next } = opts;

  const isClinicAdmin = ctx.user.clinicUser?.role === 'admin';
  const isOwnerAdmin = !ctx.user.clinicUser && ctx.user.role === 'admin';
  if (!isClinicAdmin && !isOwnerAdmin) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
  }

  return next({ ctx });
});

/** P4-P23: every Claims endpoint (claims.*) — Super Admin only. Clinic
 * admins and staff are denied with the same generic message regardless of
 * whether the requested claim exists, so the error reveals nothing about
 * claim data. See server/_core/superAdmin.ts for the identity mapping. */
export const superAdminProcedure = normalProtectedProcedure.use(async opts => {
  const { ctx, next } = opts;

  if (!isSuperAdmin(ctx.user)) {
    throw new TRPCError({ code: "FORBIDDEN", message: CLAIMS_ACCESS_DENIED_ERR_MSG });
  }

  return next({ ctx });
});
