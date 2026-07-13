import { z } from "zod";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import {
  getAllPatients,
  getPatientById,
  createPatient,
  updatePatient,
  deletePatient,
  setPatientActive,
  getVisitsByPatientId,
  createVisitRecord,
  updateVisitRecord,
  bulkCreateVisitRecords,
  getClinicUserByUsername,
  getAuthAlertSummaries,
  getLatestVisitIdForPatient,
  approveAndCreateNewBatch,
  getCompletedPatients,
  getClaimsByPatientAndPeriod,
  createClaimRecord,
  updateClaimRecord,
  deleteClaimRecord,
  upsertClaimRecord,
} from "./db";
import { sdk } from "./_core/sdk";
import { ONE_YEAR_MS } from "@shared/const";

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

// ─── Routers ──────────────────────────────────────────────────────────────────

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
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
        const clinicUser = await getClinicUserByUsername(input.username);
        if (!clinicUser) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid username or password" });
        }
        const valid = await bcrypt.compare(input.password, clinicUser.passwordHash);
        if (!valid) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid username or password" });
        }
        // Create a session token using the existing JWT mechanism.
        const syntheticOpenId = `clinic_${clinicUser.username}`;
        const token = await sdk.createSessionToken(syntheticOpenId, {
          name: clinicUser.username,
          expiresInMs: ONE_YEAR_MS,
        });
        // Upsert a users row so protectedProcedure can resolve ctx.user
        const { upsertUser } = await import("./db");
        await upsertUser({
          openId: syntheticOpenId,
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
  }),

  // ── Patients ────────────────────────────────────────────────────────────────
  patients: router({
    list: protectedProcedure.query(async () => {
      return getAllPatients();
    }),

    get: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }) => {
        const patient = await getPatientById(input.id);
        if (!patient) throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
        return patient;
      }),

    create: protectedProcedure
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

    update: protectedProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          name: z.string().min(1).optional(),
          insurance: z.string().optional(),
          authDate: z.string().nullable().optional(),
          authValidUntil: z.number().nullable().optional(),
          claimsStatus: z.enum(['submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted']).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { id, authDate, authValidUntil, claimsStatus, ...rest } = input;
        await updatePatient(id, {
          ...rest,
          ...(authDate !== undefined ? { authDate: parseDate(authDate) } : {}),
          ...(authValidUntil !== undefined ? { authValidUntil } : {}),
          ...(claimsStatus !== undefined ? { claimsStatus } : {}),
        });
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ input }) => {
        await deletePatient(input.id);
        return { success: true };
      }),

    setActive: protectedProcedure
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

  // ── Visit Records ────────────────────────────────────────────────────────────
  visits: router({
    listByPatient: protectedProcedure
      .input(z.object({ patientId: z.string().uuid() }))
      .query(async ({ input }) => {
        return getVisitsByPatientId(input.patientId);
      }),

    create: protectedProcedure
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

    update: protectedProcedure
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

    bulkCreate: protectedProcedure
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
    authAlerts: protectedProcedure.query(async () => {
      return getAuthAlertSummaries();
    }),

    // Approves a pending authorization and creates a new batch of visit records
    approveAuthorization: protectedProcedure
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
    completedPatientIds: protectedProcedure.query(async () => {
      return getCompletedPatients();
    }),

    // Sets the latest visit row for a patient to authStatus=pending + today's dateAshSubmitted
    markAsRequested: protectedProcedure
      .input(z.object({ patientId: z.string().uuid() }))
      .mutation(async ({ input }) => {
        const visitId = await getLatestVisitIdForPatient(input.patientId);
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
    getByPatientAndPeriod: protectedProcedure
      .input(z.object({ patientId: z.string().uuid(), authPeriod: z.number() }))
      .query(async ({ input }) => {
        return await getClaimsByPatientAndPeriod(input.patientId, input.authPeriod);
      }),

    create: protectedProcedure
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

    update: protectedProcedure
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

    delete: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ input }) => {
        await deleteClaimRecord(input.id);
        return { success: true };
      }),

    upsert: protectedProcedure
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
     * Bulk import claims from a multi-patient EOB file.
     * Matches patient names (case-insensitive) against dashboard patients,
     * finds each patient's latest auth period, and saves all their claims.
     */
    bulkImportFromEOB: protectedProcedure
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
        }))
      }))
      .mutation(async ({ input }) => {
        const { supabase } = await import('./supabase');
        const allPatients = await getAllPatients();
        const uploadType = input.uploadType ?? 'reimbursement';

        const results: Array<{
          patientName: string;
          matched: boolean;
          patientId?: string;
          dashboardName?: string;
          authPeriod?: number;
          claimsImported: number;
          error?: string;
        }> = [];

        for (const group of input.patientGroups) {
          // Fuzzy name matching: handles "ALLISON AUYEUNG" ↔ "AUYEUNG, ALLISON"
          // and other format variations (First Last, Last First, Last, First, mixed case)
          const { findMatchingPatient } = await import('./nameMatch');
          const matchedPatient = findMatchingPatient(group.patientName, allPatients);

          if (!matchedPatient) {
            results.push({
              patientName: group.patientName,
              matched: false,
              claimsImported: 0,
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
          try {
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
                // Build the record with only the fields relevant to the upload type.
                // Reimbursement: fills insurance payment fields only.
                // CMS1500: fills clinical/billing fields only.
                const isReimb = uploadType === 'reimbursement';
                const isCms = uploadType === 'cms1500';

                // CPT code is always used as the match key (even for reimbursement uploads)
                // so that a reimbursement upload can find and patch an existing CMS1500 row.
                // For reimbursement, the EOB service lines include CPT codes — we use them
                // for matching but only write them to the DB if this is a CMS1500 upload.
                const cptForMatch = line.cptCodes ?? null;

                await upsertClaimRecord({
                  patientId: matchedPatient.id,
                  authPeriod: maxPeriod,
                  // ── Match key fields (always provided) ─────────────────────────────
                  dateOfService: parseDate(claim.dateOfService), // always save DOS for identification
                  cptCodes: cptForMatch,                         // always used for matching; written for both types
                  // ── Fields for BOTH upload types ──────────────────────────────
                  claimStatus: claim.claimStatus ?? 'submitted',
                  // ── Reimbursement Insurance upload fields ─────────────────────
                  // Saves: Insurance Reimbursement, Pt Paid, Pt Due,
                  //        Claim #, Check/Payment Date, Check/EFT
                  oaClaimNumber: isReimb ? (claim.oaClaimNumber ?? null) : null,           // Claim #
                  insuranceReimbursement: isReimb ? (line.insuranceReimbursement ?? null) : null,
                  patientAmountPaid: isReimb ? (line.patientAmountPaid ?? null) : null,    // Pt Paid
                  patientAmountDue: isReimb ? (line.patientAmountDue ?? null) : null,      // Pt Due
                  checkDate: isReimb ? parseDate(claim.checkDate) : null,                  // Check/Payment Date
                  checkNumberVirtualCard: isReimb ? (claim.checkNumberVirtualCard ?? null) : null, // Check/EFT
                  referenceNo: isReimb ? (claim.referenceNo ?? null) : null,
                  insuranceBilled: isReimb ? (claim.insuranceBilled ?? null) : null,
                  paymentReceived: isReimb ? (line.insuranceReimbursement ?? null) : null,
                  // ── CMS1500 upload fields ─────────────────────────────────────
                  // Saves: Date of Service, Place of Service, Diagnosis Codes,
                  //        Units Billed, Modifier, CPT Code, Units, Charge, Date Submitted
                  placeOfService: isCms ? (claim.placeOfService ?? null) : null,
                  visitNumber: isCms ? (claim.visitNumber ?? null) : null,
                  unitsBilled: isCms ? (line.unitsBilled ?? null) : null,
                  diagnosisCodes: isCms ? (line.diagnosisCodes ?? null) : null,
                  modifier: isCms ? (line.modifier ?? null) : null,
                  chargeAmount: isCms ? (line.chargeAmount ?? null) : null,
                  claimSubmittedDate: isCms ? parseDate(claim.claimSubmittedDate) : null,
                  expireBcbsClaimNumber: isCms ? (claim.expireBcbsClaimNumber ?? null) : null,
                  // ── Shared optional fields ────────────────────────────────────
                  dateReceived: parseDate(claim.dateReceived),
                  dateOfAppeal: parseDate(claim.dateOfAppeal),
                  lmn: claim.lmn ?? null,
                });
                claimsImported++;
              }
            }
            results.push({
              patientName: group.patientName,
              matched: true,
              patientId: matchedPatient.id,
              dashboardName: matchedPatient.name,
              authPeriod: maxPeriod,
              claimsImported,
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

    markResolved: protectedProcedure
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

    getZeroReimbursement: protectedProcedure
      .query(async () => {
        // Fetch all claim records where insurance_reimbursement is 0 or null
        // and the claim has a charge amount > 0 (meaning a bill was sent)
        // and is not yet resolved
        const { supabase } = await import('./supabase');
        const { data, error } = await supabase
          .from('claims_records')
          .select(`
            id,
            patient_id,
            auth_period,
            date_of_service,
            charge_amount,
            insurance_reimbursement,
            claim_status,
            claim_submitted_date,
            expire_bcbs_claim_number,
            patients!inner(id, name, insurance)
          `)
          .or('insurance_reimbursement.is.null,insurance_reimbursement.eq.0')
          .gt('charge_amount', 0)
          .in('claim_status', ['denied', 'rejected', 'pended', 'resubmitted'])
          .neq('is_resolved', true)
          .order('claim_submitted_date', { ascending: true });

        if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
        return (data ?? []).map((row: any) => ({
          id: row.id as string,
          patientId: row.patient_id as string,
          patientName: row.patients?.name as string,
          insurance: row.patients?.insurance as string,
          authPeriod: row.auth_period as number,
          dateOfService: row.date_of_service as string | null,
          chargeAmount: row.charge_amount as number | null,
          insuranceReimbursement: row.insurance_reimbursement as number | null,
          claimStatus: row.claim_status as string,
          claimSubmittedDate: row.claim_submitted_date as string | null,
          claimNumber: row.expire_bcbs_claim_number as string | null,
        }));
      }),
  }),
});

export type AppRouter = typeof appRouter;
