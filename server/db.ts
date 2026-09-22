/**
 * server/db.ts — All database helpers, backed by Supabase PostgreSQL.
 *
 * Supabase returns snake_case column names. This module converts them to
 * camelCase to match the types in drizzle/schema.ts and the rest of the app.
 */

import { supabase } from "./supabase";
import { ENV } from "./_core/env";
import { normalizeUsername, escapeLikePattern } from "./_core/username";
import type { User, Patient, VisitRecord, ClinicUser, InsertVisitRecord } from "../drizzle/schema";
import { determineActivePeriod, deriveAuthPeriodMetrics, getPeriodMetrics } from "@shared/authPeriodMetrics";
import { deriveAuthorizationUrgency } from "@shared/authUrgency";

// ─── Row adapters (Supabase snake_case → app camelCase) ───────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toUser(row: any): User {
  return {
    id: row.id,
    openId: row.open_id,
    name: row.name ?? null,
    email: row.email ?? null,
    loginMethod: row.login_method ?? null,
    role: row.role ?? "user",
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastSignedIn: new Date(row.last_signed_in),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPatient(row: any): Patient {
  return {
    id: row.id,
    name: row.name,
    insurance: row.insurance ?? "",
    authDate: row.auth_date ? new Date(row.auth_date + "T00:00:00Z") : null,
    authValidUntil: row.auth_valid_until ?? null,
    isActive: row.is_active !== false, // default true if column missing
    dischargeDate: row.discharge_date ?? null,
    dischargeReason: row.discharge_reason ?? null,
    claimsStatus: row.claims_status ?? "none",
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toVisitRecord(row: any): VisitRecord {
  return {
    id: row.id,
    patientId: row.patient_id,
    sessionsAuthorized: row.sessions_authorized ?? null,
    sessionsRemaining: row.sessions_remaining ?? null,
    sessionNumber: row.session_number ?? null,
    authPeriod: row.auth_period ?? 1,
    dateOfService: row.date_of_service ? new Date(row.date_of_service + "T00:00:00Z") : null,
    newAuth: row.new_auth ?? null,
    dateAshSubmitted: row.date_ash_submitted ? new Date(row.date_ash_submitted + "T00:00:00Z") : null,
    authStatus: row.auth_status ?? "none",
    insuranceCompany: row.insurance_company ?? null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toClinicUser(row: any): ClinicUser {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    name: row.name ?? null,
    email: row.email ?? null,
    department: row.department ?? null,
    role: row.role ?? "staff",
    status: row.status ?? "active",
    mustChangePassword: row.must_change_password ?? true,
    tokenVersion: row.token_version ?? 0,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at ?? row.created_at),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null,
    archivedAt: row.archived_at ? new Date(row.archived_at) : null,
  };
}

// ─── User helpers ─────────────────────────────────────────────────────────────

export async function upsertUser(user: {
  openId: string;
  name?: string | null;
  email?: string | null;
  loginMethod?: string | null;
  role?: "user" | "admin";
  lastSignedIn?: Date;
}): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");

  const role = user.role ?? (user.openId === ENV.ownerOpenId ? "admin" : "user");

  const { error } = await supabase
    .from("users")
    .upsert(
      {
        open_id: user.openId,
        name: user.name ?? null,
        email: user.email ?? null,
        login_method: user.loginMethod ?? null,
        role,
        last_signed_in: (user.lastSignedIn ?? new Date()).toISOString(),
      },
      { onConflict: "open_id" }
    );

  if (error) {
    console.error("[Supabase] upsertUser:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string): Promise<User | undefined> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("open_id", openId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[Supabase] getUserByOpenId:", error);
    return undefined;
  }
  return data ? toUser(data) : undefined;
}

// ─── Patient helpers ──────────────────────────────────────────────────────────

export async function getAllPatients(): Promise<Patient[]> {
  const { data, error } = await supabase
    .from("patients")
    .select("*")
    .order("name", { ascending: true });

  if (error) {
    console.error("[Supabase] getAllPatients:", error);
    return [];
  }
  return (data ?? []).map(toPatient);
}

export async function getPatientById(id: string): Promise<Patient | undefined> {
  const { data, error } = await supabase
    .from("patients")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[Supabase] getPatientById:", error);
    return undefined;
  }
  return data ? toPatient(data) : undefined;
}

export async function createPatient(data: {
  name: string;
  insurance?: string;
  authDate?: Date | null;
  authValidUntil?: number | null;
}): Promise<string> {
  const { data: row, error } = await supabase
    .from("patients")
    .insert({
      name: data.name,
      insurance: data.insurance ?? "",
      auth_date: data.authDate ? data.authDate.toISOString().split("T")[0] : null,
      auth_valid_until: data.authValidUntil ?? null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[Supabase] createPatient:", error);
    throw error;
  }
  return (row as { id: string }).id;
}

export async function updatePatient(
  id: string,
  data: { name?: string; insurance?: string; authDate?: Date | null; authValidUntil?: number | null; isActive?: boolean; claimsStatus?: 'submitted' | 'approved' | 'pending' | 'denied' | 'pended' | 'rejected' | 'resubmitted' }
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.insurance !== undefined) update.insurance = data.insurance;
  if (data.authDate !== undefined) {
    update.auth_date = data.authDate ? data.authDate.toISOString().split("T")[0] : null;
  }
  if (data.authValidUntil !== undefined) {
    update.auth_valid_until = data.authValidUntil ?? null;
  }
  if (data.isActive !== undefined) {
    update.is_active = data.isActive;
  }
  if (data.claimsStatus !== undefined) {
    update.claims_status = data.claimsStatus;
  }

  const { error } = await supabase.from("patients").update(update).eq("id", id);
  if (error) {
    console.error("[Supabase] updatePatient:", error);
    throw error;
  }
}

// ─── Audit log helpers ─────────────────────────────────────────────────────

export type PatientAuditChange = {
  action: "PATIENT_NAME_UPDATE";
  oldValue: string;
  newValue: string;
};

/**
 * Compares a patient's current name against the fields being applied by
 * patients.update and returns the audit-worthy changes (only fields that
 * actually changed — an update payload that repeats the existing name
 * produces no entries).
 */
export function diffPatientUpdate(
  before: { name: string },
  after: { name?: string }
): PatientAuditChange[] {
  const changes: PatientAuditChange[] = [];
  if (after.name !== undefined && after.name !== before.name) {
    changes.push({ action: "PATIENT_NAME_UPDATE", oldValue: before.name, newValue: after.name });
  }
  return changes;
}

export async function createAuditLog(entry: {
  patientId: string;
  actorId: string | null;
  action: string;
  oldValue: string | null;
  newValue: string | null;
}): Promise<void> {
  const { error } = await supabase.from("audit_logs").insert({
    patient_id: entry.patientId,
    actor_id: entry.actorId,
    action: entry.action,
    old_value: entry.oldValue,
    new_value: entry.newValue,
  });

  if (error) {
    console.error("[Supabase] createAuditLog:", error);
    throw error;
  }
}

export async function setPatientActive(
  id: string,
  isActive: boolean,
  dischargeDate?: number | null,
  dischargeReason?: string | null
): Promise<void> {
  const update: Record<string, unknown> = { is_active: isActive };
  if (!isActive) {
    // Discharging — stamp date and reason
    update.discharge_date = dischargeDate ?? Date.now();
    update.discharge_reason = dischargeReason ?? null;
  } else {
    // Reactivating — clear discharge fields
    update.discharge_date = null;
    update.discharge_reason = null;
  }
  const { error } = await supabase.from("patients").update(update).eq("id", id);
  if (error) {
    console.error("[Supabase] setPatientActive:", error);
    throw error;
  }
}

export async function deletePatient(id: string): Promise<void> {
  // visit_records has ON DELETE CASCADE in Supabase schema
  const { error } = await supabase.from("patients").delete().eq("id", id);
  if (error) {
    console.error("[Supabase] deletePatient:", error);
    throw error;
  }
}

// ─── Visit record helpers ─────────────────────────────────────────────────────

export async function getVisitsByPatientId(patientId: string): Promise<VisitRecord[]> {
  const { data, error } = await supabase
    .from("visit_records")
    .select("*")
    .eq("patient_id", patientId)
    .order("auth_period", { ascending: true })
    .order("session_number", { ascending: true });

  if (error) {
    console.error("[Supabase] getVisitsByPatientId:", error);
    return [];
  }
  return (data ?? []).map(toVisitRecord);
}

export async function createVisitRecord(data: {
  patientId: string;
  sessionsAuthorized?: number | null;
  sessionsRemaining?: number | null;
  sessionNumber?: number | null;
  authPeriod?: number;
  dateOfService?: Date | null;
  newAuth?: string | null;
  dateAshSubmitted?: Date | null;
  authStatus?: "none" | "pending" | "approved" | "denied";
}): Promise<string> {
  const { data: row, error } = await supabase
    .from("visit_records")
    .insert({
      patient_id: data.patientId,
      sessions_authorized: data.sessionsAuthorized ?? null,
      sessions_remaining: data.sessionsRemaining ?? null,
      session_number: data.sessionNumber ?? null,
      auth_period: data.authPeriod ?? 1,
      date_of_service: data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null,
      new_auth: data.newAuth ?? null,
      date_ash_submitted: data.dateAshSubmitted ? data.dateAshSubmitted.toISOString().split("T")[0] : null,
      auth_status: data.authStatus ?? "none",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[Supabase] createVisitRecord:", error);
    throw error;
  }
  return (row as { id: string }).id;
}

export async function updateVisitRecord(
  id: string,
  data: {
    sessionsAuthorized?: number | null;
    sessionsRemaining?: number | null;
    sessionNumber?: number | null;
    authPeriod?: number;
    dateOfService?: Date | null;
    newAuth?: string | null;
    dateAshSubmitted?: Date | null;
    authStatus?: "none" | "pending" | "approved" | "denied";
  }
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (data.sessionsAuthorized !== undefined) update.sessions_authorized = data.sessionsAuthorized;
  if (data.sessionsRemaining !== undefined) update.sessions_remaining = data.sessionsRemaining;
  if (data.sessionNumber !== undefined) update.session_number = data.sessionNumber;
  if (data.authPeriod !== undefined) update.auth_period = data.authPeriod;
  if (data.dateOfService !== undefined) {
    update.date_of_service = data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null;
  }
  if (data.newAuth !== undefined) update.new_auth = data.newAuth;
  if (data.dateAshSubmitted !== undefined) {
    update.date_ash_submitted = data.dateAshSubmitted ? data.dateAshSubmitted.toISOString().split("T")[0] : null;
  }
  if (data.authStatus !== undefined) update.auth_status = data.authStatus;

  const { error } = await supabase.from("visit_records").update(update).eq("id", id);
  if (error) {
    console.error("[Supabase] updateVisitRecord:", error);
    throw error;
  }
}

export async function bulkCreateVisitRecords(
  records: Array<{
    patientId: string;
    sessionsAuthorized?: number | null;
    sessionsRemaining?: number | null;
    sessionNumber?: number | null;
    authPeriod?: number;
    dateOfService?: Date | null;
    newAuth?: string | null;
    dateAshSubmitted?: Date | null;
    authStatus?: "none" | "pending" | "approved" | "denied";
  }>
): Promise<void> {
  if (records.length === 0) return;

  const rows = records.map(r => ({
    patient_id: r.patientId,
    sessions_authorized: r.sessionsAuthorized ?? null,
    sessions_remaining: r.sessionsRemaining ?? null,
    session_number: r.sessionNumber ?? null,
    auth_period: r.authPeriod ?? 1,
    date_of_service: r.dateOfService ? r.dateOfService.toISOString().split("T")[0] : null,
    new_auth: r.newAuth ?? null,
    date_ash_submitted: r.dateAshSubmitted ? r.dateAshSubmitted.toISOString().split("T")[0] : null,
    auth_status: r.authStatus ?? "none",
  }));

  const { error } = await supabase.from("visit_records").insert(rows);
  if (error) {
    console.error("[Supabase] bulkCreateVisitRecords:", error);
    throw error;
  }
}

// ─── Authorization alert helpers ──────────────────────────────────────────────

export async function getAuthAlertSummaries() {
  const { data: allPatients, error: pErr } = await supabase
    .from("patients")
    .select("*")
    .order("name", { ascending: true });

  if (pErr) { console.error("[Supabase] getAuthAlertSummaries patients:", pErr); return []; }
  if (!allPatients || allPatients.length === 0) return [];

  const { data: allVisits, error: vErr } = await supabase
    .from("visit_records")
    .select("*")
    .order("auth_period", { ascending: true })
    .order("session_number", { ascending: true });

  if (vErr) { console.error("[Supabase] getAuthAlertSummaries visits:", vErr); return []; }
  const visits = (allVisits ?? []).map(toVisitRecord);

  return allPatients.map(patientRow => {
    const patient = toPatient(patientRow);
    const pVisits = visits.filter(v => v.patientId === patient.id);

    if (pVisits.length === 0) {
      return {
        patientId: patient.id, patientName: patient.name, insurance: patient.insurance,
        sessionsAuthorized: null, sessionsRemaining: null,
        authStatus: "none" as const, dateAshSubmitted: null, urgency: "ok" as const,
        authValidUntil: patient.authValidUntil ?? null,
        authPeriod: null,
      };
    }

    const { periods: allPeriods, activePeriod } = deriveAuthPeriodMetrics(pVisits);

    const latestPeriod = allPeriods[allPeriods.length - 1];
    const targetPeriod = activePeriod ?? latestPeriod;
    const targetVisits = pVisits.filter(v => (v.authPeriod ?? 1) === targetPeriod);

    const authRow = targetVisits.find(v => v.sessionsAuthorized != null);
    const sessionsAuthorized = authRow?.sessionsAuthorized ?? null;
    const sessionsRemaining = activePeriod !== null
      ? getPeriodMetrics(pVisits, targetPeriod).remaining
      : 0;

    const lastActiveRow = targetVisits[targetVisits.length - 1];
    const authStatus = lastActiveRow?.authStatus ?? "none";
    const dateAshSubmitted = lastActiveRow?.dateAshSubmitted ?? null;

    const authValidUntil = patient.authValidUntil ?? null;
    const { urgency, authExpiryWarning } = deriveAuthorizationUrgency({
      remaining: sessionsRemaining,
      authStatus,
      authValidUntil,
      now: new Date(),
    });

    return {
      patientId: patient.id, patientName: patient.name, insurance: patient.insurance,
      sessionsAuthorized, sessionsRemaining, authStatus,
      dateAshSubmitted: dateAshSubmitted instanceof Date
        ? dateAshSubmitted.toISOString().split('T')[0]
        : dateAshSubmitted,
      urgency,
      authValidUntil,
      authExpiryWarning,
      authPeriod: targetPeriod,
    };
  });
}

export async function getLatestVisitIdForPatient(patientId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("visit_records")
    .select("id, auth_period, session_number")
    .eq("patient_id", patientId)
    .order("auth_period", { ascending: true })
    .order("session_number", { ascending: true });

  if (error) { console.error("[Supabase] getLatestVisitIdForPatient:", error); return null; }
  if (!data || data.length === 0) return null;
  return (data[data.length - 1] as { id: string }).id;
}

// Mirrors the active-period rule in getAuthAlertSummaries: the oldest period
// with remaining sessions > 0, or null if every period is exhausted. Kept as a
// pure function so approval always targets the same period the alert showed,
// without touching any historical (already-resolved) period.
export function determineActiveAuthPeriod(
  visits: { auth_period: number | null; sessions_authorized: number | null; date_of_service: string | null }[],
): number | null {
  return determineActivePeriod(
    visits.map(v => ({
      authPeriod: v.auth_period,
      sessionsAuthorized: v.sessions_authorized,
      dateOfService: v.date_of_service,
    }))
  );
}

type MarkAsRequestedRow = {
  id: string;
  auth_period: number | null;
  session_number: number | null;
  sessions_authorized: number | null;
  date_of_service: string | null;
};

// Picks the visit row that Mark Requested should update: the last row (by
// session_number) within the same active-period the alert panel is showing —
// activePeriod ?? latestPeriod, exactly as getAuthAlertSummaries computes
// targetPeriod. This keeps the write scoped to the period staff are looking
// at, and matches the row getAuthAlertSummaries reads authStatus/
// dateAshSubmitted back from (targetVisits[targetVisits.length - 1]).
export function determineMarkAsRequestedTargetRow(
  visits: MarkAsRequestedRow[],
): MarkAsRequestedRow | null {
  if (visits.length === 0) return null;

  const periods = Array.from(new Set(visits.map(v => v.auth_period ?? 1))).sort((a, b) => a - b);
  const latestPeriod = periods[periods.length - 1];
  const activePeriod = determineActiveAuthPeriod(visits);
  const targetPeriod = activePeriod ?? latestPeriod;

  const targetVisits = visits
    .filter(v => (v.auth_period ?? 1) === targetPeriod)
    .sort((a, b) => (a.session_number ?? 0) - (b.session_number ?? 0));

  return targetVisits[targetVisits.length - 1] ?? null;
}

// Resolves the visit row markAsRequested should update, scoped to the same
// active authorization period getAuthAlertSummaries used to render the alert.
export async function getMarkAsRequestedTargetVisitId(patientId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("visit_records")
    .select("id, auth_period, session_number, sessions_authorized, date_of_service")
    .eq("patient_id", patientId);

  if (error) { console.error("[Supabase] getMarkAsRequestedTargetVisitId:", error); return null; }
  if (!data || data.length === 0) return null;

  const target = determineMarkAsRequestedTargetRow(data as MarkAsRequestedRow[]);
  return target?.id ?? null;
}

export async function approveAndCreateNewBatch(
  patientId: string,
  sessionsAuthorized: number,
  authDate: Date | null,
  newInsurance?: string,
  authValidUntil?: number | null,
): Promise<{ newVisitIds: string[] }> {
  // 1. Determine which existing authorization period the approval applies to
  const { data: periodStatusRows, error: periodStatusErr } = await supabase
    .from("visit_records")
    .select("auth_period, sessions_authorized, date_of_service")
    .eq("patient_id", patientId);

  if (periodStatusErr) { console.error("[Supabase] approveAndCreateNewBatch periodStatus:", periodStatusErr); throw periodStatusErr; }

  const statusRows = (periodStatusRows ?? []) as { auth_period: number | null; sessions_authorized: number | null; date_of_service: string | null }[];
  const statusPeriods = Array.from(new Set(statusRows.map(r => r.auth_period ?? 1))).sort((a, b) => a - b);
  const latestStatusPeriod = statusPeriods.length > 0 ? statusPeriods[statusPeriods.length - 1] : 1;
  const targetApprovalPeriod = determineActiveAuthPeriod(statusRows) ?? latestStatusPeriod;

  // 2. Mark only the target authorization period's visit rows as approved —
  // other periods (e.g. an earlier denied/pending period) are left untouched
  const { error: approveErr } = await supabase
    .from("visit_records")
    .update({ auth_status: "approved" })
    .eq("patient_id", patientId)
    .eq("auth_period", targetApprovalPeriod);

  if (approveErr) { console.error("[Supabase] approveAndCreateNewBatch approve:", approveErr); throw approveErr; }

  // 3. Update patient authDate and/or insurance
  const patientUpdates: Record<string, unknown> = {};
  if (authDate) patientUpdates.auth_date = authDate.toISOString().split("T")[0];
  if (newInsurance && newInsurance.trim()) patientUpdates.insurance = newInsurance.trim();
  if (authValidUntil !== undefined) patientUpdates.auth_valid_until = authValidUntil ?? null;

  if (Object.keys(patientUpdates).length > 0) {
    const { error: patErr } = await supabase
      .from("patients")
      .update(patientUpdates)
      .eq("id", patientId);
    if (patErr) { console.error("[Supabase] approveAndCreateNewBatch update patient:", patErr); throw patErr; }
  }

  // 4. Determine next auth period
  const { data: periodRows, error: periodErr } = await supabase
    .from("visit_records")
    .select("auth_period")
    .eq("patient_id", patientId);

  if (periodErr) { console.error("[Supabase] approveAndCreateNewBatch periods:", periodErr); throw periodErr; }

  const maxPeriod = periodRows && periodRows.length > 0
    ? Math.max(...(periodRows as { auth_period: number }[]).map(r => r.auth_period ?? 1))
    : 1;
  const nextPeriod = maxPeriod + 1;

  // 5. Resolve the insurance to stamp on the new batch rows
  // Use newInsurance if provided, otherwise fall back to the patient's current insurance
  let batchInsurance: string | null = newInsurance?.trim() || null;
  if (!batchInsurance) {
    const { data: patRow } = await supabase
      .from("patients")
      .select("insurance")
      .eq("id", patientId)
      .single();
    batchInsurance = (patRow as { insurance?: string } | null)?.insurance ?? null;
  }

  // 6. Build and insert new batch
  const newRows = Array.from({ length: sessionsAuthorized }, (_, i) => ({
    patient_id: patientId,
    sessions_authorized: sessionsAuthorized,
    sessions_remaining: sessionsAuthorized - i,
    session_number: i + 1,
    auth_period: nextPeriod,
    date_of_service: null as string | null,
    new_auth: null as string | null,
    date_ash_submitted: null as string | null,
    auth_status: "none" as const,
    insurance_company: batchInsurance,
  }));

  const { data: inserted, error: insertErr } = await supabase
    .from("visit_records")
    .insert(newRows)
    .select("id");

  if (insertErr) { console.error("[Supabase] approveAndCreateNewBatch insert:", insertErr); throw insertErr; }

  const newVisitIds = ((inserted ?? []) as { id: string }[]).map(r => r.id);
  return { newVisitIds };
}

export async function getCompletedPatients(): Promise<string[]> {
  const { data: allPatients, error: pErr } = await supabase
    .from("patients")
    .select("id")
    .order("name", { ascending: true });

  if (pErr) { console.error("[Supabase] getCompletedPatients:", pErr); return []; }
  if (!allPatients || allPatients.length === 0) return [];

  const { data: allVisits, error: vErr } = await supabase
    .from("visit_records")
    .select("id, patient_id, date_of_service, sessions_authorized, auth_period");

  if (vErr) { console.error("[Supabase] getCompletedPatients visits:", vErr); return []; }
  const visits = (allVisits ?? []).map(toVisitRecord);

  return (allPatients as { id: string }[])
    .filter(patient => {
      const pVisits = visits.filter(v => v.patientId === patient.id);
      if (pVisits.length === 0) return false;

      return determineActivePeriod(pVisits) === null;
    })
    .map(p => p.id);
}

// ─── Clinic user helpers ──────────────────────────────────────────────────────

export async function getClinicUserByUsername(username: string): Promise<ClinicUser | undefined> {
  // Case-insensitive lookup, consistent with the UNIQUE(lower(username)) index.
  const normalized = normalizeUsername(username);
  const { data, error } = await supabase
    .from("clinic_users")
    .select("*")
    .ilike("username", escapeLikePattern(normalized))
    .maybeSingle();

  if (error) {
    console.error("[Supabase] getClinicUserByUsername:", error);
    return undefined;
  }
  return data ? toClinicUser(data) : undefined;
}

/** Looked up on every clinic-authenticated request (see sdk.authenticateClinicSession)
 * so archived status and stale token_version reject already-issued sessions. */
export async function getClinicUserById(id: string): Promise<ClinicUser | undefined> {
  const { data, error } = await supabase
    .from("clinic_users")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[Supabase] getClinicUserById:", error);
    return undefined;
  }
  return data ? toClinicUser(data) : undefined;
}

/** Best-effort audit column — a failed write here must not block a successful login. */
export async function touchClinicUserLastLogin(id: string): Promise<void> {
  const { error } = await supabase
    .from("clinic_users")
    .update({ last_login_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[Supabase] touchClinicUserLastLogin:", error);
  }
}

/**
 * Rehashes the password, clears must_change_password, and increments
 * token_version (invalidating every previously issued session for this
 * staff account) in a single UPDATE — atomic for that one row.
 *
 * The token_version bump is optimistic-concurrency guarded: the WHERE clause
 * requires token_version to still equal `expectedTokenVersion`, so a
 * concurrent password change for the same account can't silently clobber
 * this one (PostgREST has no multi-statement transaction here, so this
 * compare-and-swap is the atomicity boundary — see S2 report).
 */
export async function changeClinicUserPassword(params: {
  id: string;
  passwordHash: string;
  expectedTokenVersion: number;
}): Promise<ClinicUser | undefined> {
  const { data, error } = await supabase
    .from("clinic_users")
    .update({
      password_hash: params.passwordHash,
      must_change_password: false,
      token_version: params.expectedTokenVersion + 1,
    })
    .eq("id", params.id)
    .eq("token_version", params.expectedTokenVersion)
    .select()
    .maybeSingle();

  if (error) {
    console.error("[Supabase] changeClinicUserPassword:", error);
    throw error;
  }
  return data ? toClinicUser(data) : undefined;
}

// ─── Staff management (S3) ─────────────────────────────────────────────────
// CRUD for clinic_users driven by the owner/admin Staff Management UI. Every
// mutation that affects auth (password, role, archive status) bumps
// token_version so already-issued sessions for that account are invalidated
// on their next request (see sdk.authenticateClinicSession) — profile-only
// fields (name/email/department) don't touch it.

export async function listClinicUsers(): Promise<ClinicUser[]> {
  const { data, error } = await supabase
    .from("clinic_users")
    .select("*")
    .order("name", { ascending: true });

  if (error) {
    console.error("[Supabase] listClinicUsers:", error);
    return [];
  }
  return (data ?? []).map(toClinicUser);
}

export async function createClinicUser(data: {
  username: string;
  passwordHash: string;
  name: string;
  email: string | null;
  department: string | null;
  role: "admin" | "staff";
  status: "active" | "archived";
}): Promise<ClinicUser> {
  const { data: row, error } = await supabase
    .from("clinic_users")
    .insert({
      username: data.username,
      password_hash: data.passwordHash,
      name: data.name,
      email: data.email,
      department: data.department,
      role: data.role,
      status: data.status,
      must_change_password: true,
      token_version: 0,
    })
    .select()
    .single();

  if (error) {
    console.error("[Supabase] createClinicUser:", error);
    throw error;
  }
  return toClinicUser(row);
}

/** Name/email/department only — these never affect auth, so no token_version
 * bump and no optimistic-concurrency guard is needed. */
export async function updateClinicUserProfile(
  id: string,
  data: { name?: string; email?: string | null; department?: string | null }
): Promise<ClinicUser | undefined> {
  const update: Record<string, unknown> = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.email !== undefined) update.email = data.email;
  if (data.department !== undefined) update.department = data.department;

  if (Object.keys(update).length === 0) {
    return getClinicUserById(id);
  }

  const { data: row, error } = await supabase
    .from("clinic_users")
    .update(update)
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) {
    console.error("[Supabase] updateClinicUserProfile:", error);
    throw error;
  }
  return row ? toClinicUser(row) : undefined;
}

