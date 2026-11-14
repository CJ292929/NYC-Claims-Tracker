import { z } from "zod";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { COOKIE_NAME, MIN_CLINIC_PASSWORD_LENGTH } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminOrOwnerProcedure, normalProtectedProcedure, protectedProcedure, publicProcedure, router, claimsAccessProcedure } from "./_core/trpc";
import { isSuperAdmin } from "./_core/superAdmin";
import { canAccessClaims } from "./_core/claimsAccess";
import { redactAuditRows, redactPatient, redactVisitRecord, VISIT_FINANCIAL_FIELDS } from "./claimsRedaction";
import { sessionWorkflowFieldsInput } from "@shared/sessionWorkflowFields";
import { CLAIMS_ACCESS_DENIED_ERR_MSG } from "@shared/const";
import {
  getAllPatients,
  getPatientById,
  createPatient,
  updatePatient,
  deletePatient,
  setPatientActive,
  getVisitsByPatientId,
  getVisitRecordById,
  createVisitRecord,
  updateVisitRecord,
  bulkCreateVisitRecords,
  getClinicUserByUsername,
  getClinicUserById,
  touchClinicUserLastLogin,
  changeClinicUserPassword,
  getAuthAlertSummaries,
  getMarkAsRequestedTargetVisitId,
  approveAndCreateNewBatch,
  setAuthPeriodExpired,
  getCompletedPatients,
  getClaimsByPatientAndPeriod,
  listPatientClaimPeriods,
  createClaimRecord,
  updateClaimRecord,
  deleteClaimRecordWithAudit,
  ClaimRecordNotFoundError,
  ClaimRecordPatientMismatchError,
  classifyClaimFollowUp,
  sortByFollowUpUrgency,
  aggregateClaimStatusCounts,
  listClinicUsers,
  createClinicUser,
  updateClinicUserProfile,
  updateClinicUserRole,
  adminResetClinicUserPassword,
  archiveClinicUser,
  reactivateClinicUser,
  listInsurerCatalog,
  getInsurerCatalogEntryByNormalizedName,
  getInsurerCatalogEntryById,
  createInsurerCatalogEntry,
  deactivateInsurerCatalogEntry,
  reactivateInsurerCatalogEntry,
  permanentlyDeleteInsurerCatalogEntry,
  InsurerCatalogHasForeignKeysError,
  InsurerCatalogEntryNotFoundError,
  InsurerDeletedError,
  LastActiveAccountManagerError,
  ClinicUserConflictError,
  listActivityLog,
  listHistoryForEntity,
  ClaimImportRuleError,
} from "./db";
import { commitClaimImport, importCommitInput, importPreviewInput, previewClaimImport } from "./claimImport";
import { commitClaimCsvImport, csvImportCommitInput, csvImportPreviewInput, CsvTemplateError, previewClaimCsvImport } from "./claimCsvImport";
import { applyPendingEob, dismissPendingEob, listPendingEob, pendingEobApplyInput, pendingEobDismissInput } from "./pendingEob";
import type { ClinicUser } from "../drizzle/schema";
import { sdk } from "./_core/sdk";
import { getActorContext } from "./actorIdentity";
import { commitPatientCsvImport, patientCsvCommitInput, patientCsvPreviewInput, previewPatientCsvImport } from "./patientCsvImport";
import { randomUUID } from "crypto";
import { ONE_YEAR_MS } from "@shared/const";
import { normalizeInsurerName } from "@shared/insuranceCatalog";
import {
  clearFailedAttempts,
  getClientIp,
  isRateLimited,
  normalizeUsername,
  recordFailedAttempt,
} from "./_core/loginRateLimit";

// ─── Shared input schemas ─────────────────────────────────────────────────────

// P4-P31: visit_records_period_expiry_guard refuses these on every write
// path; translate them into user-facing errors instead of a 500.
function rethrowPeriodExpiryGuard(err: unknown): never {
  const code = (err as { code?: string })?.code;
  if (code === "P0035") throw new TRPCError({ code: "BAD_REQUEST", message: "Expiry is set per authorization period. Use Mark Expired / Restore on the period instead." });
  if (code === "P0036") throw new TRPCError({ code: "CONFLICT", message: "This authorization period is expired. A date of service after the expiry date can't be recorded against it." });
  throw err;
}

const visitRecordInput = z.object({
  sessionsAuthorized: z.number().nullable().optional(),
  sessionsRemaining: z.number().nullable().optional(),
  sessionNumber: z.number().nullable().optional(),
  authPeriod: z.number().optional(),                  // Which authorization period this visit belongs to
  dateOfService: z.string().nullable().optional(),    // ISO date string "YYYY-MM-DD"
  newAuth: z.string().nullable().optional(),
  dateAshSubmitted: z.string().nullable().optional(), // ISO date string "YYYY-MM-DD"
  authStatus: z.enum(["none", "pending", "approved", "denied"]).optional(),
  totalInsuranceReimbursement: z.number().nullable().optional(),
  totalPatientDue: z.number().nullable().optional(),
  totalPatientPaid: z.number().nullable().optional(),
});

// Helper: parse a date string → Date | null (stored as SQL DATE).
// Accepts "YYYY-MM-DD" (HTML date inputs / manual entry) as well as
// "MM/DD/YYYY" and "MM/DD/YY" (the AI claim extractor's output format —
// see aiClaimExtractor.ts). Appending "T00:00:00Z" to a slash-formatted
// date produces a string no JS Date parser recognizes, which silently
// resolved to an Invalid Date (and thus null) for every AI-extracted
// claim's date once saved, even though the same string displayed fine
// pre-save (plain "MM/DD/YYYY" without a time suffix parses fine).
function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const trimmed = s.trim();

  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (slash) {
    const [, mm, dd, yy] = slash;
    const year = yy.length === 2 ? (Number(yy) <= 79 ? 2000 + Number(yy) : 1900 + Number(yy)) : Number(yy);
    const d = new Date(Date.UTC(year, Number(mm) - 1, Number(dd)));
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(trimmed + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}


// Client-facing staff shape — never includes passwordHash or tokenVersion
// (see S3 report / adminOrOwnerProcedure notes in trpc.ts).
function toSafeStaff(user: ClinicUser) {
  const { passwordHash: _passwordHash, tokenVersion: _tokenVersion, ...safe } = user;
  return safe;
}

// P4-P23: the per-session financial totals are Claims financial data —
// writable by Claims-access roles only (Owner/Super Admin, Clinic Admin).
// Rejected (not silently dropped) so a caller can't believe a value was saved.
function assertMayWriteVisitFinancials(
  user: Parameters<typeof canAccessClaims>[0],
  input: Partial<Record<(typeof VISIT_FINANCIAL_FIELDS)[number], unknown>>
) {
  if (canAccessClaims(user)) return;
  if (VISIT_FINANCIAL_FIELDS.some(field => input[field] !== undefined)) {
    throw new TRPCError({ code: "FORBIDDEN", message: CLAIMS_ACCESS_DENIED_ERR_MSG });
  }
}

// ─── Routers ──────────────────────────────────────────────────────────────────

/** P4-P24: the pre-CMS1500-first save paths. Claims-access gated like every
 *  claims.* procedure; always refuses, without reading its input. */
const retiredClaimsImportProcedure = claimsAccessProcedure
  .input(z.unknown())
  .mutation(() => {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This upload flow was replaced by the CMS1500-first import. Reload the page and upload the CMS1500 first, then the EOB.",
    });
  });

