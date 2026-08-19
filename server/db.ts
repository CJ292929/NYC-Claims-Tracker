/**
 * server/db.ts — All database helpers, backed by Supabase PostgreSQL.
 *
 * Supabase returns snake_case column names. This module converts them to
 * camelCase to match the types in drizzle/schema.ts and the rest of the app.
 */

import { supabase } from "./supabase";
import { ENV } from "./_core/env";
import type { User, Patient, VisitRecord, ClinicUser, InsertVisitRecord } from "../drizzle/schema";

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
    createdAt: new Date(row.created_at),
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
      };
    }

    const allPeriods = Array.from(new Set(pVisits.map(v => v.authPeriod ?? 1))).sort((a, b) => a - b);

    let activePeriod: number | null = null;
    for (const period of allPeriods) {
      const periodVisits = pVisits.filter(v => (v.authPeriod ?? 1) === period);
      const authRow = periodVisits.find(v => v.sessionsAuthorized != null);
      const periodAuthorized = authRow?.sessionsAuthorized ?? 0;
      const periodCompleted = periodVisits.filter(v => v.dateOfService != null).length;
      const periodRemaining = Math.max(0, periodAuthorized - periodCompleted);
      if (periodRemaining > 0) { activePeriod = period; break; }
    }

    const latestPeriod = allPeriods[allPeriods.length - 1];
    const targetPeriod = activePeriod ?? latestPeriod;
    const targetVisits = pVisits.filter(v => (v.authPeriod ?? 1) === targetPeriod);

    const authRow = targetVisits.find(v => v.sessionsAuthorized != null);
    const sessionsAuthorized = authRow?.sessionsAuthorized ?? null;
    const completed = targetVisits.filter(v => v.dateOfService != null).length;
    const sessionsRemaining = activePeriod !== null
      ? Math.max(0, (sessionsAuthorized ?? 0) - completed)
      : 0;

    const lastActiveRow = targetVisits[targetVisits.length - 1];
    const authStatus = lastActiveRow?.authStatus ?? "none";
    const dateAshSubmitted = lastActiveRow?.dateAshSubmitted ?? null;

    let urgency: "exhausted" | "critical" | "warning" | "pending" | "ok" = "ok";
    if (sessionsRemaining === 0) urgency = "exhausted";
    else if (sessionsRemaining <= 2) urgency = "critical";
    else if (sessionsRemaining <= 3) urgency = "warning";
    if (authStatus === "pending" && urgency === "ok") urgency = "pending";
    if (authStatus === "denied") urgency = "exhausted";

    // Check if auth expires within 7 days
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const authValidUntil = patient.authValidUntil ?? null;
    const expiresWithin7Days = authValidUntil !== null && authValidUntil > now && authValidUntil - now <= sevenDaysMs;
    const alreadyExpired = authValidUntil !== null && authValidUntil < now;
    // authExpiryWarning = true means the warning is ONLY because of expiry date, not session count
    const authExpiryWarning = (expiresWithin7Days || alreadyExpired) && urgency === "ok";
    if (authExpiryWarning) urgency = "warning";

    return {
      patientId: patient.id, patientName: patient.name, insurance: patient.insurance,
      sessionsAuthorized, sessionsRemaining, authStatus,
      dateAshSubmitted: dateAshSubmitted instanceof Date
        ? dateAshSubmitted.toISOString().split('T')[0]
        : dateAshSubmitted,
      urgency,
      authValidUntil,
      authExpiryWarning,
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
  const periods = Array.from(new Set(visits.map(v => v.auth_period ?? 1))).sort((a, b) => a - b);
  for (const period of periods) {
    const periodVisits = visits.filter(v => (v.auth_period ?? 1) === period);
    const authRow = periodVisits.find(v => v.sessions_authorized != null);
    const periodAuthorized = authRow?.sessions_authorized ?? 0;
    const periodCompleted = periodVisits.filter(v => v.date_of_service != null).length;
    const periodRemaining = Math.max(0, periodAuthorized - periodCompleted);
    if (periodRemaining > 0) return period;
  }
  return null;
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
    .select("id, patient_id, date_of_service, sessions_remaining, auth_period, session_number");

  if (vErr) { console.error("[Supabase] getCompletedPatients visits:", vErr); return []; }
  const visits = (allVisits ?? []) as {
    id: string; patient_id: string; date_of_service: string | null;
    sessions_remaining: number | null; auth_period: number; session_number: number | null;
  }[];

  return (allPatients as { id: string }[])
    .filter(patient => {
      const pVisits = visits.filter(v => v.patient_id === patient.id);
      if (pVisits.length === 0) return false;

      const sorted = [...pVisits].sort((a, b) => {
        const pd = (a.auth_period ?? 1) - (b.auth_period ?? 1);
        if (pd !== 0) return pd;
        return (a.session_number ?? 0) - (b.session_number ?? 0);
      });
      const latest = sorted[sorted.length - 1];
      if (latest.sessions_remaining !== 0) return false;
      return pVisits.every(v => v.date_of_service != null);
    })
    .map(p => p.id);
}

// ─── Clinic user helpers ──────────────────────────────────────────────────────

export async function getClinicUserByUsername(username: string): Promise<ClinicUser | undefined> {
  const { data, error } = await supabase
    .from("clinic_users")
    .select("*")
    .eq("username", username)
    .maybeSingle();

  if (error) {
    console.error("[Supabase] getClinicUserByUsername:", error);
    return undefined;
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