/** Role changes a session's effective permissions, so token_version is bumped
 * (CAS-guarded, same pattern as changeClinicUserPassword) to invalidate any
 * already-issued session carrying the stale role. */
export async function updateClinicUserRole(params: {
  id: string;
  role: "admin" | "staff";
  expectedTokenVersion: number;
}): Promise<ClinicUser | undefined> {
  const { data, error } = await supabase
    .from("clinic_users")
    .update({ role: params.role, token_version: params.expectedTokenVersion + 1 })
    .eq("id", params.id)
    .eq("token_version", params.expectedTokenVersion)
    .select()
    .maybeSingle();

  if (error) {
    console.error("[Supabase] updateClinicUserRole:", error);
    throw error;
  }
  return data ? toClinicUser(data) : undefined;
}

/** Admin-initiated "Reset Login": unlike changeClinicUserPassword (self-service,
 * clears must_change_password), this always sets must_change_password=true so
 * the temporary password forces a change on next login. */
export async function adminResetClinicUserPassword(params: {
  id: string;
  passwordHash: string;
  expectedTokenVersion: number;
}): Promise<ClinicUser | undefined> {
  const { data, error } = await supabase
    .from("clinic_users")
    .update({
      password_hash: params.passwordHash,
      must_change_password: true,
      token_version: params.expectedTokenVersion + 1,
    })
    .eq("id", params.id)
    .eq("token_version", params.expectedTokenVersion)
    .select()
    .maybeSingle();

  if (error) {
    console.error("[Supabase] adminResetClinicUserPassword:", error);
    throw error;
  }
  return data ? toClinicUser(data) : undefined;
}