export const appRouter = router({
  system: systemRouter,
  auth: router({
    // Discriminated on authType so the client can gate on clinic-only concerns
    // (mustChangePassword) without ever seeing passwordHash or token_version.
    me: publicProcedure.query(({ ctx }) => {
      const user = ctx.user;
      if (!user) return null;

      if (user.clinicUser) {
        const staff = user.clinicUser;
        return {
          authType: "clinic" as const,
          id: user.id,
          clinicUserId: staff.clinicUserId,
          username: staff.username,
          name: staff.name,
          email: staff.email,
          department: staff.department,
          role: staff.role,
          mustChangePassword: staff.mustChangePassword,
          // Always false for a clinic session — see server/_core/superAdmin.ts.
          isSuperAdmin: false as boolean,
          // P4-P25: true for a Clinic Admin, false for Staff — same
          // canAccessClaims() every server-side Claims gate uses.
          canAccessClaims: canAccessClaims(user),
        };
      }

      return {
        authType: "owner" as const,
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isSuperAdmin: isSuperAdmin(user),
        // P4-P25 Claims capability. Computed by the same canAccessClaims()
        // every server-side Claims gate uses, so the UI can never show
        // Claims to a session the server would refuse.
        canAccessClaims: canAccessClaims(user),
      };
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ── Clinic username/password login ────────────────────────────────────────────────────
  clinic: router({
    login: publicProcedure
      .input(z.object({ username: z.string().min(1), password: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const ip = getClientIp(ctx.req);
        const rateLimitKey = normalizeUsername(input.username);

        if (isRateLimited(rateLimitKey, ip)) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Too many login attempts. Please try again later.",
          });
        }

        const clinicUser = await getClinicUserByUsername(input.username);
        if (!clinicUser) {
          recordFailedAttempt(rateLimitKey, ip);
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid username or password" });
        }
        const valid = await bcrypt.compare(input.password, clinicUser.passwordHash);
        if (!valid) {
          recordFailedAttempt(rateLimitKey, ip);
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid username or password" });
        }
        clearFailedAttempts(rateLimitKey, ip);

        // Only checked after a correct password, so an unauthenticated caller
        // can never use this to discover whether an archived account exists.
        if (clinicUser.status !== "active") {
          throw new TRPCError({ code: "FORBIDDEN", message: "This account has been archived. Contact your administrator." });
        }

        await touchClinicUserLastLogin(clinicUser.id);

        // Signing throws synchronously if JWT_SECRET is unset/empty in this
        // environment (jose rejects a zero-length HMAC key). Without this
        // catch, that throw escapes as an unhandled function crash instead
        // of a JSON tRPC error — surfacing to the client as an HTML/text
        // 500 body ("A server error has occurred...") that fails to parse.
        let token: string;
        try {
          token = await sdk.createClinicSessionToken({
            clinicUserId: clinicUser.id,
            username: clinicUser.username,
            tokenVersion: clinicUser.tokenVersion,
          });
        } catch (err) {
          console.error("[clinic.login] Failed to sign session token — check JWT_SECRET is set", err);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Login is temporarily unavailable. Please try again later.",
          });
        }
        // Upsert a users row so normalProtectedProcedure can resolve ctx.user
        // (clinic_users remains the authority for identity/status/role/
        // must_change_password/token_version — this is a compatibility bridge).
        const { upsertUser } = await import("./db");
        await upsertUser({
          openId: `clinic_${clinicUser.username}`,
          name: clinicUser.username,
          email: null,
          loginMethod: "password",
          lastSignedIn: new Date(),
        });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, token, {
          ...cookieOptions,
          maxAge: ONE_YEAR_MS,
        });
        return { success: true, username: clinicUser.username };
      }),

    // Operates only on the currently authenticated clinic user — identity is
    // derived from the session, never accepted from the client.
    // Stays on protectedProcedure (not normalProtectedProcedure) — a clinic
    // user with mustChangePassword=true must still be able to change it.
    changePassword: protectedProcedure
      .input(
        z.object({
          currentPassword: z.string().min(1),
          newPassword: z.string().min(MIN_CLINIC_PASSWORD_LENGTH),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const staff = ctx.user.clinicUser;
        if (!staff) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Not a clinic staff session" });
        }

        const ip = getClientIp(ctx.req);
        const rateLimitKey = normalizeUsername(staff.username);
        if (isRateLimited(rateLimitKey, ip)) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Too many attempts. Please try again later.",
          });
        }

        const clinicUser = await getClinicUserById(staff.clinicUserId);
        if (!clinicUser || clinicUser.status !== "active") {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Session is no longer valid" });
        }

        const validCurrent = await bcrypt.compare(input.currentPassword, clinicUser.passwordHash);
        if (!validCurrent) {
          recordFailedAttempt(rateLimitKey, ip);
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Current password is incorrect" });
        }
        clearFailedAttempts(rateLimitKey, ip);

        if (input.newPassword === input.currentPassword) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "New password must be different from your current password",
          });
        }

        const newPasswordHash = await bcrypt.hash(input.newPassword, 10);
        const updated = await changeClinicUserPassword({
          id: clinicUser.id,
          passwordHash: newPasswordHash,
          expectedTokenVersion: clinicUser.tokenVersion,
        });
        if (!updated) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Your session changed during this request. Please sign in again.",
          });
        }

        const token = await sdk.createClinicSessionToken({
          clinicUserId: updated.id,
          username: updated.username,
          tokenVersion: updated.tokenVersion,
        });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, token, {
          ...cookieOptions,
          maxAge: ONE_YEAR_MS,
        });

        return { success: true } as const;
      }),
  }),

  // ── Staff management (S3) ────────────────────────────────────────────────────
  // Every mutation here is owner/admin only — see adminOrOwnerProcedure in
  // _core/trpc.ts for why this can't reuse adminProcedure.
  staff: router({
    list: adminOrOwnerProcedure.query(async () => {
      const rows = await listClinicUsers();
      return rows.map(toSafeStaff);
    }),

    get: adminOrOwnerProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }) => {
        const row = await getClinicUserById(input.id);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Staff account not found" });
        return toSafeStaff(row);
      }),

    create: adminOrOwnerProcedure
      .input(
        z.object({
          name: z.string().min(1, "Name is required"),
          email: z.string().trim().optional(),
          department: z.string().trim().optional(),
          username: z.string().trim().min(1, "Username is required"),
          role: z.enum(["admin", "staff"]).default("staff"),
          status: z.enum(["active", "archived"]).default("active"),
          password: z.string().min(MIN_CLINIC_PASSWORD_LENGTH, `Password must be at least ${MIN_CLINIC_PASSWORD_LENGTH} characters`),
          confirmPassword: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        if (input.password !== input.confirmPassword) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Passwords do not match" });
        }

        const username = input.username.trim();
        const existing = await getClinicUserByUsername(username);
        if (existing) {
          throw new TRPCError({ code: "CONFLICT", message: "That username is already taken" });
        }

        const passwordHash = await bcrypt.hash(input.password, 10);
        try {
          const created = await createClinicUser({
            username,
            passwordHash,
            name: input.name,
            email: input.email || null,
            department: input.department || null,
            role: input.role,
            status: input.status,
          }, getActorContext(ctx.user));
          return toSafeStaff(created);
        } catch (err: unknown) {
          // Backstop against a race between the uniqueness check above and the
          // insert — the DB's UNIQUE(lower(username)) index is the real guard.
          if ((err as { code?: string })?.code === "23505") {
            throw new TRPCError({ code: "CONFLICT", message: "That username is already taken" });
          }
          throw err;
        }
      }),

    update: adminOrOwnerProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          name: z.string().min(1, "Name is required").optional(),
          email: z.string().trim().optional(),
          department: z.string().trim().optional(),
          role: z.enum(["admin", "staff"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { id, role, ...profile } = input;
        const current = await getClinicUserById(id);
        if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Staff account not found" });

        if (role !== undefined && role !== current.role) {
          // Only the true owner (OAuth identity, never a clinic session —
          // see adminOrOwnerProcedure's notes in _core/trpc.ts) may grant or
          // revoke admin privileges. A clinic admin can still reach this
          // endpoint for profile edits, just not role changes.
          const isOwner = !ctx.user.clinicUser && ctx.user.role === "admin";
          if (!isOwner) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner can change account roles." });
          }
          const isSelf = ctx.user.clinicUser?.clinicUserId === id;
          if (isSelf) {
            throw new TRPCError({ code: "FORBIDDEN", message: "You cannot change your own role." });
          }
          try {
            await updateClinicUserRole({ id, role, expectedTokenVersion: current.tokenVersion }, getActorContext(ctx.user));
          } catch (err: unknown) {
            if (err instanceof LastActiveAccountManagerError) {
              throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
            }
            if (err instanceof ClinicUserConflictError) {
              throw new TRPCError({ code: "CONFLICT", message: "This account changed during the request. Please try again." });
            }
            throw err;
          }
        }

        const profileFields: { name?: string; email?: string | null; department?: string | null } = {};
        if (profile.name !== undefined) profileFields.name = profile.name;
        if (profile.email !== undefined) profileFields.email = profile.email || null;
        if (profile.department !== undefined) profileFields.department = profile.department || null;
        if (Object.keys(profileFields).length > 0) {
          await updateClinicUserProfile(id, profileFields);
        }

        const final = await getClinicUserById(id);
        if (!final) throw new TRPCError({ code: "NOT_FOUND", message: "Staff account not found" });
        return toSafeStaff(final);
      }),

    resetPassword: adminOrOwnerProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          password: z.string().min(MIN_CLINIC_PASSWORD_LENGTH, `Password must be at least ${MIN_CLINIC_PASSWORD_LENGTH} characters`),
          confirmPassword: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        if (input.password !== input.confirmPassword) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Passwords do not match" });
        }

        const current = await getClinicUserById(input.id);
        if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Staff account not found" });

        const passwordHash = await bcrypt.hash(input.password, 10);
        try {
          const updated = await adminResetClinicUserPassword({
            id: input.id,
            passwordHash,
            expectedTokenVersion: current.tokenVersion,
          }, getActorContext(ctx.user));
          return toSafeStaff(updated!);
        } catch (err: unknown) {
          if (err instanceof ClinicUserConflictError) {
            throw new TRPCError({ code: "CONFLICT", message: "This account changed during the request. Please try again." });
          }
          throw err;
        }
      }),

    archive: adminOrOwnerProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const isSelf = ctx.user.clinicUser?.clinicUserId === input.id;
        if (isSelf) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You cannot archive your own account." });
        }

        const current = await getClinicUserById(input.id);
        if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Staff account not found" });

        try {
          const updated = await archiveClinicUser({ id: input.id, expectedTokenVersion: current.tokenVersion }, getActorContext(ctx.user));
          return toSafeStaff(updated!);
        } catch (err: unknown) {
          if (err instanceof LastActiveAccountManagerError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
          }
          if (err instanceof ClinicUserConflictError) {
            throw new TRPCError({ code: "CONFLICT", message: "This account changed during the request. Please try again." });
          }
          throw err;
        }
      }),

    reactivate: adminOrOwnerProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const updated = await reactivateClinicUser(input.id, getActorContext(ctx.user));
        if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Staff account not found" });
        return toSafeStaff(updated);
      }),

    history: adminOrOwnerProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }) => {
        return listHistoryForEntity("clinic_user", input.id);
      }),
  }),

  // ── Patients ────────────────────────────────────────────────────────────────
  patients: router({
    // claimsStatus is claim data — omitted for sessions without Claims access (P4-P25).
    list: normalProtectedProcedure.query(async ({ ctx }) => {
      const claimsAllowed = canAccessClaims(ctx.user);
      return (await getAllPatients()).map(p => redactPatient(p, claimsAllowed));
    }),

    get: normalProtectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        const patient = await getPatientById(input.id);
        if (!patient) throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
        return redactPatient(patient, canAccessClaims(ctx.user));
      }),

    create: normalProtectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          insurance: z.string().default(""),
          authDate: z.string().nullable().optional(),
          authValidUntil: z.number().nullable().optional(), // Unix ms timestamp
        })
      )
      .mutation(async ({ input, ctx }) => {
        try {
          const id = await createPatient({
            name: input.name,
            insurance: input.insurance,
            authDate: parseDate(input.authDate),
            authValidUntil: input.authValidUntil ?? null,
          }, getActorContext(ctx.user));
          return { id };
        } catch (err: unknown) {
          if (err instanceof InsurerDeletedError) {
            throw new TRPCError({ code: "CONFLICT", message: err.message });
          }
          throw err;
        }
      }),

    update: normalProtectedProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          name: z.string().min(1).optional(),
          insurance: z.string().optional(),
          authDate: z.string().nullable().optional(),
          authValidUntil: z.number().nullable().optional(),
          // "none" is the API-level sentinel for "no claims status set" (see
          // getPatientById/listPatients in db.ts, which map a NULL claims_status
          // column to "none"). It is NOT a column value — accepting it here and
          // translating it to `null` below lets the edit form round-trip an
          // unset status without that NULL ever being asked to match the
          // 7-value DB enum, which is what previously threw invalid_value.
          claimsStatus: z.enum(['submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted', 'none']).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { id, authDate, authValidUntil, claimsStatus, ...rest } = input;

        // P4-P25: claims_status is claim data — only Claims-access roles may set it.
        if (claimsStatus !== undefined && !canAccessClaims(ctx.user)) {
          throw new TRPCError({ code: "FORBIDDEN", message: CLAIMS_ACCESS_DENIED_ERR_MSG });
        }

        const before = await getPatientById(id);
        if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });

        // write_patient_with_audit (called inside updatePatient) writes the
        // row update and its audit_logs entry in one transaction, and skips
        // the audit row entirely when nothing actually changed — no
        // separate diff/audit step needed here anymore.
        try {
          await updatePatient(id, {
            ...rest,
            ...(authDate !== undefined ? { authDate: parseDate(authDate) } : {}),
            ...(authValidUntil !== undefined ? { authValidUntil } : {}),
            // Field omitted entirely → key absent → updatePatient leaves the
            // column untouched. Field present as "none" → explicit clear (NULL).
            ...(claimsStatus !== undefined ? { claimsStatus: claimsStatus === 'none' ? null : claimsStatus } : {}),
          }, getActorContext(ctx.user));
        } catch (err: unknown) {
          if (err instanceof InsurerDeletedError) {
            throw new TRPCError({ code: "CONFLICT", message: err.message });
          }
          throw err;
        }

        return { success: true };
      }),

    delete: normalProtectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ input }) => {
        await deletePatient(input.id);
        return { success: true };
      }),

    setActive: normalProtectedProcedure
      .input(z.object({
        id: z.string().uuid(),
        isActive: z.boolean(),
        dischargeDate: z.number().nullable().optional(),
        dischargeReason: z.string().nullable().optional(),
      }))
      .mutation(async ({ input }) => {
        await setPatientActive(input.id, input.isActive, input.dischargeDate, input.dischargeReason);
        return { success: true };
      }),

    history: normalProtectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        return redactAuditRows(await listHistoryForEntity("patient", input.id), canAccessClaims(ctx.user));
      }),
    /**
     * P4-P29: "Bulk Upload Patients" (Patient Data CSV). Same gate as create —
     * Staff, Clinic Admin and Owner; signed-out callers and sessions that must
     * change their password are refused by normalProtectedProcedure. Preview
     * never writes. Commit re-parses the file and re-checks every patient (see
     * server/patientCsvImport.ts); no claims data is read or written.
     */
    csvImportPreview: normalProtectedProcedure
      .input(patientCsvPreviewInput)
      .mutation(({ input }) => previewPatientCsvImport(input)),

    csvImportCommit: normalProtectedProcedure
      .input(patientCsvCommitInput)
      .mutation(({ input, ctx }) => commitPatientCsvImport(input, getActorContext(ctx.user))),
  }),

  // ── Insurer Catalog (P4-P7) ─────────────────────────────────────────────────
  // Single source of truth for insurer choices shown in patient forms,
  // insurance filters, and the generic claims import path. Read access is
  // every authenticated dashboard user (normalProtectedProcedure); creation
  // is owner/clinic-admin only (adminOrOwnerProcedure — same gate as staff
  // management, see its note in _core/trpc.ts).
  insurance: router({
    list: normalProtectedProcedure.query(async () => {
      return listInsurerCatalog();
    }),

    create: adminOrOwnerProcedure
      .input(
        z.object({
          // Blank-after-trim is rejected by the .refine below rather than
          // z.string().min(1) alone, which would accept e.g. "   ".
          name: z.string().transform(v => v.trim()).refine(v => v.length > 0, {
            message: "Insurance company name is required",
          }),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const normalizedName = normalizeInsurerName(input.name);

        const existing = await getInsurerCatalogEntryByNormalizedName(normalizedName);
        if (existing) {
          if (existing.isActive) {
            throw new TRPCError({ code: "CONFLICT", message: "This insurance company already exists" });
          }
          // Re-adding a deliberately-deleted name: reactivate the same row
          // instead of inserting a duplicate (normalized_name stays unique
          // across active+inactive rows — see the P4-P13 migration).
          return await reactivateInsurerCatalogEntry(existing.id, getActorContext(ctx.user));
        }

        try {
          return await createInsurerCatalogEntry({ name: input.name }, getActorContext(ctx.user));
        } catch (err: unknown) {
          // Backstop against a race between the uniqueness check above and
          // the insert — the DB's UNIQUE(normalized_name) index is the real
          // guard (see createInsurerCatalogEntry in db.ts).
          if ((err as { code?: string })?.code === "23505") {
            throw new TRPCError({ code: "CONFLICT", message: "This insurance company already exists" });
          }
          throw err;
        }
      }),

    // Soft delete / "Deactivate" (P4-P13) — admin/owner only. Hides the entry from
    // new-selection dropdowns without touching any patient/visit/claim
    // record (those store the insurer name as free text, not an FK into
    // this table) and without deleting the catalog row itself.
    delete: adminOrOwnerProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        const existing = await getInsurerCatalogEntryById(input.id);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Insurance company not found" });
        }
        return await deactivateInsurerCatalogEntry(input.id, getActorContext(ctx.user));
      }),

    // Deliberate reactivation (P4-P13) from the Manage Insurance Companies
    // dialog — distinct from insurance.create's own reactivate-on-conflict
    // path above, for an admin who wants to bring an entry back without
    // retyping its exact name.
    reactivate: adminOrOwnerProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        const existing = await getInsurerCatalogEntryById(input.id);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Insurance company not found" });
        }
        return await reactivateInsurerCatalogEntry(input.id, getActorContext(ctx.user));
      }),

    // Permanent delete (P4-P21, P4-P22) — admin/owner only. Removes the
    // exact catalog id from the catalog even when patients/visits/claims
    // still store its name: those columns are free text (no FK), so every
    // record keeps its recorded insurer and nothing is reassigned or merged.
    // The delete, its tombstone, and its audit row run in one locked
    // Postgres transaction (delete_insurer_catalog_with_audit).
    permanentDelete: adminOrOwnerProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        try {
          await permanentlyDeleteInsurerCatalogEntry(input.id, getActorContext(ctx.user));
        } catch (err: unknown) {
          if (err instanceof InsurerCatalogHasForeignKeysError) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
          }
          if (err instanceof InsurerCatalogEntryNotFoundError) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "This insurance company no longer exists. It may already have been deleted.",
            });
          }
          throw err;
        }
        return { success: true, id: input.id };
      }),

    // Same gate as create/delete/reactivate — insurer catalog management is
    // admin/owner only, so its history is too (unlike patient/visit/claim
    // history, which any authenticated staff member can read).
    history: adminOrOwnerProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        // Strips the retained claims COUNT from permanent-delete rows for
        // callers without Claims access (see claimsRedaction.ts). Every
        // caller this gate admits has Claims access today (P4-P25); kept as
        // defense in depth.
        return redactAuditRows(await listHistoryForEntity("insurer_catalog", input.id), canAccessClaims(ctx.user));
      }),
  }),

  // ── Visit Records ────────────────────────────────────────────────────────────
  visits: router({
    // Per-session financial totals require Claims access (P4-P25).
    listByPatient: normalProtectedProcedure
      .input(z.object({ patientId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        const claimsAllowed = canAccessClaims(ctx.user);
        return (await getVisitsByPatientId(input.patientId)).map(v => redactVisitRecord(v, claimsAllowed));
      }),

    create: normalProtectedProcedure
      .input(visitRecordInput.extend({ patientId: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        assertMayWriteVisitFinancials(ctx.user, input);
        const { patientId, dateOfService, dateAshSubmitted, ...rest } = input;
        let id: string;
        try {
          id = await createVisitRecord({
            patientId,
            ...rest,
            dateOfService: parseDate(dateOfService),
            dateAshSubmitted: parseDate(dateAshSubmitted),
          }, getActorContext(ctx.user));
        } catch (err: unknown) {
          rethrowPeriodExpiryGuard(err);
        }
        return { id };
      }),

    update: normalProtectedProcedure
      .input(visitRecordInput.extend({ id: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        assertMayWriteVisitFinancials(ctx.user, input);
        const { id, dateOfService, dateAshSubmitted, ...rest } = input;
        try {
          await updateVisitRecord(id, {
            ...rest,
            ...(dateOfService !== undefined ? { dateOfService: parseDate(dateOfService) } : {}),
            ...(dateAshSubmitted !== undefined ? { dateAshSubmitted: parseDate(dateAshSubmitted) } : {}),
          }, getActorContext(ctx.user));
        } catch (err: unknown) {
          rethrowPeriodExpiryGuard(err);
        }
        return { success: true };
      }),

    // P4-P23: per-session workflow fields (Assignment of Benefits, Submission
    // Status, Remarks). Same gate as visits.update — every authenticated
    // Admin/Staff who can edit authorization sessions can edit these.
    // Partial: only keys present in the input are written (null clears);
    // the audited RPC diffs before/after under a row lock, writes the
    // audit row in the same transaction, and skips it entirely for a no-op.
    // Returns the row's stored values so the client can reconcile.
    updateSessionFields: normalProtectedProcedure
      .input(sessionWorkflowFieldsInput.extend({
        id: z.string().uuid(),
        patientId: z.string().uuid(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, patientId, ...fields } = input;
        if (Object.values(fields).every(v => v === undefined)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "No session fields to update" });
        }
        try {
          await updateVisitRecord(id, fields, getActorContext(ctx.user), {
            action: "SESSION_FIELDS_UPDATE",
            patientId,
          });
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code === "P0030") throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
          if (code === "P0031") throw new TRPCError({ code: "BAD_REQUEST", message: "This session does not belong to the selected patient." });
          if (code === "23514") throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid session field value" });
          throw err;
        }
        const saved = await getVisitRecordById(id);
        if (!saved) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
        return {
          id: saved.id,
          assignmentOfBenefits: saved.assignmentOfBenefits,
          submissionStatus: saved.submissionStatus,
          remarks: saved.remarks,
        };
      }),

    bulkCreate: normalProtectedProcedure
      .input(
        z.object({
          patientId: z.string().uuid(),
          records: z.array(visitRecordInput),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const rows = input.records.map(r => ({
          patientId: input.patientId,
          sessionsAuthorized: r.sessionsAuthorized ?? null,
          sessionsRemaining: r.sessionsRemaining ?? null,
          sessionNumber: r.sessionNumber ?? null,
          authPeriod: r.authPeriod ?? 1,
          dateOfService: parseDate(r.dateOfService),
          newAuth: r.newAuth ?? null,
          dateAshSubmitted: parseDate(r.dateAshSubmitted),
          authStatus: r.authStatus ?? "none" as const,
        }));
        try {
          await bulkCreateVisitRecords(rows, getActorContext(ctx.user));
        } catch (err: unknown) {
          rethrowPeriodExpiryGuard(err);
        }
        return { success: true };
      }),

    // Returns urgency summaries for ALL patients — used by the homepage alert panel
    authAlerts: normalProtectedProcedure.query(async () => {
      return getAuthAlertSummaries();
    }),

    // Approves a pending authorization and creates a new batch of visit records
    approveAuthorization: normalProtectedProcedure
      .input(z.object({
        patientId: z.string().uuid(),
        sessionsAuthorized: z.number().min(1).max(200),
        authDate: z.string().nullable().optional(), // ISO date string "YYYY-MM-DD"
        newInsurance: z.string().optional(), // optional insurance change for new period
        authValidUntil: z.number().nullable().optional(), // Unix ms timestamp for expiry
      }))
      .mutation(async ({ input, ctx }) => {
        const authDate = input.authDate ? new Date(input.authDate + "T00:00:00Z") : null;
        const { newVisitIds } = await approveAndCreateNewBatch(
          input.patientId,
          input.sessionsAuthorized,
          authDate,
          input.newInsurance,
          input.authValidUntil ?? undefined,
          getActorContext(ctx.user),
        );
        return { success: true, newVisitCount: newVisitIds.length };
      }),

    // Returns IDs of patients whose sessions are fully completed (0 remaining + all dated)
    completedPatientIds: normalProtectedProcedure.query(async () => {
      return getCompletedPatients();
    }),

    // Sets the active-period visit row (same period getAuthAlertSummaries is
    // showing) to authStatus=pending + today's dateAshSubmitted
    markAsRequested: normalProtectedProcedure
      .input(z.object({ patientId: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        const visitId = await getMarkAsRequestedTargetVisitId(input.patientId);
        if (!visitId) throw new TRPCError({ code: "NOT_FOUND", message: "No visit records found for this patient" });
        const today = new Date();
        const todayMidnight = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
        const actor = getActorContext(ctx.user);
        await updateVisitRecord(visitId, {
          authStatus: "pending",
          dateAshSubmitted: todayMidnight,
        }, actor, { action: "AUTHORIZATION_MARKED_REQUESTED", patientId: input.patientId });
        return { success: true, visitId, date: todayMidnight.toISOString().split("T")[0] };
      }),

    // P4-P31: manually mark one authorization period Expired, or restore it
    // (reason required; refused once a later period exists). Same gate as
    // visits.update / markAsRequested (every authenticated dashboard user who
    // can edit authorization sessions). Never inferred from dates or a zero
    // balance. Only the period's period_expired_at changes — row statuses,
    // counts, dates, claims and money are untouched — audited once per change.
    setPeriodExpired: normalProtectedProcedure
      .input(z.object({
        patientId: z.string().uuid(),
        authPeriod: z.number().int().min(1),
        expired: z.boolean(),
        reason: z.string().trim().max(500).optional(),
      }).refine(v => v.expired || (v.reason ?? "").length > 0, {
        message: "A reason is required to restore an expired authorization period",
        path: ["reason"],
      }))
      .mutation(async ({ input, ctx }) => {
        try {
          const changed = await setAuthPeriodExpired(
            input.patientId, input.authPeriod, input.expired, input.reason || null, getActorContext(ctx.user),
          );
          return { success: true, changed };
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code === "P0020") throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
          if (code === "P0034") throw new TRPCError({ code: "NOT_FOUND", message: "Authorization period not found for this patient" });
          if (code === "P0037") throw new TRPCError({ code: "CONFLICT", message: "This period can't be restored: a newer authorization period already exists." });
          if (code === "22023") throw new TRPCError({ code: "BAD_REQUEST", message: "A reason (500 characters or fewer) is required to restore an expired period." });
          throw err;
        }
      }),

    historyForPatient: normalProtectedProcedure
      .input(z.object({ patientId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        return redactAuditRows(await listHistoryForEntity("visit_record", input.patientId), canAccessClaims(ctx.user));
      }),
  }),

  // P4-P23: the whole Claims surface — rows, financial totals, history,
  // follow-up/status aggregates, CMS1500/EOB enrichment and bulk import —
  // requires Claims access (claimsAccessProcedure, server/_core/trpc.ts).
  claims: router({
    getByPatientAndPeriod: claimsAccessProcedure
      .input(z.object({ patientId: z.string().uuid(), authPeriod: z.number() }))
      .query(async ({ input }) => {
        return await getClaimsByPatientAndPeriod(input.patientId, input.authPeriod);
      }),

    create: claimsAccessProcedure
      .input(z.object({
        patientId: z.string().uuid(),
        authPeriod: z.number(),
        placeOfService: z.string().nullable().optional(),
        dateOfService: z.string().nullable().optional(),
        visitNumber: z.number().nullable().optional(),
        cptCodes: z.string().nullable().optional(),
        unitsBilled: z.number().nullable().optional(),
        diagnosisCodes: z.string().nullable().optional(),
        modifier: z.string().nullable().optional(),
        chargeAmount: z.number().nullable().optional(),
        insuranceReimbursement: z.number().nullable().optional(),
        patientAmountPaid: z.number().nullable().optional(),
        patientAmountDue: z.number().nullable().optional(),
        insuranceBilled: z.string().nullable().optional(),
        oaClaimNumber: z.string().nullable().optional(),
        claimSubmittedDate: z.string().nullable().optional(),
        expireBcbsClaimNumber: z.string().nullable().optional(),
        claimStatus: z.enum(['submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted', 'needs_review']).optional(),
        paymentReceived: z.number().nullable().optional(),
        checkDate: z.string().nullable().optional(),
        checkNumberVirtualCard: z.string().nullable().optional(),
        dateReceived: z.string().nullable().optional(),
        dateOfAppeal: z.string().nullable().optional(),
        referenceNo: z.string().nullable().optional(),
        lmn: z.string().nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const claimId = await createClaimRecord({
          patientId: input.patientId,
          authPeriod: input.authPeriod,
          placeOfService: input.placeOfService ?? null,
          dateOfService: parseDate(input.dateOfService),
          visitNumber: input.visitNumber ?? null,
          cptCodes: input.cptCodes ?? null,
          unitsBilled: input.unitsBilled ?? null,
          diagnosisCodes: input.diagnosisCodes ?? null,
          modifier: input.modifier ?? null,
          chargeAmount: input.chargeAmount ?? null,
          insuranceReimbursement: input.insuranceReimbursement ?? null,
          patientAmountPaid: input.patientAmountPaid ?? null,
          patientAmountDue: input.patientAmountDue ?? null,
          insuranceBilled: input.insuranceBilled ?? null,
          oaClaimNumber: input.oaClaimNumber ?? null,
          claimSubmittedDate: parseDate(input.claimSubmittedDate),
          expireBcbsClaimNumber: input.expireBcbsClaimNumber ?? null,
          claimStatus: input.claimStatus ?? 'submitted',
          paymentReceived: input.paymentReceived ?? null,
          checkDate: parseDate(input.checkDate),
          checkNumberVirtualCard: input.checkNumberVirtualCard ?? null,
          dateReceived: parseDate(input.dateReceived),
          dateOfAppeal: parseDate(input.dateOfAppeal),
          referenceNo: input.referenceNo ?? null,
          lmn: input.lmn ?? null,
        }, getActorContext(ctx.user));
        return { success: true, claimId };
      }),

    update: claimsAccessProcedure
      .input(z.object({
        id: z.string().uuid(),
        placeOfService: z.string().nullable().optional(),
        dateOfService: z.string().nullable().optional(),
        visitNumber: z.number().nullable().optional(),
        cptCodes: z.string().nullable().optional(),
        unitsBilled: z.number().nullable().optional(),
        diagnosisCodes: z.string().nullable().optional(),
        modifier: z.string().nullable().optional(),
        chargeAmount: z.number().nullable().optional(),
        insuranceReimbursement: z.number().nullable().optional(),
        patientAmountPaid: z.number().nullable().optional(),
        patientAmountDue: z.number().nullable().optional(),
        insuranceBilled: z.string().nullable().optional(),
        oaClaimNumber: z.string().nullable().optional(),
        claimSubmittedDate: z.string().nullable().optional(),
        expireBcbsClaimNumber: z.string().nullable().optional(),
        claimStatus: z.enum(['submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted', 'needs_review']).optional(),
        paymentReceived: z.number().nullable().optional(),
        checkDate: z.string().nullable().optional(),
        checkNumberVirtualCard: z.string().nullable().optional(),
        dateReceived: z.string().nullable().optional(),
        dateOfAppeal: z.string().nullable().optional(),
        referenceNo: z.string().nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        // Alert-triggering statuses — if staff changes to one of these,
        // reset is_resolved so the claim re-appears in the follow-up panel
        const alertStatuses = ['denied', 'rejected', 'pended', 'resubmitted'];
        const shouldResetResolved = data.claimStatus !== undefined && alertStatuses.includes(data.claimStatus);

        if (shouldResetResolved) {
          const { supabase } = await import('./supabase');
          await supabase.from('claims_records').update({ is_resolved: false }).eq('id', id);
        }

        await updateClaimRecord(id, {
          placeOfService: data.placeOfService ?? undefined,
          dateOfService: data.dateOfService !== undefined ? parseDate(data.dateOfService) : undefined,
          visitNumber: data.visitNumber ?? undefined,
          cptCodes: data.cptCodes ?? undefined,
          unitsBilled: data.unitsBilled ?? undefined,
          diagnosisCodes: data.diagnosisCodes ?? undefined,
          modifier: data.modifier ?? undefined,
          chargeAmount: data.chargeAmount ?? undefined,
          insuranceReimbursement: data.insuranceReimbursement ?? undefined,
          patientAmountPaid: data.patientAmountPaid ?? undefined,
          patientAmountDue: data.patientAmountDue ?? undefined,
          insuranceBilled: data.insuranceBilled ?? undefined,
          oaClaimNumber: data.oaClaimNumber ?? undefined,
          claimSubmittedDate: data.claimSubmittedDate !== undefined ? parseDate(data.claimSubmittedDate) : undefined,
          expireBcbsClaimNumber: data.expireBcbsClaimNumber ?? undefined,
          claimStatus: data.claimStatus,
          paymentReceived: data.paymentReceived ?? undefined,
          checkDate: data.checkDate !== undefined ? parseDate(data.checkDate) : undefined,
          checkNumberVirtualCard: data.checkNumberVirtualCard ?? undefined,
          dateReceived: data.dateReceived !== undefined ? parseDate(data.dateReceived) : undefined,
          dateOfAppeal: data.dateOfAppeal !== undefined ? parseDate(data.dateOfAppeal) : undefined,
          referenceNo: data.referenceNo ?? undefined,
        }, getActorContext(ctx.user));
        return { success: true };
      }),

    delete: claimsAccessProcedure
      .input(z.object({ id: z.string().uuid(), patientId: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        const actor = getActorContext(ctx.user);
        try {
          await deleteClaimRecordWithAudit({
            claimId: input.id,
            patientId: input.patientId,
            actorId: actor.actorId,
            actorType: actor.actorType,
            actorDisplay: actor.actorDisplay,
          });
        } catch (err) {
          if (err instanceof ClaimRecordNotFoundError) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Claim record not found. It may have already been deleted." });
          }
          if (err instanceof ClaimRecordPatientMismatchError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "This claim does not belong to the selected patient." });
          }
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to delete claim record. No changes were made." });
        }
        return { success: true };
      }),

    // P4-P24: superseded by importPreview / importCommit below. Kept as
    // explicit refusals (still Claims-access gated) rather than removed, so a
    // browser still running the previous bundle during a deploy gets a clear
    // message instead of creating EOB-first rows or enriching untracked rows.
    upsert: retiredClaimsImportProcedure,

    historyForClaim: claimsAccessProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }) => {
        return listHistoryForEntity("claim_record", input.id);
      }),

    /**
     * P4-P24: CMS1500-first import preview — no writes. Classifies every
     * extracted line of every patient group in one uploaded file (see
     * server/claimImport.ts and shared/claimImport.ts for the rules).
     */
    // P4-P28: reviewed EOB lines waiting for their CMS1500 (server/pendingEob.ts).
    pendingEobList: claimsAccessProcedure.query(() => listPendingEob()),
    pendingEobApply: claimsAccessProcedure
      .input(pendingEobApplyInput)
      .mutation(({ input, ctx }) => applyPendingEob(input, getActorContext(ctx.user))),
    pendingEobDismiss: claimsAccessProcedure
      .input(pendingEobDismissInput)
      .mutation(async ({ input, ctx }) => {
        await dismissPendingEob(input, getActorContext(ctx.user));
        return { success: true } as const;
      }),

    // P4-P28: a patient created by an import can have claim lines and no visits yet.
    periodsForPatient: claimsAccessProcedure
      .input(z.object({ patientId: z.string().uuid() }))
      .query(({ input }) => listPatientClaimPeriods(input.patientId)),

    importPreview: claimsAccessProcedure
      .input(importPreviewInput)
      .mutation(async ({ input }) => {
        try {
          return await previewClaimImport(input);
        } catch (err) {
          if (err instanceof ClaimImportRuleError) throw new TRPCError({ code: "NOT_FOUND", message: err.message });
          throw err;
        }
      }),

    /**
     * P4-P24: commit reviewed lines from one uploaded file. Each line is one
     * atomic write+audit RPC call; per-line results come back as saved /
     * unchanged / skipped / review_required / failed, so one bad line never
     * hides the others. Actor identity comes from the verified session only.
     */
    importCommit: claimsAccessProcedure
      .input(importCommitInput)
      .mutation(async ({ input, ctx }) => {
        try {
          return await commitClaimImport(input, getActorContext(ctx.user));
        } catch (err) {
          if (err instanceof ClaimImportRuleError) throw new TRPCError({ code: "NOT_FOUND", message: err.message });
          throw err;
        }
      }),

    /**
     * P4-P26: CMS1500 CSV / Insurance Reimbursement CSV bulk upload preview —
     * no writes. The CSV text is parsed here (server/claimCsvImport.ts); a
     * wrong or malformed template comes back as templateError, row-level
     * problems as rowErrors.
     */
    csvImportPreview: claimsAccessProcedure
      .input(csvImportPreviewInput)
      .mutation(async ({ input }) => {
        try {
          return await previewClaimCsvImport(input);
        } catch (err) {
          if (err instanceof ClaimImportRuleError) throw new TRPCError({ code: "NOT_FOUND", message: err.message });
          throw err;
        }
      }),

    /**
     * P4-P26: commit reviewed lines of a claims CSV. The file is re-parsed and
     * every line's identity and values come from it, not from the request;
     * persistence is the same audited CMS1500-first path as importCommit.
     */
    csvImportCommit: claimsAccessProcedure
      .input(csvImportCommitInput)
      .mutation(async ({ input, ctx }) => {
        try {
          return await commitClaimCsvImport(input, getActorContext(ctx.user));
        } catch (err) {
          if (err instanceof CsvTemplateError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
          if (err instanceof ClaimImportRuleError) throw new TRPCError({ code: "NOT_FOUND", message: err.message });
          throw err;
        }
      }),

    cms1500EnrichmentPreview: retiredClaimsImportProcedure,
    cms1500EnrichmentCommit: retiredClaimsImportProcedure,
    bulkImportFromEOB: retiredClaimsImportProcedure,

    markResolved: claimsAccessProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ input }) => {
        const { supabase } = await import('./supabase');
        // Mark as resolved AND set status to pending so it moves into the pending workflow
        const { error } = await supabase
          .from('claims_records')
          .update({ is_resolved: true, claim_status: 'pending' })
          .eq('id', input.id);
        if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
        return { success: true };
      }),

    getFollowUpClaims: claimsAccessProcedure
      .input(z.object({ insurance: z.string().optional() }).optional())
      .query(async ({ input }) => {
        // Fetch every unresolved claim in a status that can ever need follow-up,
        // then classify each one in JS via classifyClaimFollowUp (server/db.ts).
        // A claim needs follow-up if it is rejected/denied/pended (explicit
        // problem states), approved-but-unpaid (data-entry gap), or
        // pending/submitted/resubmitted and stale (see FOLLOW_UP_STALE_DAYS).
        //
        // Scoped by the selected insurance filter (when provided) so this panel
        // can never disagree with the Claims Status counts or the Patients list,
        // which are scoped the same way — see getStatusCounts below.
        const { supabase } = await import('./supabase');
        let query = supabase
          .from('claims_records')
          .select(`
            id,
            patient_id,
            auth_period,
            date_of_service,
            cpt_codes,
            charge_amount,
            insurance_reimbursement,
            claim_status,
            claim_submitted_date,
            expire_bcbs_claim_number,
            patients!inner(id, name, insurance)
          `)
          .in('claim_status', ['denied', 'rejected', 'pended', 'resubmitted', 'pending', 'submitted', 'approved'])
          .neq('is_resolved', true);
        if (input?.insurance) {
          query = query.eq('patients.insurance', input.insurance);
        }
        const { data, error } = await query;

        if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });

        const classified = (data ?? []).flatMap((row: any) => {
          const result = classifyClaimFollowUp({
            claimStatus: row.claim_status as string | null,
            insuranceReimbursement: row.insurance_reimbursement as number | null,
            claimSubmittedDate: row.claim_submitted_date as string | null,
          });
          if (!result) return [];
          return [{
            id: row.id as string,
            patientId: row.patient_id as string,
            patientName: row.patients?.name as string,
            insurance: row.patients?.insurance as string,
            authPeriod: row.auth_period as number,
            dateOfService: row.date_of_service as string | null,
            cptCodes: row.cpt_codes as string | null,
            chargeAmount: row.charge_amount as number | null,
            insuranceReimbursement: row.insurance_reimbursement as number | null,
            claimStatus: row.claim_status as string,
            claimSubmittedDate: row.claim_submitted_date as string | null,
            claimNumber: row.expire_bcbs_claim_number as string | null,
            urgency: result.urgency,
            followUpReason: result.followUpReason,
          }];
        });

        return sortByFollowUpUrgency(classified);
      }),

    getStatusCounts: claimsAccessProcedure
      .input(z.object({ insurance: z.string().optional() }).optional())
      .query(async ({ input }) => {
        // Powers the "Claims Status" sidebar panel. Always counts claims_records
        // rows directly (via aggregateClaimStatusCounts in server/db.ts) — never
        // the stale patients.claims_status per-patient roll-up, which is why
        // every count previously read 0. Scoped by insurance the same way as
        // getFollowUpClaims above, so the two panels can never contradict
        // each other on screen.
        const { supabase } = await import('./supabase');
        let query = supabase
          .from('claims_records')
          .select('claim_status, patient_id, patients!inner(insurance)');
        if (input?.insurance) {
          query = query.eq('patients.insurance', input.insurance);
        }
        const { data, error } = await query;

        if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });

        return aggregateClaimStatusCounts(
          (data ?? []).map((row: any) => ({
            claimStatus: row.claim_status as string | null,
            patientId: row.patient_id as string,
          }))
        );
      }),
  }),

  // ── Activity Log (P4-P17) ───────────────────────────────────────────────────
  // Cross-entity, paginated, filterable view over audit_logs — owner/admin
  // only, same gate as Staff Management (adminOrOwnerProcedure). Read-only:
  // there is no mutation here, and audit_logs itself has no browser-reachable
  // write path at all (service_role-only, see the P4-P17 migration's RLS).
  activityLog: router({
    list: adminOrOwnerProcedure
      .input(z.object({
        actorId: z.string().uuid().optional(),
        entityType: z.enum(['patient', 'visit_record', 'claim_record', 'pending_eob_line', 'insurer_catalog', 'clinic_user']).optional(),
        action: z.string().optional(),
        dateFrom: z.string().nullable().optional(), // ISO date string "YYYY-MM-DD"
        dateTo: z.string().nullable().optional(),
        page: z.number().int().min(0).default(0),
        pageSize: z.number().int().min(1).max(200).default(50),
      }))
      .query(async ({ ctx, input }) => {
        // P4-P25: every caller this gate admits has Claims access today;
        // the Claims filter/redaction stays as defense in depth.
        const claimsAllowed = canAccessClaims(ctx.user);
        if (!claimsAllowed && (input.entityType === "claim_record" || input.entityType === "pending_eob_line")) {
          throw new TRPCError({ code: "FORBIDDEN", message: CLAIMS_ACCESS_DENIED_ERR_MSG });
        }
        const result = await listActivityLog({
          actorId: input.actorId ?? null,
          entityType: input.entityType ?? null,
          action: input.action ?? null,
          dateFrom: parseDate(input.dateFrom),
          dateTo: parseDate(input.dateTo),
          page: input.page,
          pageSize: input.pageSize,
          excludeClaims: !claimsAllowed,
        });
        return { ...result, rows: redactAuditRows(result.rows, claimsAllowed) };
      }),
  }),
});

export type AppRouter = typeof appRouter;
