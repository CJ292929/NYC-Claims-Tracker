import { z } from "zod";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { COOKIE_NAME, MIN_CLINIC_PASSWORD_LENGTH } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminOrOwnerProcedure, normalProtectedProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import {
  getAllPatients,
  getPatientById,
  createPatient,
  updatePatient,
  diffPatientUpdate,
  createAuditLog,
  deletePatient,
  setPatientActive,
  getVisitsByPatientId,
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
  getCompletedPatients,
  getClaimsByPatientAndPeriod,
  createClaimRecord,
  updateClaimRecord,
  deleteClaimRecordWithAudit,
  ClaimRecordNotFoundError,
  ClaimRecordPatientMismatchError,
  upsertClaimRecord,
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
  findCms1500EnrichmentCandidates,
  patientHasAnyClaimRecords,
  applyCms1500Enrichment,
  type Cms1500EnrichmentCandidate as Cms1500EnrichmentCandidateDTO,
} from "./db";
import type { ClinicUser } from "../drizzle/schema";
import { sdk } from "./_core/sdk";
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

// ─── Routers ──────────────────────────────────────────────────────────────────

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
        };
      }

      return {
        authType: "owner" as const,
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
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
      .mutation(async ({ input }) => {
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
          });
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
          const isSelf = ctx.user.clinicUser?.clinicUserId === id;
          if (isSelf) {
            throw new TRPCError({ code: "FORBIDDEN", message: "You cannot change your own role." });
          }
          const updated = await updateClinicUserRole({ id, role, expectedTokenVersion: current.tokenVersion });
          if (!updated) {
            throw new TRPCError({ code: "CONFLICT", message: "This account changed during the request. Please try again." });
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
      .mutation(async ({ input }) => {
        if (input.password !== input.confirmPassword) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Passwords do not match" });
        }

        const current = await getClinicUserById(input.id);
        if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Staff account not found" });

        const passwordHash = await bcrypt.hash(input.password, 10);
        const updated = await adminResetClinicUserPassword({
          id: input.id,
          passwordHash,
          expectedTokenVersion: current.tokenVersion,
        });
        if (!updated) {
          throw new TRPCError({ code: "CONFLICT", message: "This account changed during the request. Please try again." });
        }
        return toSafeStaff(updated);
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

        const updated = await archiveClinicUser({ id: input.id, expectedTokenVersion: current.tokenVersion });
        if (!updated) {
          throw new TRPCError({ code: "CONFLICT", message: "This account changed during the request. Please try again." });
        }
        return toSafeStaff(updated);
      }),

    reactivate: adminOrOwnerProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ input }) => {
        const updated = await reactivateClinicUser(input.id);
        if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Staff account not found" });
        return toSafeStaff(updated);
      }),
  }),

  // ── Patients ────────────────────────────────────────────────────────────────
  patients: router({
    list: normalProtectedProcedure.query(async () => {
      return getAllPatients();
    }),

    get: normalProtectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }) => {
        const patient = await getPatientById(input.id);
        if (!patient) throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
        return patient;
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
      .mutation(async ({ input }) => {
        const id = await createPatient({
          name: input.name,
          insurance: input.insurance,
          authDate: parseDate(input.authDate),
          authValidUntil: input.authValidUntil ?? null,
        });
        return { id };
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

        const before = await getPatientById(id);
        if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });

        await updatePatient(id, {
          ...rest,
          ...(authDate !== undefined ? { authDate: parseDate(authDate) } : {}),
          ...(authValidUntil !== undefined ? { authValidUntil } : {}),
          // Field omitted entirely → key absent → updatePatient leaves the
          // column untouched. Field present as "none" → explicit clear (NULL).
          ...(claimsStatus !== undefined ? { claimsStatus: claimsStatus === 'none' ? null : claimsStatus } : {}),
        });

        const changes = diffPatientUpdate(before, rest);
        if (changes.length > 0) {
          const actorId = ctx.user.clinicUser?.clinicUserId ?? ctx.user.id ?? null;
          for (const change of changes) {
            await createAuditLog({ patientId: id, actorId, ...change });
          }
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
          const actorId = ctx.user.clinicUser?.clinicUserId ?? ctx.user.id ?? null;
          return await reactivateInsurerCatalogEntry(existing.id, actorId);
        }

        try {
          return await createInsurerCatalogEntry({ name: input.name });
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

    // Soft delete (P4-P13) — admin/owner only. Hides the entry from
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
        const actorId = ctx.user.clinicUser?.clinicUserId ?? ctx.user.id ?? null;
        return await deactivateInsurerCatalogEntry(input.id, actorId);
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
        const actorId = ctx.user.clinicUser?.clinicUserId ?? ctx.user.id ?? null;
        return await reactivateInsurerCatalogEntry(input.id, actorId);
      }),
  }),

  // ── Visit Records ────────────────────────────────────────────────────────────
  visits: router({
    listByPatient: normalProtectedProcedure
      .input(z.object({ patientId: z.string().uuid() }))
      .query(async ({ input }) => {
        return getVisitsByPatientId(input.patientId);
      }),

    create: normalProtectedProcedure
      .input(visitRecordInput.extend({ patientId: z.string().uuid() }))
      .mutation(async ({ input }) => {
        const { patientId, dateOfService, dateAshSubmitted, ...rest } = input;
        const id = await createVisitRecord({
          patientId,
          ...rest,
          dateOfService: parseDate(dateOfService),
          dateAshSubmitted: parseDate(dateAshSubmitted),
        });
        return { id };
      }),

    update: normalProtectedProcedure
      .input(visitRecordInput.extend({ id: z.string().uuid() }))
      .mutation(async ({ input }) => {
        const { id, dateOfService, dateAshSubmitted, ...rest } = input;
        await updateVisitRecord(id, {
          ...rest,
          ...(dateOfService !== undefined ? { dateOfService: parseDate(dateOfService) } : {}),
          ...(dateAshSubmitted !== undefined ? { dateAshSubmitted: parseDate(dateAshSubmitted) } : {}),
        });
        return { success: true };
      }),

    bulkCreate: normalProtectedProcedure
      .input(
        z.object({
          patientId: z.string().uuid(),
          records: z.array(visitRecordInput),
        })
      )
      .mutation(async ({ input }) => {
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
        await bulkCreateVisitRecords(rows);
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
      .mutation(async ({ input }) => {
        const authDate = input.authDate ? new Date(input.authDate + "T00:00:00Z") : null;
        const { newVisitIds } = await approveAndCreateNewBatch(
          input.patientId,
          input.sessionsAuthorized,
          authDate,
          input.newInsurance,
          input.authValidUntil ?? undefined,
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
      .mutation(async ({ input }) => {
        const visitId = await getMarkAsRequestedTargetVisitId(input.patientId);
        if (!visitId) throw new TRPCError({ code: "NOT_FOUND", message: "No visit records found for this patient" });
        const today = new Date();
        const todayMidnight = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
        await updateVisitRecord(visitId, {
          authStatus: "pending",
          dateAshSubmitted: todayMidnight,
        });
        return { success: true, visitId, date: todayMidnight.toISOString().split("T")[0] };
      }),
  }),

  claims: router({
    getByPatientAndPeriod: normalProtectedProcedure
      .input(z.object({ patientId: z.string().uuid(), authPeriod: z.number() }))
      .query(async ({ input }) => {
        return await getClaimsByPatientAndPeriod(input.patientId, input.authPeriod);
      }),

    create: normalProtectedProcedure
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
        claimStatus: z.enum(['submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted']).optional(),
        paymentReceived: z.number().nullable().optional(),
        checkDate: z.string().nullable().optional(),
        checkNumberVirtualCard: z.string().nullable().optional(),
        dateReceived: z.string().nullable().optional(),
        dateOfAppeal: z.string().nullable().optional(),
        referenceNo: z.string().nullable().optional(),
        lmn: z.string().nullable().optional(),
      }))
      .mutation(async ({ input }) => {
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
        });
        return { success: true, claimId };
      }),

    update: normalProtectedProcedure
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
        claimStatus: z.enum(['submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted']).optional(),
        paymentReceived: z.number().nullable().optional(),
        checkDate: z.string().nullable().optional(),
        checkNumberVirtualCard: z.string().nullable().optional(),
        dateReceived: z.string().nullable().optional(),
        dateOfAppeal: z.string().nullable().optional(),
        referenceNo: z.string().nullable().optional(),
      }))
      .mutation(async ({ input }) => {
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
        });
        return { success: true };
      }),

    delete: adminOrOwnerProcedure
      .input(z.object({ id: z.string().uuid(), patientId: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        const actorId = ctx.user.clinicUser?.clinicUserId ?? ctx.user.id ?? null;
        try {
          await deleteClaimRecordWithAudit({
            claimId: input.id,
            patientId: input.patientId,
            actorId,
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

    upsert: normalProtectedProcedure
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
        claimStatus: z.enum(['submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted']).optional(),
        paymentReceived: z.number().nullable().optional(),
        checkDate: z.string().nullable().optional(),
        checkNumberVirtualCard: z.string().nullable().optional(),
        dateReceived: z.string().nullable().optional(),
        dateOfAppeal: z.string().nullable().optional(),
        referenceNo: z.string().nullable().optional(),
        lmn: z.string().nullable().optional(),
      }))
      .mutation(async ({ input }) => {
        await upsertClaimRecord({
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
        });
        return { success: true };
      }),

    /**
     * CMS1500 enrichment, step 1 — preview only, no writes.
     *
     * For each CMS1500 line (identified by its date of service + CPT
     * code(s)), finds existing claim rows for this patient across EVERY auth
     * period (never just their latest) and classifies the result:
     *   - 0 candidates -> 'no_match' (or 'no_claims' if the patient has no
     *     claim rows at all, meaning the reimbursement file was never
     *     uploaded)
     *   - 1 candidate WITH reimbursement evidence (see
     *     Cms1500EnrichmentCandidate.hasReimbursementEvidence) -> 'matched',
     *     safe to auto-apply
     *   - 1 candidate with NO reimbursement evidence -> 'matched_unconfirmed'
     *     — claims_records has no provenance column, so a lone match could
     *     be a manual entry or a legacy/pre-fix CMS1500-only row rather than
     *     an actual reimbursement row; this is disclosed to staff and
     *     requires an explicit confirmation click before it's included in
     *     the commit, never auto-applied like a confirmed 'matched' line
     *   - 2+ candidates -> 'needs_selection' (staff must pick which row)
     */
    cms1500EnrichmentPreview: normalProtectedProcedure
      .input(z.object({
        patientId: z.string().uuid(),
        lines: z.array(z.object({
          lineKey: z.string(),
          dateOfService: z.string().nullable(),
          cptCodes: z.string().nullable(),
        })),
      }))
      .mutation(async ({ input }) => {
        const hasAnyClaims = await patientHasAnyClaimRecords(input.patientId);
        const results = await Promise.all(input.lines.map(async (line) => {
          const dos = parseDate(line.dateOfService);
          if (!dos) {
            return { lineKey: line.lineKey, status: 'invalid_date' as const, candidates: [] as Cms1500EnrichmentCandidateDTO[] };
          }
          const candidates = await findCms1500EnrichmentCandidates(input.patientId, dos, line.cptCodes ?? null);
          if (candidates.length === 0) {
            const status: 'no_match' | 'no_claims' = hasAnyClaims ? 'no_match' : 'no_claims';
            return { lineKey: line.lineKey, status, candidates: [] as Cms1500EnrichmentCandidateDTO[] };
          }
          if (candidates.length === 1) {
            const status: 'matched' | 'matched_unconfirmed' = candidates[0].hasReimbursementEvidence ? 'matched' : 'matched_unconfirmed';
            return { lineKey: line.lineKey, status, candidates, claimRecordId: candidates[0].id };
          }
          return { lineKey: line.lineKey, status: 'needs_selection' as const, candidates };
        }));
        return { hasAnyClaims, results };
      }),

    /**
     * CMS1500 enrichment, step 2 — commit.
     *
     * Only patches visit_number / diagnosis_codes / modifier / units_billed
     * on the specific row identified by `claimRecordId` for each line (the
     * auto-matched id from the preview, or the id staff explicitly selected
     * for an ambiguous line). Re-validates ownership + compatibility
     * server-side before writing — never inserts a new row, never touches
     * charge_amount or any payment field. Lines the client never resolved
     * (no_match/no_claims/needs_selection without a pick) are simply absent
     * from `lines` and so are never sent here at all.
     */
    cms1500EnrichmentCommit: normalProtectedProcedure
      .input(z.object({
        patientId: z.string().uuid(),
        lines: z.array(z.object({
          lineKey: z.string(),
          claimRecordId: z.string().uuid(),
          dateOfService: z.string().nullable(),
          cptCodes: z.string().nullable(),
          visitNumber: z.number().nullable().optional(),
          diagnosisCodes: z.string().nullable().optional(),
          modifier: z.string().nullable().optional(),
          unitsBilled: z.number().nullable().optional(),
        })),
      }))
      .mutation(async ({ input }) => {
        const results: Array<{ lineKey: string; status: 'saved' | 'failed'; error?: string }> = [];
        for (const line of input.lines) {
          try {
            const dos = parseDate(line.dateOfService);
            if (!dos) throw new Error('Invalid or missing date of service.');
            await applyCms1500Enrichment({
              claimRecordId: line.claimRecordId,
              patientId: input.patientId,
              dateOfService: dos,
              cptCodes: line.cptCodes ?? null,
              visitNumber: line.visitNumber ?? null,
              diagnosisCodes: line.diagnosisCodes ?? null,
              modifier: line.modifier ?? null,
              unitsBilled: line.unitsBilled ?? null,
            });
            results.push({ lineKey: line.lineKey, status: 'saved' });
          } catch (err: any) {
            results.push({ lineKey: line.lineKey, status: 'failed', error: err?.message ?? 'Unknown error' });
          }
        }
        return { results };
      }),

    /**
     * Bulk import claims from a multi-patient EOB file.
     * Matches patient names (case-insensitive) against dashboard patients,
     * finds each patient's latest auth period, and saves all their claims.
     */
    bulkImportFromEOB: normalProtectedProcedure
      .input(z.object({
        uploadType: z.enum(['reimbursement', 'cms1500']).default('reimbursement'),
        patientGroups: z.array(z.object({
          patientName: z.string(),
          claims: z.array(z.object({
            // Date-level fields (shared across all CPT lines for this date)
            placeOfService: z.string().nullable().optional(),
            dateOfService: z.string().nullable().optional(),
            visitNumber: z.number().nullable().optional(),
            insuranceBilled: z.string().nullable().optional(),
            oaClaimNumber: z.string().nullable().optional(),
            claimSubmittedDate: z.string().nullable().optional(),
            expireBcbsClaimNumber: z.string().nullable().optional(),
            claimStatus: z.enum(['submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted']).optional(),
            checkDate: z.string().nullable().optional(),
            checkNumberVirtualCard: z.string().nullable().optional(),
            dateReceived: z.string().nullable().optional(),
            dateOfAppeal: z.string().nullable().optional(),
            referenceNo: z.string().nullable().optional(),
            lmn: z.string().nullable().optional(),
            // CPT sub-rows (one claim record per line)
            cptLines: z.array(z.object({
              cptCodes: z.string().nullable().optional(),
              chargeAmount: z.number().nullable().optional(),
              insuranceReimbursement: z.number().nullable().optional(),
              patientAmountPaid: z.number().nullable().optional(),
              patientAmountDue: z.number().nullable().optional(),
              unitsBilled: z.number().nullable().optional(),
              modifier: z.string().nullable().optional(),
              diagnosisCodes: z.string().nullable().optional(),
            })).optional(),
            // Fallback flat fields (when no cptLines)
            cptCodes: z.string().nullable().optional(),
            unitsBilled: z.number().nullable().optional(),
            diagnosisCodes: z.string().nullable().optional(),
            modifier: z.string().nullable().optional(),
            chargeAmount: z.number().nullable().optional(),
            insuranceReimbursement: z.number().nullable().optional(),
            patientAmountPaid: z.number().nullable().optional(),
            patientAmountDue: z.number().nullable().optional(),
            paymentReceived: z.number().nullable().optional(),
          }))
        })),
        // Staff-confirmed matches for groups whose extracted name only
        // produced an ambiguous "candidate" in the preview (see
        // shared/nameMatch.ts classifyPatientMatch) — e.g. a spelled-out
        // middle name the fuzzy matcher correctly refuses to auto-match.
        // Index into patientGroups; never used to override a name that
        // *does* safely fuzzy-match (that path is untouched below).
        confirmedMatches: z.array(z.object({
          groupIndex: z.number().int().nonnegative(),
          patientId: z.string().uuid(),
        })).optional(),
      }))
      .mutation(async ({ input }) => {
        const { supabase } = await import('./supabase');
        const allPatients = await getAllPatients();
        const uploadType = input.uploadType ?? 'reimbursement';

        // Validate confirmedMatches structurally before any import work runs:
        // every groupIndex must refer to a group actually present in this
        // request, and a client can never submit two different confirmations
        // for the same group (that's a conflicting/ambiguous instruction, not
        // something to silently resolve by taking the last one).
        const confirmedMatches = input.confirmedMatches ?? [];
        const seenGroupIndexes = new Set<number>();
        for (const c of confirmedMatches) {
          if (c.groupIndex >= input.patientGroups.length) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `confirmedMatches: groupIndex ${c.groupIndex} does not refer to any group in this import`,
            });
          }
          if (seenGroupIndexes.has(c.groupIndex)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `confirmedMatches: conflicting duplicate confirmation for groupIndex ${c.groupIndex}`,
            });
          }
          seenGroupIndexes.add(c.groupIndex);
        }
        const confirmedByIndex = new Map(
          confirmedMatches.map(c => [c.groupIndex, c.patientId])
        );

        const results: Array<{
          patientName: string;
          matched: boolean;
          patientId?: string;
          dashboardName?: string;
          authPeriod?: number;
          claimsImported: number;
          error?: string;
          ambiguousCandidates?: number;
          // cms1500-only: lines skipped because no reimbursement row exists yet
          // to enrich, or because multiple candidate rows require the staff
          // member to resolve the match explicitly via the single-patient
          // CMS1500 enrichment flow (cms1500EnrichmentPreview/Commit) instead.
          skippedNoMatch?: number;
          skippedNoReimbursementUploaded?: number;
          skippedNeedsSelection?: number;
          skippedUnconfirmedProvenance?: number;
          // Per-line detail for every cms1500 line skipped above -- never
          // just a count. Lets staff see exactly which dates/CPTs need
          // attention and routes them to the single-patient CMS1500 review
          // (cms1500EnrichmentPreview/Commit), which supports both the
          // multi-candidate selection and the unconfirmed-provenance
          // confirmation this bulk flow can't offer inline.
          skippedCms1500Lines?: Array<{
            dateOfService: string | null;
            cptCodes: string | null;
            reason: 'no_match' | 'no_reimbursement_uploaded' | 'needs_selection' | 'unconfirmed_provenance' | 'invalid_date';
          }>;
        }> = [];

        for (let groupIndex = 0; groupIndex < input.patientGroups.length; groupIndex++) {
          const group = input.patientGroups[groupIndex];
          // Fuzzy name matching: handles "ALLISON AUYEUNG" ↔ "AUYEUNG, ALLISON"
          // and other format variations (First Last, Last First, Last, First, mixed case)
          const { classifyPatientMatch } = await import('@shared/nameMatch');
          const { confirmed: safeMatch, candidates } = classifyPatientMatch(group.patientName, allPatients);
          // A staff confirmation only ever fills in for a name the fuzzy
          // matcher didn't already safely resolve — it can't override a
          // *different* safe match. The confirmed id must also belong to
          // THIS group's own eligible candidate set (the same list the
          // preview showed the staff member to choose from) — not just any
          // patient that happens to exist in the system — otherwise a
          // confirmation meant for one ambiguous name could be replayed
          // against an unrelated group, or an unrecognized/stale patientId
          // (e.g. the patient was deleted after the preview was shown) could
          // slip a claim onto the wrong record. An id that isn't an eligible
          // candidate is ignored rather than trusted blindly.
          const confirmedId = safeMatch ? null : confirmedByIndex.get(groupIndex) ?? null;
          const confirmedPatient = confirmedId
            ? candidates.find(p => p.id === confirmedId) ?? null
            : null;
          const matchedPatient = safeMatch ?? confirmedPatient;

          if (!matchedPatient) {
            results.push({
              patientName: group.patientName,
              matched: false,
              claimsImported: 0,
              // Distinguishes "nothing in the file resembles a dashboard
              // patient" from "a likely match exists but requires explicit
              // staff confirmation" (e.g. a middle-name difference) — the
              // confirmation UI lives in the client preview; an unconfirmed
              // candidate is still correctly skipped here, never auto-imported.
              ...(candidates.length > 0 ? { ambiguousCandidates: candidates.length } : {}),
            });
            continue;
          }

          // Find the latest auth period for this patient from visit_records
          const { data: periodRows } = await supabase
            .from('visit_records')
            .select('auth_period')
            .eq('patient_id', matchedPatient.id);

          const maxPeriod = periodRows && periodRows.length > 0
            ? Math.max(...(periodRows as { auth_period: number }[]).map(r => r.auth_period ?? 1))
            : 1;

          // Save all claims for this patient
          // Each date group may have cptLines (one record per CPT code) or be a flat claim
          let claimsImported = 0;
          let skippedNoMatch = 0;
          let skippedNoReimbursementUploaded = 0;
          let skippedNeedsSelection = 0;
          let skippedUnconfirmedProvenance = 0;
          const skippedCms1500Lines: Array<{ dateOfService: string | null; cptCodes: string | null; reason: 'no_match' | 'no_reimbursement_uploaded' | 'needs_selection' | 'unconfirmed_provenance' | 'invalid_date' }> = [];
          try {
            if (uploadType === 'cms1500') {
              // CMS1500 never creates or writes a financial row. Each line is
              // matched against existing claims_records across every auth
              // period this patient has (never just maxPeriod) by exact date
              // of service + CPT code; only visit #/diagnosis/modifier/units
              // are ever patched, and only when exactly one candidate row is
              // found. 0 candidates -> skipped (no reimbursement row to
              // enrich yet); 2+ candidates -> skipped here too, since this
              // bulk/multi-patient flow has no per-line selection UI — staff
              // must resolve those via the single-patient CMS1500 enrichment
              // flow (cms1500EnrichmentPreview/Commit), which does support it.
              const hasAnyClaims = await patientHasAnyClaimRecords(matchedPatient.id);
              for (const claim of group.claims) {
                const lines = claim.cptLines && claim.cptLines.length > 0
                  ? claim.cptLines
                  : [{
                      cptCodes: claim.cptCodes ?? null,
                      unitsBilled: claim.unitsBilled ?? null,
                      modifier: claim.modifier ?? null,
                      diagnosisCodes: claim.diagnosisCodes ?? null,
                    }];
                const dos = parseDate(claim.dateOfService);
                for (const line of lines) {
                  if (!dos) {
                    skippedNoMatch++;
                    skippedCms1500Lines.push({ dateOfService: claim.dateOfService ?? null, cptCodes: line.cptCodes ?? null, reason: 'invalid_date' });
                    continue;
                  }
                  const candidates = await findCms1500EnrichmentCandidates(matchedPatient.id, dos, line.cptCodes ?? null);
                  if (candidates.length === 0) {
                    if (hasAnyClaims) {
                      skippedNoMatch++;
                      skippedCms1500Lines.push({ dateOfService: claim.dateOfService ?? null, cptCodes: line.cptCodes ?? null, reason: 'no_match' });
                    } else {
                      skippedNoReimbursementUploaded++;
                      skippedCms1500Lines.push({ dateOfService: claim.dateOfService ?? null, cptCodes: line.cptCodes ?? null, reason: 'no_reimbursement_uploaded' });
                    }
                    continue;
                  }
                  if (candidates.length > 1) {
                    skippedNeedsSelection++;
                    skippedCms1500Lines.push({ dateOfService: claim.dateOfService ?? null, cptCodes: line.cptCodes ?? null, reason: 'needs_selection' });
                    continue;
                  }
                  if (!candidates[0].hasReimbursementEvidence) {
                    // claims_records has no provenance column -- a lone
                    // match with none of the reimbursement-only fields ever
                    // set could be a manual entry or a legacy/pre-fix
                    // CMS1500-only row rather than an actual reimbursement
                    // row. This bulk flow has no per-line confirmation UI,
                    // so it skips rather than guessing; staff can confirm it
                    // explicitly via the single-patient CMS1500 flow.
                    skippedUnconfirmedProvenance++;
                    skippedCms1500Lines.push({ dateOfService: claim.dateOfService ?? null, cptCodes: line.cptCodes ?? null, reason: 'unconfirmed_provenance' });
                    continue;
                  }
                  await applyCms1500Enrichment({
                    claimRecordId: candidates[0].id,
                    patientId: matchedPatient.id,
                    dateOfService: dos,
                    cptCodes: line.cptCodes ?? null,
                    visitNumber: claim.visitNumber ?? null,
                    diagnosisCodes: line.diagnosisCodes ?? null,
                    modifier: line.modifier ?? null,
                    unitsBilled: line.unitsBilled ?? null,
                  });
                  claimsImported++;
                }
              }
            } else {
              for (const claim of group.claims) {
                const lines = claim.cptLines && claim.cptLines.length > 0
                  ? claim.cptLines
                  : [{ // fallback: treat the claim itself as a single line
                      cptCodes: claim.cptCodes ?? null,
                      chargeAmount: claim.chargeAmount ?? null,
                      insuranceReimbursement: claim.insuranceReimbursement ?? null,
                      patientAmountPaid: claim.patientAmountPaid ?? null,
                      patientAmountDue: claim.patientAmountDue ?? null,
                      unitsBilled: claim.unitsBilled ?? null,
                      modifier: claim.modifier ?? null,
                      diagnosisCodes: claim.diagnosisCodes ?? null,
                    }];

                for (const line of lines) {
                  // Reimbursement is the ONLY upload type this branch handles
                  // now (cms1500 is handled entirely above) — it owns charge
                  // and every payment field, and establishes new claim rows.
                  await upsertClaimRecord({
                    patientId: matchedPatient.id,
                    authPeriod: maxPeriod,
                    dateOfService: parseDate(claim.dateOfService),
                    cptCodes: line.cptCodes ?? null,
                    claimStatus: claim.claimStatus ?? 'submitted',
                    oaClaimNumber: claim.oaClaimNumber ?? null,
                    insuranceReimbursement: line.insuranceReimbursement ?? null,
                    patientAmountPaid: line.patientAmountPaid ?? null,
                    patientAmountDue: line.patientAmountDue ?? null,
                    checkDate: parseDate(claim.checkDate),
                    checkNumberVirtualCard: claim.checkNumberVirtualCard ?? null,
                    referenceNo: claim.referenceNo ?? null,
                    insuranceBilled: claim.insuranceBilled ?? null,
                    paymentReceived: line.insuranceReimbursement ?? null,
                    placeOfService: null,
                    visitNumber: null,
                    claimSubmittedDate: null,
                    expireBcbsClaimNumber: null,
                    // Line-item billing detail (units/diagnosis/modifier/charge)
                    // many EOBs also print alongside their payment columns.
                    unitsBilled: line.unitsBilled ?? null,
                    diagnosisCodes: line.diagnosisCodes ?? null,
                    modifier: line.modifier ?? null,
                    chargeAmount: line.chargeAmount ?? null,
                    dateReceived: parseDate(claim.dateReceived),
                    dateOfAppeal: parseDate(claim.dateOfAppeal),
                    lmn: claim.lmn ?? null,
                  });
                  claimsImported++;
                }
              }
            }
            results.push({
              patientName: group.patientName,
              matched: true,
              patientId: matchedPatient.id,
              dashboardName: matchedPatient.name,
              authPeriod: maxPeriod,
              claimsImported,
              ...(skippedNoMatch > 0 ? { skippedNoMatch } : {}),
              ...(skippedNoReimbursementUploaded > 0 ? { skippedNoReimbursementUploaded } : {}),
              ...(skippedNeedsSelection > 0 ? { skippedNeedsSelection } : {}),
              ...(skippedUnconfirmedProvenance > 0 ? { skippedUnconfirmedProvenance } : {}),
              ...(skippedCms1500Lines.length > 0 ? { skippedCms1500Lines } : {}),
            });
          } catch (err: any) {
            results.push({
              patientName: group.patientName,
              matched: true,
              patientId: matchedPatient.id,
              dashboardName: matchedPatient.name,
              authPeriod: maxPeriod,
              claimsImported,
              error: err?.message ?? 'Unknown error',
            });
          }
        }

        return { results };
      }),

    markResolved: normalProtectedProcedure
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

    getFollowUpClaims: normalProtectedProcedure
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

    getStatusCounts: normalProtectedProcedure
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
});

export type AppRouter = typeof appRouter;