/** Soft-delete: status -> archived, stamps archived_at, and bumps
 * token_version so any session already issued for this account is rejected
 * on its very next request. The row itself is never removed. */
export async function archiveClinicUser(params: {
  id: string;
  expectedTokenVersion: number;
}): Promise<ClinicUser | undefined> {
  const { data, error } = await supabase
    .from("clinic_users")
    .update({
      status: "archived",
      archived_at: new Date().toISOString(),
      token_version: params.expectedTokenVersion + 1,
    })
    .eq("id", params.id)
    .eq("token_version", params.expectedTokenVersion)
    .select()
    .maybeSingle();

  if (error) {
    console.error("[Supabase] archiveClinicUser:", error);
    throw error;
  }
  return data ? toClinicUser(data) : undefined;
}

/** Reverses archive. No token_version bump — an archived account has no
 * valid session left to invalidate (archiving already bumped it), and no
 * password reset — a reactivated account's existing password stays in
 * effect unless an admin explicitly runs Reset Login afterward. */
export async function reactivateClinicUser(id: string): Promise<ClinicUser | undefined> {
  const { data, error } = await supabase
    .from("clinic_users")
    .update({ status: "active", archived_at: null })
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) {
    console.error("[Supabase] reactivateClinicUser:", error);
    throw error;
  }
  return data ? toClinicUser(data) : undefined;
}

// ─── Claims follow-up classification ──────────────────────────────────────────
// A claim needing staff attention falls into one of 7 mutually-exclusive
// urgency buckets. Ranked 1 (most urgent) → 7 (least urgent) per product spec.

export const FOLLOW_UP_STALE_DAYS = 30;

export type FollowUpUrgency =
  | "rejected"
  | "denied"
  | "pended"
  | "approved_unpaid"
  | "pending_stale"
  | "submitted_stale"
  | "resubmitted_stale";

export type ClaimFollowUpCandidate = {
  claimStatus: string | null;
  insuranceReimbursement: number | null;
  claimSubmittedDate: string | null;
};

const FOLLOW_UP_URGENCY_RANK: Record<FollowUpUrgency, number> = {
  rejected: 1,
  denied: 2,
  pended: 3,
  approved_unpaid: 4,
  pending_stale: 5,
  submitted_stale: 6,
  resubmitted_stale: 7,
};

const FOLLOW_UP_REASONS: Record<FollowUpUrgency, string> = {
  rejected: "Claim rejected — needs review",
  denied: "Claim denied — needs appeal or resubmission",
  pended: "Claim pended — waiting on additional info",
  approved_unpaid: "Approved but no reimbursement recorded",
  pending_stale: `Pending >${FOLLOW_UP_STALE_DAYS} days — follow up with payer`,
  submitted_stale: `Submitted >${FOLLOW_UP_STALE_DAYS} days ago — no payment received`,
  resubmitted_stale: `Resubmitted >${FOLLOW_UP_STALE_DAYS} days ago — no response`,
};

function daysSince(dateStr: string | null, now: Date): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Classifies a claim into a follow-up urgency bucket, or returns null if the
 * claim needs no staff attention. See FOLLOW_UP_REASONS for the 7 conditions.
 */
export function classifyClaimFollowUp(
  claim: ClaimFollowUpCandidate,
  now: Date = new Date()
): { urgency: FollowUpUrgency; followUpReason: string } | null {
  const status = claim.claimStatus ?? "";
  const unpaid = claim.insuranceReimbursement == null || claim.insuranceReimbursement === 0;
  const days = daysSince(claim.claimSubmittedDate, now);
  const isStale = days != null && days > FOLLOW_UP_STALE_DAYS;

  let urgency: FollowUpUrgency | null = null;
  if (status === "rejected") urgency = "rejected";
  else if (status === "denied") urgency = "denied";
  else if (status === "pended") urgency = "pended";
  else if (status === "approved" && unpaid) urgency = "approved_unpaid";
  else if (status === "pending" && isStale) urgency = "pending_stale";
  else if (status === "submitted" && unpaid && isStale) urgency = "submitted_stale";
  else if (status === "resubmitted" && isStale) urgency = "resubmitted_stale";

  if (!urgency) return null;
  return { urgency, followUpReason: FOLLOW_UP_REASONS[urgency] };
}

export function sortByFollowUpUrgency<T extends { urgency: FollowUpUrgency }>(items: T[]): T[] {
  return [...items].sort((a, b) => FOLLOW_UP_URGENCY_RANK[a.urgency] - FOLLOW_UP_URGENCY_RANK[b.urgency]);
}

// ─── Claims status counts ──────────────────────────────────────────────────────
// Powers the "Claims Status" sidebar filter panel. Always aggregates directly
// from claims_records rows — never from the stale patients.claims_status
// per-patient roll-up column, which is what caused every count to read 0.

const CLAIM_STATUS_KEYS = [
  "submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted",
] as const;

export type ClaimStatusKey = (typeof CLAIM_STATUS_KEYS)[number] | "none";

export type ClaimStatusCounts = { all: number } & Record<ClaimStatusKey, number>;

export function aggregateClaimStatusCounts(
  rows: Array<{ claimStatus: string | null; patientId: string }>
): { counts: ClaimStatusCounts; patientIdsByStatus: Record<ClaimStatusKey, string[]> } {
  const counts = { all: rows.length } as ClaimStatusCounts;
  const patientIdSets: Record<ClaimStatusKey, Set<string>> = {} as Record<ClaimStatusKey, Set<string>>;
  for (const key of [...CLAIM_STATUS_KEYS, "none" as const]) {
    counts[key] = 0;
    patientIdSets[key] = new Set();
  }

  for (const row of rows) {
    const status = row.claimStatus?.trim();
    const key: ClaimStatusKey =
      status && (CLAIM_STATUS_KEYS as readonly string[]).includes(status)
        ? (status as ClaimStatusKey)
        : "none";
    counts[key] += 1;
    patientIdSets[key].add(row.patientId);
  }

  const patientIdsByStatus = Object.fromEntries(
    Object.entries(patientIdSets).map(([key, set]) => [key, Array.from(set)])
  ) as Record<ClaimStatusKey, string[]>;

  return { counts, patientIdsByStatus };
}

// ─── Claims record helpers ────────────────────────────────────────────────────

export async function getClaimsByPatientAndPeriod(patientId: string, authPeriod: number): Promise<any[]> {
  const { data, error } = await supabase
    .from("claims_records")
    .select("*")
    .eq("patient_id", patientId)
    .eq("auth_period", authPeriod)
    // date_of_service alone isn't unique — multiple service lines from the same
    // visit share it — and Postgres doesn't guarantee stable ordering among tied
    // rows across separate queries. Without a tiebreaker, same-date rows could
    // come back in a different relative order after any refetch (e.g. right
    // after approving a claim), which the UI's "hide repeated date" logic reads
    // as a different row now sharing its predecessor's date, making that row's
    // date appear to vanish even though the underlying data never changed.
    .order("date_of_service", { ascending: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[Supabase] getClaimsByPatientAndPeriod:", error);
    return [];
  }
  return data ?? [];
}

export async function createClaimRecord(data: {
  patientId: string;
  authPeriod: number;
  placeOfService?: string | null;
  dateOfService?: Date | null;
  visitNumber?: number | null;
  cptCodes?: string | null;
  unitsBilled?: number | null;
  diagnosisCodes?: string | null;
  modifier?: string | null;
  chargeAmount?: number | null;
  insuranceReimbursement?: number | null;
  patientAmountPaid?: number | null;
  patientAmountDue?: number | null;
  insuranceBilled?: string | null;
  oaClaimNumber?: string | null;
  claimSubmittedDate?: Date | null;
  expireBcbsClaimNumber?: string | null;
  claimStatus?: 'submitted' | 'approved' | 'pending' | 'denied' | 'pended' | 'rejected' | 'resubmitted';
  paymentReceived?: number | null;
  checkDate?: Date | null;
  checkNumberVirtualCard?: string | null;
  dateReceived?: Date | null;
  dateOfAppeal?: Date | null;
  referenceNo?: string | null;
  lmn?: string | null;
}): Promise<string> {
  const { data: row, error } = await supabase
    .from("claims_records")
    .insert({
      patient_id: data.patientId,
      auth_period: data.authPeriod,
      place_of_service: data.placeOfService ?? null,
      date_of_service: data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null,
      visit_number: data.visitNumber ?? null,
      cpt_codes: data.cptCodes ?? null,
      units_billed: data.unitsBilled ?? null,
      diagnosis_codes: data.diagnosisCodes ?? null,
      modifier: data.modifier ?? null,
      charge_amount: data.chargeAmount ?? null,
      insurance_reimbursement: data.insuranceReimbursement ?? null,
      patient_amount_paid: data.patientAmountPaid ?? null,
      patient_amount_due: data.patientAmountDue ?? null,
      insurance_billed: data.insuranceBilled ?? null,
      oa_claim_number: data.oaClaimNumber ?? null,
      claim_submitted_date: data.claimSubmittedDate ? data.claimSubmittedDate.toISOString().split("T")[0] : null,
      expire_bcbs_claim_number: data.expireBcbsClaimNumber ?? null,
      claim_status: data.claimStatus ?? "submitted",
      payment_received: data.paymentReceived ?? null,
      check_date: data.checkDate ? data.checkDate.toISOString().split("T")[0] : null,
      check_number_virtual_card: data.checkNumberVirtualCard ?? null,
      date_received: data.dateReceived ? data.dateReceived.toISOString().split("T")[0] : null,
      date_of_appeal: data.dateOfAppeal ? data.dateOfAppeal.toISOString().split("T")[0] : null,
      reference_no: data.referenceNo ?? null,
      lmn: data.lmn ?? null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[Supabase] createClaimRecord:", error);
    throw error;
  }
  return (row as { id: string }).id;
}

export async function updateClaimRecord(
  id: string,
  data: {
    placeOfService?: string | null;
    dateOfService?: Date | null;
    visitNumber?: number | null;
    cptCodes?: string | null;
    unitsBilled?: number | null;
    diagnosisCodes?: string | null;
    modifier?: string | null;
    chargeAmount?: number | null;
    insuranceReimbursement?: number | null;
    patientAmountPaid?: number | null;
    patientAmountDue?: number | null;
    insuranceBilled?: string | null;
    oaClaimNumber?: string | null;
    claimSubmittedDate?: Date | null;
    expireBcbsClaimNumber?: string | null;
    claimStatus?: 'submitted' | 'approved' | 'pending' | 'denied' | 'pended' | 'rejected' | 'resubmitted';
    paymentReceived?: number | null;
    checkDate?: Date | null;
    checkNumberVirtualCard?: string | null;
    dateReceived?: Date | null;
    dateOfAppeal?: Date | null;
    referenceNo?: string | null;
  }
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (data.placeOfService !== undefined) update.place_of_service = data.placeOfService;
  if (data.dateOfService !== undefined) {
    update.date_of_service = data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null;
  }
  if (data.visitNumber !== undefined) update.visit_number = data.visitNumber;
  if (data.cptCodes !== undefined) update.cpt_codes = data.cptCodes;
  if (data.unitsBilled !== undefined) update.units_billed = data.unitsBilled;
  if (data.diagnosisCodes !== undefined) update.diagnosis_codes = data.diagnosisCodes;
  if (data.modifier !== undefined) update.modifier = data.modifier;
  if (data.chargeAmount !== undefined) update.charge_amount = data.chargeAmount;
  if (data.insuranceReimbursement !== undefined) update.insurance_reimbursement = data.insuranceReimbursement;
  if (data.patientAmountPaid !== undefined) update.patient_amount_paid = data.patientAmountPaid;
  if (data.patientAmountDue !== undefined) update.patient_amount_due = data.patientAmountDue;
  if (data.insuranceBilled !== undefined) update.insurance_billed = data.insuranceBilled;
  if (data.oaClaimNumber !== undefined) update.oa_claim_number = data.oaClaimNumber;
  if (data.claimSubmittedDate !== undefined) {
    update.claim_submitted_date = data.claimSubmittedDate ? data.claimSubmittedDate.toISOString().split("T")[0] : null;
  }
  if (data.expireBcbsClaimNumber !== undefined) update.expire_bcbs_claim_number = data.expireBcbsClaimNumber;
  if (data.claimStatus !== undefined) update.claim_status = data.claimStatus;
  if (data.paymentReceived !== undefined) update.payment_received = data.paymentReceived;
  if (data.checkDate !== undefined) {
    update.check_date = data.checkDate ? data.checkDate.toISOString().split("T")[0] : null;
  }
  if (data.checkNumberVirtualCard !== undefined) update.check_number_virtual_card = data.checkNumberVirtualCard;
  if (data.dateReceived !== undefined) {
    update.date_received = data.dateReceived ? data.dateReceived.toISOString().split("T")[0] : null;
  }
  if (data.dateOfAppeal !== undefined) {
    update.date_of_appeal = data.dateOfAppeal ? data.dateOfAppeal.toISOString().split("T")[0] : null;
  }
  if (data.referenceNo !== undefined) update.reference_no = data.referenceNo;

  const { error } = await supabase.from("claims_records").update(update).eq("id", id);
  if (error) {
    console.error("[Supabase] updateClaimRecord:", error);
    throw error;
  }
}

export async function deleteClaimRecord(id: string): Promise<void> {
  const { error } = await supabase.from("claims_records").delete().eq("id", id);
  if (error) {
    console.error("[Supabase] deleteClaimRecord:", error);
    throw error;
  }
}

/**
 * Upsert a claim record by (patient_id, auth_period, date_of_service, cpt_codes).
 *
 * If a matching record already exists, only the non-null fields in `data` are
 * merged into it (existing values are preserved for fields not provided by this
 * upload type).  If no match is found, a new record is inserted.
 *
 * This allows CMS1500 and Reimbursement uploads to populate the same row:
 *   - CMS1500 first → inserts row with CPT/Charge/Diagnosis/DOS
 *   - Reimbursement later → finds that row and patches Ins.Reimb/Check/EFT
 *   (or vice-versa)
 */
export async function upsertClaimRecord(data: {
  patientId: string;
  authPeriod: number;
  placeOfService?: string | null;
  dateOfService?: Date | null;
  visitNumber?: number | null;
  cptCodes?: string | null;
  unitsBilled?: number | null;
  diagnosisCodes?: string | null;
  modifier?: string | null;
  chargeAmount?: number | null;
  insuranceReimbursement?: number | null;
  patientAmountPaid?: number | null;
  patientAmountDue?: number | null;
  insuranceBilled?: string | null;
  oaClaimNumber?: string | null;
  claimSubmittedDate?: Date | null;
  expireBcbsClaimNumber?: string | null;
  claimStatus?: 'submitted' | 'approved' | 'pending' | 'denied' | 'pended' | 'rejected' | 'resubmitted';
  paymentReceived?: number | null;
  checkDate?: Date | null;
  checkNumberVirtualCard?: string | null;
  dateReceived?: Date | null;
  dateOfAppeal?: Date | null;
  referenceNo?: string | null;
  lmn?: string | null;
}): Promise<string> {
  const dosStr = data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null;

  // Try to find an existing record matching patient + auth_period + date_of_service + cpt_codes
  // (null cpt_codes is treated as a wildcard match only when both sides are null)
  let existingId: string | null = null;
  if (dosStr) {
    let query = supabase
      .from("claims_records")
      .select("id")
      .eq("patient_id", data.patientId)
      .eq("auth_period", data.authPeriod)
      .eq("date_of_service", dosStr);

    if (data.cptCodes) {
      query = query.eq("cpt_codes", data.cptCodes);
    } else {
      query = query.is("cpt_codes", null);
    }

    const { data: existing } = await query.maybeSingle();
    existingId = existing ? (existing as { id: string }).id : null;
  }

  if (existingId) {
    // Patch only the non-null fields provided by this upload
    const patch: Record<string, unknown> = {};
    if (data.placeOfService != null) patch.place_of_service = data.placeOfService;
    if (data.visitNumber != null) patch.visit_number = data.visitNumber;
    if (data.cptCodes != null) patch.cpt_codes = data.cptCodes;
    if (data.unitsBilled != null) patch.units_billed = data.unitsBilled;
    if (data.diagnosisCodes != null) patch.diagnosis_codes = data.diagnosisCodes;
    if (data.modifier != null) patch.modifier = data.modifier;
    if (data.chargeAmount != null) patch.charge_amount = data.chargeAmount;
    if (data.insuranceReimbursement != null) patch.insurance_reimbursement = data.insuranceReimbursement;
    if (data.patientAmountPaid != null) patch.patient_amount_paid = data.patientAmountPaid;
    if (data.patientAmountDue != null) patch.patient_amount_due = data.patientAmountDue;
    if (data.insuranceBilled != null) patch.insurance_billed = data.insuranceBilled;
    if (data.oaClaimNumber != null) patch.oa_claim_number = data.oaClaimNumber;
    if (data.claimSubmittedDate != null) patch.claim_submitted_date = data.claimSubmittedDate.toISOString().split("T")[0];
    if (data.expireBcbsClaimNumber != null) patch.expire_bcbs_claim_number = data.expireBcbsClaimNumber;
    if (data.claimStatus != null) patch.claim_status = data.claimStatus;
    if (data.paymentReceived != null) patch.payment_received = data.paymentReceived;
    if (data.checkDate != null) patch.check_date = data.checkDate.toISOString().split("T")[0];
    if (data.checkNumberVirtualCard != null) patch.check_number_virtual_card = data.checkNumberVirtualCard;
    if (data.dateReceived != null) patch.date_received = data.dateReceived.toISOString().split("T")[0];
    if (data.dateOfAppeal != null) patch.date_of_appeal = data.dateOfAppeal.toISOString().split("T")[0];
    if (data.referenceNo != null) patch.reference_no = data.referenceNo;
    if (data.lmn != null) patch.lmn = data.lmn;

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from("claims_records").update(patch).eq("id", existingId);
      if (error) {
        console.error("[Supabase] upsertClaimRecord (update):", error);
        throw error;
      }
    }
    return existingId;
  }

  // No existing record — insert a new one
  return createClaimRecord(data);
}
