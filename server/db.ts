/**
 * server/db.ts — All database helpers, backed by Supabase PostgreSQL.
 *
 * Supabase returns snake_case column names. This module converts them to
 * camelCase to match the types in drizzle/schema.ts and the rest of the app.
 */

import { supabase } from "./supabase";
import { ENV } from "./_core/env";
import { normalizeUsername, escapeLikePattern } from "./_core/username";
import type { User, Patient, VisitRecord, ClinicUser, InsertVisitRecord, InsurerCatalogEntry } from "../drizzle/schema";
import { determineActivePeriod, deriveAuthPeriodMetrics, getPeriodMetrics } from "@shared/authPeriodMetrics";
import { deriveAuthorizationUrgency } from "@shared/authUrgency";
import type { DismissedEobLine, ExistingClaimLine, SavedDocumentLine } from "@shared/claimImport";
import type { ActorContext } from "./actorIdentity";

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
    totalInsuranceReimbursement: row.total_insurance_reimbursement ?? null,
    totalPatientDue: row.total_patient_due ?? null,
    totalPatientPaid: row.total_patient_paid ?? null,
    assignmentOfBenefits: row.assignment_of_benefits ?? null,
    submissionStatus: row.submission_status ?? null,
    remarks: row.remarks ?? null,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toInsurerCatalogEntry(row: any): InsurerCatalogEntry {
  return {
    id: row.id,
    name: row.name,
    aliases: row.aliases ?? [],
    createdAt: new Date(row.created_at),
    isActive: row.is_active ?? true,
    deactivatedAt: row.deactivated_at ? new Date(row.deactivated_at) : null,
    reactivatedAt: row.reactivated_at ? new Date(row.reactivated_at) : null,
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

/** Atomically inserts the patient row and its PATIENT_CREATE audit_logs
 * entry via write_patient_with_audit (see the P4-P17 migration) — one
 * Postgres transaction, so there's no window where the row exists without
 * its creation being attributed. isActive/discharge fields are deliberately
 * not part of this payload — those flow through setPatientActive, which
 * covers its own distinct semantics (discharge date/reason) and is out of
 * scope for this audit path. */
export async function createPatient(
  data: {
    name: string;
    insurance?: string;
    authDate?: Date | null;
    authValidUntil?: number | null;
  },
  actor: ActorContext
): Promise<string> {
  const payload: Record<string, unknown> = { name: data.name };
  if (data.insurance !== undefined) payload.insurance = data.insurance;
  if (data.authDate !== undefined) {
    payload.auth_date = data.authDate ? data.authDate.toISOString().split("T")[0] : null;
  }
  if (data.authValidUntil !== undefined) payload.auth_valid_until = data.authValidUntil ?? null;

  const { data: id, error } = await supabase.rpc("write_patient_with_audit", {
    p_id: null,
    p_data: payload,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: "PATIENT_CREATE",
  });

  if (error) {
    console.error("[Supabase] createPatient:", error);
    mapInsurerAssignmentError(error);
    throw error;
  }
  return id as string;
}

/** Atomically patches the patient row and writes a PATIENT_UPDATE audit_logs
 * entry (only for the fields actually present in `data` AND whose value
 * actually changed — see write_patient_with_audit) in one transaction.
 * claimsStatus=null is an explicit clear (the API-level "none" sentinel is
 * translated to null by the caller before this point); isActive is not
 * handled here — see createPatient's note above. */
export async function updatePatient(
  id: string,
  data: { name?: string; insurance?: string; authDate?: Date | null; authValidUntil?: number | null; claimsStatus?: 'submitted' | 'approved' | 'pending' | 'denied' | 'pended' | 'rejected' | 'resubmitted' | null },
  actor: ActorContext
): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (data.name !== undefined) payload.name = data.name;
  if (data.insurance !== undefined) payload.insurance = data.insurance;
  if (data.authDate !== undefined) {
    payload.auth_date = data.authDate ? data.authDate.toISOString().split("T")[0] : null;
  }
  if (data.authValidUntil !== undefined) payload.auth_valid_until = data.authValidUntil ?? null;
  if (data.claimsStatus !== undefined) payload.claims_status = data.claimsStatus;

  if (Object.keys(payload).length === 0) return;

  const { error } = await supabase.rpc("write_patient_with_audit", {
    p_id: id,
    p_data: payload,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: "PATIENT_UPDATE",
  });
  if (error) {
    console.error("[Supabase] updatePatient:", error);
    mapInsurerAssignmentError(error);
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

export type AuditLogRow = {
  id: string;
  entityType: string | null;
  entityId: string | null;
  patientId: string | null;
  actorId: string | null;
  actorType: "clinic_user" | "owner" | null;
  actorDisplay: string | null;
  action: string;
  beforeData: Record<string, unknown> | null;
  afterData: Record<string, unknown> | null;
  importBatchId: string | null;
  createdAt: Date;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toAuditLogRow(row: any): AuditLogRow {
  return {
    id: row.id,
    entityType: row.entity_type ?? null,
    entityId: row.entity_id ?? null,
    patientId: row.patient_id ?? null,
    actorId: row.actor_id ?? null,
    actorType: row.actor_type ?? null,
    actorDisplay: row.actor_display ?? null,
    action: row.action,
    beforeData: row.before_data ?? null,
    afterData: row.after_data ?? null,
    importBatchId: row.import_batch_id ?? null,
    createdAt: new Date(row.created_at),
  };
}

/** History for one record (any entity_type/entity_id pair), newest first.
 * Callers are responsible for their own access check — patients/visits/
 * claims history is reachable by any authenticated staff member (the same
 * data-access model the records themselves already use); clinic_user
 * history is restricted to adminOrOwnerProcedure at the router layer since
 * it covers account management actions. */
export async function listHistoryForEntity(entityType: string, entityId: string): Promise<AuditLogRow[]> {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("*")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[Supabase] listHistoryForEntity:", error);
    throw error;
  }
  return (data ?? []).map(toAuditLogRow);
}

/** Paginated, filterable activity feed across every entity type — backs the
 * admin/owner Activity Log page. adminOrOwnerProcedure-gated at the router
 * layer (see routers.ts activityLog.list); this function itself does no
 * authorization, matching the pattern of every other exported helper here
 * (callers are the single enforcement point). */
export async function listActivityLog(filters: {
  actorId?: string | null;
  entityType?: string | null;
  action?: string | null;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  page: number;
  pageSize: number;
  /** P4-P23: drop claim audit rows (entity_type claim_record, or a legacy
   *  CLAIM* action with no entity_type) in the query itself so pagination
   *  totals stay accurate for non-Super-Admin callers. */
  excludeClaims?: boolean;
}): Promise<{ rows: AuditLogRow[]; total: number }> {
  let query = supabase.from("audit_logs").select("*", { count: "exact" });

  if (filters.excludeClaims) {
    // entity_type is NULL on legacy rows, and NULL <> 'claim_record' is NULL
    // (not true) in SQL — so NULL must be allowed explicitly.
    // Same sets as isClaimAuditRow in server/claimsRedaction.ts.
    query = query
      .or("entity_type.is.null,entity_type.not.in.(claim_record,pending_eob_line)")
      .not("action", "ilike", "CLAIM%")
      .not("action", "ilike", "EOB_LINE%")
      .not("action", "ilike", "PATIENT_EXTERNAL_ID%");
  }

  if (filters.actorId) query = query.eq("actor_id", filters.actorId);
  if (filters.entityType) query = query.eq("entity_type", filters.entityType);
  if (filters.action) query = query.eq("action", filters.action);
  if (filters.dateFrom) query = query.gte("created_at", filters.dateFrom.toISOString());
  if (filters.dateTo) query = query.lte("created_at", filters.dateTo.toISOString());

  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    console.error("[Supabase] listActivityLog:", error);
    throw error;
  }
  return { rows: (data ?? []).map(toAuditLogRow), total: count ?? 0 };
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

export async function getVisitRecordById(id: string): Promise<VisitRecord | undefined> {
  const { data, error } = await supabase
    .from("visit_records")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[Supabase] getVisitRecordById:", error);
    throw error;
  }
  return data ? toVisitRecord(data) : undefined;
}

/** Atomically inserts a single visit_records row and its VISIT_RECORD_CREATE
 * (or caller-supplied action) audit_logs entry via write_visit_record_with_audit
 * (P4-P17R) — one Postgres transaction. Not used by bulkCreateVisitRecords,
 * which deliberately stays stamp-only (see that function's comment). */
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
  totalInsuranceReimbursement?: number | null;
  totalPatientDue?: number | null;
  totalPatientPaid?: number | null;
}, actor: ActorContext, action = "VISIT_RECORD_CREATE"): Promise<string> {
  const payload: Record<string, unknown> = {
    sessions_authorized: data.sessionsAuthorized ?? null,
    sessions_remaining: data.sessionsRemaining ?? null,
    session_number: data.sessionNumber ?? null,
    auth_period: data.authPeriod ?? 1,
    date_of_service: data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null,
    new_auth: data.newAuth ?? null,
    date_ash_submitted: data.dateAshSubmitted ? data.dateAshSubmitted.toISOString().split("T")[0] : null,
    auth_status: data.authStatus ?? "none",
    total_insurance_reimbursement: data.totalInsuranceReimbursement ?? null,
    total_patient_due: data.totalPatientDue ?? null,
    total_patient_paid: data.totalPatientPaid ?? null,
  };

  const { data: id, error } = await supabase.rpc("write_visit_record_with_audit", {
    p_id: null,
    p_patient_id: data.patientId,
    p_data: payload,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: action,
  });

  if (error) {
    console.error("[Supabase] createVisitRecord:", error);
    throw error;
  }
  return id as string;
}

/** Atomically patches a single visit_records row and writes its audit_logs
 * entry (only for fields actually present AND changed — see
 * write_visit_record_with_audit) in one transaction via the P4-P17R RPC.
 * `action` lets callers distinguish a plain edit (VISIT_RECORD_UPDATE,
 * the default) from a named authorization action like marking a period
 * requested. */
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
    totalInsuranceReimbursement?: number | null;
    totalPatientDue?: number | null;
    totalPatientPaid?: number | null;
    assignmentOfBenefits?: "yes" | "no" | null;
    submissionStatus?: "ready_to_file" | "hold" | "do_not_file" | null;
    remarks?: string | null;
  },
  actor: ActorContext,
  options?: { action?: string; patientId?: string }
): Promise<void> {
  const action = options?.action ?? "VISIT_RECORD_UPDATE";
  const payload: Record<string, unknown> = {};
  if (data.sessionsAuthorized !== undefined) payload.sessions_authorized = data.sessionsAuthorized;
  if (data.sessionsRemaining !== undefined) payload.sessions_remaining = data.sessionsRemaining;
  if (data.sessionNumber !== undefined) payload.session_number = data.sessionNumber;
  if (data.authPeriod !== undefined) payload.auth_period = data.authPeriod;
  if (data.dateOfService !== undefined) {
    payload.date_of_service = data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null;
  }
  if (data.newAuth !== undefined) payload.new_auth = data.newAuth;
  if (data.dateAshSubmitted !== undefined) {
    payload.date_ash_submitted = data.dateAshSubmitted ? data.dateAshSubmitted.toISOString().split("T")[0] : null;
  }
  if (data.authStatus !== undefined) payload.auth_status = data.authStatus;
  if (data.totalInsuranceReimbursement !== undefined) payload.total_insurance_reimbursement = data.totalInsuranceReimbursement;
  if (data.totalPatientDue !== undefined) payload.total_patient_due = data.totalPatientDue;
  if (data.totalPatientPaid !== undefined) payload.total_patient_paid = data.totalPatientPaid;
  if (data.assignmentOfBenefits !== undefined) payload.assignment_of_benefits = data.assignmentOfBenefits;
  if (data.submissionStatus !== undefined) payload.submission_status = data.submissionStatus;
  if (data.remarks !== undefined) payload.remarks = data.remarks;

  if (Object.keys(payload).length === 0) return;

  const { error } = await supabase.rpc("write_visit_record_with_audit", {
    p_id: id,
    p_patient_id: options?.patientId ?? null,
    p_data: payload,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: action,
  });
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
  }>,
  actor?: ActorContext
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
    ...(actor ? { created_by: actor.actorId, created_by_type: actor.actorType, updated_by: actor.actorId, updated_by_type: actor.actorType } : {}),
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

/** Approves the active authorization period and creates the next batch of
 * visit session rows. The read-only "which period is active" business rule
 * (determineActiveAuthPeriod, shared with getAuthAlertSummaries) stays in
 * the application layer here — duplicating it in plpgsql would risk the two
 * implementations silently drifting apart. Everything that WRITES (mark
 * approved, patch patient, insert the new batch, and the audit entry) now
 * happens in one Postgres transaction via approve_authorization_with_audit
 * (P4-P17R), which re-validates the target period against the patient's
 * actual visit_records under row locks rather than trusting this
 * resolution blindly, and recomputes the next period itself. This closes
 * the "crash mid-way leaves a partially-applied approval" gap the sequential
 * version had. */
export async function approveAndCreateNewBatch(
  patientId: string,
  sessionsAuthorized: number,
  authDate: Date | null,
  newInsurance: string | undefined,
  authValidUntil: number | null | undefined,
  actor: ActorContext,
): Promise<{ newVisitIds: string[] }> {
  // Determine which existing authorization period the approval applies to
  // (read-only — safe to resolve before the atomic write below).
  const { data: periodStatusRows, error: periodStatusErr } = await supabase
    .from("visit_records")
    .select("auth_period, sessions_authorized, date_of_service")
    .eq("patient_id", patientId);

  if (periodStatusErr) { console.error("[Supabase] approveAndCreateNewBatch periodStatus:", periodStatusErr); throw periodStatusErr; }

  const statusRows = (periodStatusRows ?? []) as { auth_period: number | null; sessions_authorized: number | null; date_of_service: string | null }[];
  const statusPeriods = Array.from(new Set(statusRows.map(r => r.auth_period ?? 1))).sort((a, b) => a - b);
  const latestStatusPeriod = statusPeriods.length > 0 ? statusPeriods[statusPeriods.length - 1] : 1;
  const targetApprovalPeriod = determineActiveAuthPeriod(statusRows) ?? latestStatusPeriod;

  const { data: newVisitIds, error } = await supabase.rpc("approve_authorization_with_audit", {
    p_patient_id: patientId,
    p_target_period: targetApprovalPeriod,
    p_sessions_authorized: sessionsAuthorized,
    p_auth_date: authDate ? authDate.toISOString().split("T")[0] : null,
    p_new_insurance: newInsurance ?? null,
    p_auth_valid_until_provided: authValidUntil !== undefined,
    p_auth_valid_until: authValidUntil ?? null,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
  });

  if (error) {
    console.error("[Supabase] approveAndCreateNewBatch:", error);
    throw error;
  }

  return { newVisitIds: (newVisitIds ?? []) as string[] };
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

/** Thrown by update_clinic_user_role_with_audit / archive_clinic_user_with_audit
 * when the action would leave zero active admin clinic_users — the account
 * management surface must always keep at least one active account manager,
 * independent of who's performing the action. */
export class LastActiveAccountManagerError extends Error {
  constructor() {
    super("This is the only active admin account — it cannot be demoted or deactivated.");
    this.name = "LastActiveAccountManagerError";
  }
}

/** Thrown when a CAS-guarded clinic_users mutation's expectedTokenVersion no
 * longer matches the row (a concurrent change already moved it). Callers map
 * this to "please refresh and try again" rather than a generic failure. */
export class ClinicUserConflictError extends Error {
  constructor(id: string) {
    super(`Staff account ${id} changed during this request`);
    this.name = "ClinicUserConflictError";
  }
}

function mapClinicUserRpcError(error: { code?: string; message?: string }, id: string): never {
  if (error.code === "P0021" || error.code === "P0022") throw new ClinicUserConflictError(id);
  if (error.code === "P0023") throw new LastActiveAccountManagerError();
  throw error;
}

/** Atomically inserts the clinic_users row and its ACCOUNT_CREATE audit_logs
 * entry via create_clinic_user_with_audit (P4-P17 migration). */
export async function createClinicUser(
  data: {
    username: string;
    passwordHash: string;
    name: string;
    email: string | null;
    department: string | null;
    role: "admin" | "staff";
    status: "active" | "archived";
  },
  actor: ActorContext
): Promise<ClinicUser> {
  const { data: id, error } = await supabase.rpc("create_clinic_user_with_audit", {
    p_username: data.username,
    p_password_hash: data.passwordHash,
    p_name: data.name,
    p_email: data.email,
    p_department: data.department,
    p_role: data.role,
    p_status: data.status,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
  });

  if (error) {
    console.error("[Supabase] createClinicUser:", error);
    throw error;
  }

  const created = await getClinicUserById(id as string);
  if (!created) throw new Error("createClinicUser: row not found immediately after insert");
  return created;
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
/** Role changes a session's effective permissions, so token_version is
 * bumped (CAS-guarded) to invalidate any already-issued session carrying the
 * stale role. Atomically writes the ACCOUNT_ROLE_CHANGE audit entry in the
 * same transaction, and rejects (LastActiveAccountManagerError) a demotion
 * that would leave zero active admins — see
 * update_clinic_user_role_with_audit in the P4-P17 migration. */
export async function updateClinicUserRole(
  params: { id: string; role: "admin" | "staff"; expectedTokenVersion: number },
  actor: ActorContext
): Promise<ClinicUser | undefined> {
  const { error } = await supabase.rpc("update_clinic_user_role_with_audit", {
    p_id: params.id,
    p_role: params.role,
    p_expected_token_version: params.expectedTokenVersion,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
  });

  if (error) {
    console.error("[Supabase] updateClinicUserRole:", error);
    mapClinicUserRpcError(error, params.id);
  }
  return getClinicUserById(params.id);
}

/** Admin-initiated "Reset Login": unlike changeClinicUserPassword (self-service,
 * clears must_change_password), this always sets must_change_password=true so
 * the temporary password forces a change on next login. The audit entry this
 * writes carries no before/after payload — never the hash, never any
 * credential-shaped value, only that a reset happened (see
 * admin_reset_clinic_user_password_with_audit). */
export async function adminResetClinicUserPassword(
  params: { id: string; passwordHash: string; expectedTokenVersion: number },
  actor: ActorContext
): Promise<ClinicUser | undefined> {
  const { error } = await supabase.rpc("admin_reset_clinic_user_password_with_audit", {
    p_id: params.id,
    p_password_hash: params.passwordHash,
    p_expected_token_version: params.expectedTokenVersion,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
  });

  if (error) {
    console.error("[Supabase] adminResetClinicUserPassword:", error);
    mapClinicUserRpcError(error, params.id);
  }
  return getClinicUserById(params.id);
}

/** Soft-delete: status -> archived, stamps archived_at, and bumps
 * token_version so any session already issued for this account is rejected
 * on its very next request. The row itself is never removed. Rejects
 * (LastActiveAccountManagerError) archiving the last active admin — see
 * archive_clinic_user_with_audit in the P4-P17 migration. */
export async function archiveClinicUser(
  params: { id: string; expectedTokenVersion: number },
  actor: ActorContext
): Promise<ClinicUser | undefined> {
  const { error } = await supabase.rpc("archive_clinic_user_with_audit", {
    p_id: params.id,
    p_expected_token_version: params.expectedTokenVersion,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
  });

  if (error) {
    console.error("[Supabase] archiveClinicUser:", error);
    mapClinicUserRpcError(error, params.id);
  }
  return getClinicUserById(params.id);
}

/** Reverses archive. No token_version bump — an archived account has no
 * valid session left to invalidate (archiving already bumped it), and no
 * password reset — a reactivated account's existing password stays in
 * effect unless an admin explicitly runs Reset Login afterward. */
export async function reactivateClinicUser(id: string, actor: ActorContext): Promise<ClinicUser | undefined> {
  const { error } = await supabase.rpc("reactivate_clinic_user_with_audit", {
    p_id: id,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
  });

  if (error) {
    console.error("[Supabase] reactivateClinicUser:", error);
    mapClinicUserRpcError(error, id);
  }
  return getClinicUserById(id);
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

type ClaimRecordFields = {
  patientId?: string;
  authPeriod?: number;
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
  claimStatus?: 'submitted' | 'approved' | 'pending' | 'denied' | 'pended' | 'rejected' | 'resubmitted' | 'needs_review';
  paymentReceived?: number | null;
  checkDate?: Date | null;
  checkNumberVirtualCard?: string | null;
  dateReceived?: Date | null;
  dateOfAppeal?: Date | null;
  referenceNo?: string | null;
  lmn?: string | null;
  sourceLineIndex?: number | null;
};

const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().split("T")[0] : null);

/** Maps the camelCase claim fields this module's callers already use onto
 * the snake_case keys write_claim_record_with_audit's p_data jsonb expects,
 * including ONLY keys actually present on `data` (not just non-null) — this
 * preserves createClaimRecord's "always write every column" behavior and
 * updateClaimRecord's "only patch fields explicitly
 * provided" behavior, matching exactly what each call site passed in before
 * this was centralized through the shared RPC. */
function claimFieldsToPayload(data: ClaimRecordFields): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (data.authPeriod !== undefined) payload.auth_period = data.authPeriod;
  if (data.placeOfService !== undefined) payload.place_of_service = data.placeOfService;
  if (data.dateOfService !== undefined) payload.date_of_service = dateOnly(data.dateOfService);
  if (data.visitNumber !== undefined) payload.visit_number = data.visitNumber;
  if (data.cptCodes !== undefined) payload.cpt_codes = data.cptCodes;
  if (data.unitsBilled !== undefined) payload.units_billed = data.unitsBilled;
  if (data.diagnosisCodes !== undefined) payload.diagnosis_codes = data.diagnosisCodes;
  if (data.modifier !== undefined) payload.modifier = data.modifier;
  if (data.chargeAmount !== undefined) payload.charge_amount = data.chargeAmount;
  if (data.insuranceReimbursement !== undefined) payload.insurance_reimbursement = data.insuranceReimbursement;
  if (data.patientAmountPaid !== undefined) payload.patient_amount_paid = data.patientAmountPaid;
  if (data.patientAmountDue !== undefined) payload.patient_amount_due = data.patientAmountDue;
  if (data.insuranceBilled !== undefined) payload.insurance_billed = data.insuranceBilled;
  if (data.oaClaimNumber !== undefined) payload.oa_claim_number = data.oaClaimNumber;
  if (data.claimSubmittedDate !== undefined) payload.claim_submitted_date = dateOnly(data.claimSubmittedDate);
  if (data.expireBcbsClaimNumber !== undefined) payload.expire_bcbs_claim_number = data.expireBcbsClaimNumber;
  if (data.claimStatus !== undefined) payload.claim_status = data.claimStatus;
  if (data.paymentReceived !== undefined) payload.payment_received = data.paymentReceived;
  if (data.checkDate !== undefined) payload.check_date = dateOnly(data.checkDate);
  if (data.checkNumberVirtualCard !== undefined) payload.check_number_virtual_card = data.checkNumberVirtualCard;
  if (data.dateReceived !== undefined) payload.date_received = dateOnly(data.dateReceived);
  if (data.dateOfAppeal !== undefined) payload.date_of_appeal = dateOnly(data.dateOfAppeal);
  if (data.referenceNo !== undefined) payload.reference_no = data.referenceNo;
  if (data.lmn !== undefined) payload.lmn = data.lmn;
  if (data.sourceLineIndex !== undefined) payload.source_line_index = data.sourceLineIndex;
  return payload;
}

/** Inserts-or-patches one claims_records row and its audit_logs entry in a
 * single Postgres transaction via write_claim_record_with_audit (see the
 * P4-P17 migration) — the shared write path for claims.create/update/upsert,
 * CMS1500 enrichment, and both bulk-import flows, so every one of those gets
 * the same atomicity and the same "skip the audit row on a true no-op"
 * behavior. Returns the row id (new or existing). */
async function writeClaimRecordWithAudit(params: {
  id: string | null;
  patientId: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
  action: string;
  importBatchId?: string | null;
}): Promise<string> {
  const { data: id, error } = await supabase.rpc("write_claim_record_with_audit", {
    p_id: params.id,
    p_patient_id: params.patientId,
    p_data: params.payload,
    p_actor_id: params.actor.actorId,
    p_actor_type: params.actor.actorType,
    p_actor_display: params.actor.actorDisplay,
    p_action: params.action,
    p_import_batch_id: params.importBatchId ?? null,
  });

  if (error) {
    console.error("[Supabase] writeClaimRecordWithAudit:", error);
    if ((error as { code?: string }).code === "P0010") throw new ClaimRecordNotFoundError(params.id ?? "");
    if ((error as { code?: string }).code === "P0011") throw new ClaimRecordPatientMismatchError(params.id ?? "", params.patientId);
    throw error;
  }
  return id as string;
}

export async function createClaimRecord(
  data: ClaimRecordFields & { patientId: string; authPeriod: number },
  actor: ActorContext,
  importBatchId?: string | null
): Promise<string> {
  const payload = claimFieldsToPayload(data);
  // claim_status always has an explicit value on create, matching the prior
  // direct-insert behavior's `data.claimStatus ?? "submitted"` default.
  payload.claim_status = data.claimStatus ?? "submitted";
  return writeClaimRecordWithAudit({
    id: null,
    patientId: data.patientId,
    payload,
    actor,
    action: "CLAIM_RECORD_CREATE",
    importBatchId,
  });
}

export async function updateClaimRecord(
  id: string,
  data: ClaimRecordFields,
  actor: ActorContext
): Promise<void> {
  const payload = claimFieldsToPayload(data);
  if (Object.keys(payload).length === 0) return;

  // updateClaimRecord's callers (claims.update) only have the claim id, not
  // its patient — look it up so write_claim_record_with_audit's ownership
  // check still has something real to validate against.
  const { data: row, error: lookupErr } = await supabase
    .from("claims_records")
    .select("patient_id")
    .eq("id", id)
    .maybeSingle();
  if (lookupErr) {
    console.error("[Supabase] updateClaimRecord (lookup):", lookupErr);
    throw lookupErr;
  }
  if (!row) throw new ClaimRecordNotFoundError(id);

  await writeClaimRecordWithAudit({
    id,
    patientId: (row as { patient_id: string }).patient_id,
    payload,
    actor,
    action: "CLAIM_RECORD_UPDATE",
  });
}

export class ClaimRecordNotFoundError extends Error {
  constructor(id: string) {
    super(`Claim record ${id} not found`);
    this.name = "ClaimRecordNotFoundError";
  }
}

export class ClaimRecordPatientMismatchError extends Error {
  constructor(id: string, expectedPatientId: string) {
    super(`Claim record ${id} does not belong to patient ${expectedPatientId}`);
    this.name = "ClaimRecordPatientMismatchError";
  }
}

/**
 * Deletes exactly one claims_records row and records its audit_logs entry
 * in a single database transaction via the delete_claim_record_with_audit
 * Postgres function (see
 * supabase/migrations/20261004010000_delete_claim_record_with_audit_fn.sql).
 * The function locks the row, re-validates it exists and belongs to the
 * given patient, then deletes it and inserts the audit row together — any
 * failure (including a mismatch/not-found check) rolls back both writes, so
 * there is never a dangling audit entry for a deletion that didn't happen or
 * a deletion with no audit trail. Only clinical-free identifying data (the
 * claim id) goes into old_value — no charge amounts, diagnosis codes, or
 * other clinical fields.
 */
export async function deleteClaimRecordWithAudit(params: {
  claimId: string;
  patientId: string;
  actorId: string | null;
  actorType?: ActorContext["actorType"] | null;
  actorDisplay?: string | null;
}): Promise<void> {
  const { claimId, patientId, actorId, actorType, actorDisplay } = params;

  const { error } = await supabase.rpc("delete_claim_record_with_audit", {
    p_claim_id: claimId,
    p_patient_id: patientId,
    p_actor_id: actorId,
    p_actor_type: actorType ?? null,
    p_actor_display: actorDisplay ?? null,
  });

  if (error) {
    if ((error as { code?: string }).code === "P0010") {
      throw new ClaimRecordNotFoundError(claimId);
    }
    if ((error as { code?: string }).code === "P0011") {
      throw new ClaimRecordPatientMismatchError(claimId, patientId);
    }
    console.error("[Supabase] deleteClaimRecordWithAudit (rpc):", error);
    throw error;
  }
}

// ─── CMS1500-first import (P4-P24) ──────────────────────────────────────────
// Reads that feed the import preview, and the two audited RPCs that are the
// only write path for imported lines (see
// supabase/migrations/20261026000000_p4_p24_cms1500_first_claim_lines.sql).
// The RPCs re-check every rule the preview shows, so a stale or hand-built
// request cannot create an EOB-first row, cross a patient boundary, or
// apply one payment line twice.

const EXISTING_LINE_COLUMNS = [
  "id", "auth_period", "date_of_service", "cpt_codes", "modifier", "units_billed", "diagnosis_codes",
  "charge_amount", "insurance_reimbursement", "patient_amount_due", "patient_amount_paid", "claim_status",
  "cms1500_document_id", "cms1500_line_key", "eob_document_id", "eob_line_key",
].join(", ");

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Every claim row for this patient on any of the given dates, across all periods. */
export async function listPatientClaimLinesOnDates(patientId: string, dates: string[]): Promise<ExistingClaimLine[]> {
  const unique = Array.from(new Set(dates.filter(Boolean)));
  if (unique.length === 0) return [];
  const { data, error } = await supabase
    .from("claims_records")
    .select(EXISTING_LINE_COLUMNS)
    .eq("patient_id", patientId)
    .in("date_of_service", unique)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    console.error("[Supabase] listPatientClaimLinesOnDates:", error);
    throw error;
  }
  return (data ?? []).map(toExistingClaimLine);
}

function toExistingClaimLine(r: any): ExistingClaimLine {
  return {
    id: r.id,
    authPeriod: r.auth_period,
    dateOfService: r.date_of_service,
    cptCodes: r.cpt_codes,
    modifier: r.modifier,
    unitsBilled: r.units_billed,
    diagnosisCodes: r.diagnosis_codes,
    chargeAmount: numOrNull(r.charge_amount),
    insuranceReimbursement: numOrNull(r.insurance_reimbursement),
    patientAmountDue: numOrNull(r.patient_amount_due),
    patientAmountPaid: numOrNull(r.patient_amount_paid),
    claimStatus: r.claim_status,
    cms1500DocumentId: r.cms1500_document_id ?? null,
    cms1500LineKey: r.cms1500_line_key ?? null,
    eobDocumentId: r.eob_document_id ?? null,
    eobLineKey: r.eob_line_key ?? null,
  };
}

/** Every claim row saved from one CMS1500 document, on any date and for any patient. */
export async function listClaimLinesForDocument(documentId: string): Promise<SavedDocumentLine[]> {
  const { data, error } = await supabase
    .from("claims_records")
    .select(`patient_id, ${EXISTING_LINE_COLUMNS}`)
    .eq("cms1500_document_id", documentId);
  if (error) {
    console.error("[Supabase] listClaimLinesForDocument:", error);
    throw error;
  }
  return (data ?? []).map((r: any) => ({ ...toExistingClaimLine(r), patientId: r.patient_id }));
}

/** The patient's visit rows reduced to (period, date) — input to resolveAuthPeriod. */
export async function listPatientVisitPeriodDates(patientId: string): Promise<Array<{ authPeriod: number; dateOfService: string | null }>> {
  const { data, error } = await supabase
    .from("visit_records")
    .select("auth_period, date_of_service")
    .eq("patient_id", patientId);
  if (error) {
    console.error("[Supabase] listPatientVisitPeriodDates:", error);
    throw error;
  }
  return (data ?? []).map((r: any) => ({ authPeriod: r.auth_period ?? 1, dateOfService: r.date_of_service ?? null }));
}

/** The document row for an uploaded file, if any line from it was ever saved. */
export async function findClaimImportDocumentId(kind: "cms1500" | "eob", sha256: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("claim_import_documents")
    .select("id")
    .eq("document_kind", kind)
    .eq("content_sha256", sha256)
    .maybeSingle();
  if (error) {
    console.error("[Supabase] findClaimImportDocumentId:", error);
    throw error;
  }
  return data ? (data as { id: string }).id : null;
}

export type ClaimImportRpcReason =
  | "not_found" | "patient_mismatch" | "needs_selection" | "cms1500_required" | "already_reconciled"
  | "source_line_already_saved" | "already_has_cms1500" | "incompatible" | "invalid_input" | "existing_financials"
  | "period_required" | "patient_changed" | "external_id_taken" | "pending_not_needed" | "line_dismissed";

const IMPORT_RPC_REASONS: Record<string, ClaimImportRpcReason> = {
  P0010: "not_found",
  P0011: "patient_mismatch",
  P0021: "needs_selection",
  P0022: "cms1500_required",
  P0023: "already_reconciled",
  P0024: "source_line_already_saved",
  P0025: "already_has_cms1500",
  P0026: "incompatible",
  P0027: "invalid_input",
  P0028: "existing_financials",
  P0029: "period_required",
  P0030: "patient_changed",
  P0031: "external_id_taken",
  P0032: "pending_not_needed",
  P0033: "line_dismissed",
};

/** A rule the database refused the line on — a review item, not a crash. */
export class ClaimImportRuleError extends Error {
  constructor(public readonly reason: ClaimImportRpcReason, message: string) {
    super(message);
    this.name = "ClaimImportRuleError";
  }
}

function throwImportRpcError(fn: string, error: { code?: string; message?: string }): never {
  const reason = error.code ? IMPORT_RPC_REASONS[error.code] : undefined;
  if (reason) throw new ClaimImportRuleError(reason, error.message ?? reason);
  console.error(`[Supabase] ${fn}:`, error);
  throw error;
}

export type ClaimImportSource = { sha256: string; fileName: string | null; pageCount: number | null };
export type ClaimImportWriteResult = { status: "created" | "associated" | "updated" | "unchanged" | "saved"; claimId: string; authPeriod: number; documentId: string };

function toWriteResult(data: any): ClaimImportWriteResult {
  return { status: data.status, claimId: data.claim_id, authPeriod: data.auth_period, documentId: data.document_id };
}

export async function commitCms1500Line(params: {
  patientId: string;
  authPeriod: number | null;
  source: ClaimImportSource;
  lineKey: string;
  siblingLineKeys: string[];
  targetClaimId: string | null;
  allowNewDistinct: boolean;
  data: Record<string, unknown>;
  actor: ActorContext;
  importBatchId: string;
}): Promise<ClaimImportWriteResult> {
  const { data, error } = await supabase.rpc("commit_cms1500_line_with_audit", {
    p_patient_id: params.patientId,
    p_auth_period: params.authPeriod,
    p_content_sha256: params.source.sha256,
    p_file_name: params.source.fileName,
    p_page_count: params.source.pageCount,
    p_line_key: params.lineKey,
    p_sibling_line_keys: params.siblingLineKeys,
    p_target_claim_id: params.targetClaimId,
    p_allow_new_distinct: params.allowNewDistinct,
    p_data: params.data,
    p_actor_id: params.actor.actorId,
    p_actor_type: params.actor.actorType,
    p_actor_display: params.actor.actorDisplay,
    p_import_batch_id: params.importBatchId,
  });
  if (error) throwImportRpcError("commitCms1500Line", error as { code?: string; message?: string });
  return toWriteResult(data);
}

export async function applyEobLine(params: {
  patientId: string;
  source: ClaimImportSource;
  lineKey: string;
  targetClaimId: string;
  match: { date_of_service: string; cpt_codes: string };
  confirmReplace: boolean;
  data: Record<string, unknown>;
  actor: ActorContext;
  importBatchId: string;
}): Promise<ClaimImportWriteResult> {
  const { data, error } = await supabase.rpc("apply_eob_line_with_audit", {
    p_patient_id: params.patientId,
    p_content_sha256: params.source.sha256,
    p_file_name: params.source.fileName,
    p_page_count: params.source.pageCount,
    p_line_key: params.lineKey,
    p_target_claim_id: params.targetClaimId,
    p_match: params.match,
    p_confirm_replace: params.confirmReplace,
    p_data: params.data,
    p_actor_id: params.actor.actorId,
    p_actor_type: params.actor.actorType,
    p_actor_display: params.actor.actorDisplay,
    p_import_batch_id: params.importBatchId,
  });
  if (error) throwImportRpcError("applyEobLine", error as { code?: string; message?: string });
  return toWriteResult(data);
}

// ─── Import patient identity and pending EOB lines (P4-P28) ─────────────────

export interface PatientExternalIdRow {
  patientId: string;
  sourceSystem: string;
  externalId: string;
  birthDate: string | null;
}

export async function listPatientExternalIds(): Promise<PatientExternalIdRow[]> {
  const { data, error } = await supabase
    .from("patient_external_ids")
    .select("patient_id, source_system, external_id, birth_date");
  if (error) {
    console.error("[Supabase] listPatientExternalIds:", error);
    throw error;
  }
  return (data ?? []).map((r: any) => ({ patientId: r.patient_id, sourceSystem: r.source_system, externalId: r.external_id, birthDate: r.birth_date ?? null }));
}

export async function linkPatientExternalId(params: {
  patientId: string;
  sourceSystem: string;
  externalId: string;
  birthDate: string | null;
  actor: ActorContext;
  importBatchId: string;
}): Promise<void> {
  const { error } = await supabase.rpc("link_patient_external_id_with_audit", {
    p_patient_id: params.patientId,
    p_source_system: params.sourceSystem,
    p_external_id: params.externalId,
    p_birth_date: params.birthDate,
    p_actor_id: params.actor.actorId,
    p_actor_type: params.actor.actorType,
    p_actor_display: params.actor.actorDisplay,
    p_import_batch_id: params.importBatchId,
  });
  if (error) throwImportRpcError("linkPatientExternalId", error as { code?: string; message?: string });
}

export type NewPatientImportResult =
  | { status: "patient_exists"; patientId: string }
  | { status: "created"; patientId: string; lines: Array<{ lineKey: string; status: string; claimId: string | null; authPeriod: number | null }> };

/** One transaction: the patient, its mappings, its audit rows and every line. See the P4-P28 migration. */
export async function commitImportWithNewPatient(params: {
  kind: "cms1500" | "eob";
  patientName: string;
  sourceSystem: string | null;
  externalId: string | null;
  birthDate: string | null;
  creationKey: string;
  allowSameName: boolean;
  source: ClaimImportSource;
  siblingLineKeys: string[];
  lines: Array<Record<string, unknown>>;
  actor: ActorContext;
  importBatchId: string;
}): Promise<NewPatientImportResult> {
  const { data, error } = await supabase.rpc("commit_import_with_new_patient", {
    p_kind: params.kind,
    p_patient_name: params.patientName,
    p_source_system: params.sourceSystem,
    p_external_id: params.externalId,
    p_birth_date: params.birthDate,
    p_creation_key: params.creationKey,
    p_allow_same_name: params.allowSameName,
    p_content_sha256: params.source.sha256,
    p_file_name: params.source.fileName,
    p_page_count: params.source.pageCount,
    p_sibling_line_keys: params.siblingLineKeys,
    p_lines: params.lines,
    p_actor_id: params.actor.actorId,
    p_actor_type: params.actor.actorType,
    p_actor_display: params.actor.actorDisplay,
    p_import_batch_id: params.importBatchId,
  });
  if (error) throwImportRpcError("commitImportWithNewPatient", error as { code?: string; message?: string });
  const r = data as any;
  if (r.status === "patient_exists") return { status: "patient_exists", patientId: r.patient_id };
  return {
    status: "created",
    patientId: r.patient_id,
    lines: (r.lines ?? []).map((l: any) => ({ lineKey: l.line_key, status: l.status, claimId: l.claim_id ?? null, authPeriod: l.auth_period ?? null })),
  };
}

export async function holdEobLine(params: {
  patientId: string;
  source: ClaimImportSource;
  lineKey: string;
  match: Record<string, unknown>;
  data: Record<string, unknown>;
  target: Record<string, unknown> | null;
  actor: ActorContext;
  importBatchId: string;
}): Promise<{ status: "created" | "updated" | "unchanged"; pendingId: string }> {
  const { data, error } = await supabase.rpc("hold_eob_line_with_audit", {
    p_patient_id: params.patientId,
    p_content_sha256: params.source.sha256,
    p_file_name: params.source.fileName,
    p_page_count: params.source.pageCount,
    p_line_key: params.lineKey,
    p_match: params.match,
    p_data: params.data,
    p_target: params.target,
    p_actor_id: params.actor.actorId,
    p_actor_type: params.actor.actorType,
    p_actor_display: params.actor.actorDisplay,
    p_import_batch_id: params.importBatchId,
  });
  if (error) throwImportRpcError("holdEobLine", error as { code?: string; message?: string });
  const r = data as any;
  return { status: r.status, pendingId: r.pending_id };
}

/** Source line keys of this document that are waiting for a CMS1500. */
export async function listHeldEobLineKeys(documentId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("pending_eob_lines")
    .select("line_key")
    .eq("document_id", documentId)
    .eq("status", "pending");
  if (error) {
    console.error("[Supabase] listHeldEobLineKeys:", error);
    throw error;
  }
  return (data ?? []).map((r: any) => r.line_key);
}

export interface PendingEobRow {
  id: string;
  patientId: string;
  patientName: string;
  documentId: string;
  fileName: string | null;
  lineKey: string;
  dateOfService: string;
  cptCodes: string;
  modifier: string | null;
  unitsBilled: number | null;
  data: Record<string, unknown>;
  target: Record<string, unknown> | null;
  createdAt: string;
}

export const PENDING_EOB_LIST_LIMIT = 500;

export async function listPendingEobLines(): Promise<PendingEobRow[]> {
  const { data, error } = await supabase
    .from("pending_eob_lines")
    .select("id, patient_id, document_id, line_key, date_of_service, cpt_codes, modifier, units_billed, data, target, created_at, patients(name), claim_import_documents(file_name)")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(PENDING_EOB_LIST_LIMIT);
  if (error) {
    console.error("[Supabase] listPendingEobLines:", error);
    throw error;
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patients?.name ?? "",
    documentId: r.document_id,
    fileName: r.claim_import_documents?.file_name ?? null,
    lineKey: r.line_key,
    dateOfService: r.date_of_service,
    cptCodes: r.cpt_codes,
    modifier: r.modifier,
    unitsBilled: r.units_billed,
    data: r.data ?? {},
    target: r.target ?? null,
    createdAt: r.created_at,
  }));
}

export async function applyPendingEobLine(params: {
  pendingId: string;
  targetClaimId: string;
  confirmReplace: boolean;
  actor: ActorContext;
  importBatchId: string;
}): Promise<ClaimImportWriteResult> {
  const { data, error } = await supabase.rpc("apply_pending_eob_line_with_audit", {
    p_pending_id: params.pendingId,
    p_target_claim_id: params.targetClaimId,
    p_confirm_replace: params.confirmReplace,
    p_actor_id: params.actor.actorId,
    p_actor_type: params.actor.actorType,
    p_actor_display: params.actor.actorDisplay,
    p_import_batch_id: params.importBatchId,
  });
  if (error) throwImportRpcError("applyPendingEobLine", error as { code?: string; message?: string });
  return toWriteResult(data);
}

export async function dismissPendingEobLine(pendingId: string, actor: ActorContext): Promise<void> {
  const { error } = await supabase.rpc("dismiss_pending_eob_line_with_audit", {
    p_pending_id: pendingId,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
  });
  if (error) throwImportRpcError("dismissPendingEobLine", error as { code?: string; message?: string });
}

/** Lines a reviewer dismissed for this patient, on any date and from any document. */
export async function listDismissedEobLines(patientId: string): Promise<DismissedEobLine[]> {
  const { data, error } = await supabase
    .from("pending_eob_lines")
    .select("id, document_id, line_key, date_of_service, cpt_codes, modifier, units_billed, data")
    .eq("patient_id", patientId)
    .eq("status", "dismissed");
  if (error) {
    console.error("[Supabase] listDismissedEobLines:", error);
    throw error;
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    documentId: r.document_id,
    lineKey: r.line_key,
    dateOfService: r.date_of_service,
    cptCodes: r.cpt_codes,
    modifier: r.modifier,
    unitsBilled: r.units_billed,
    data: r.data ?? {},
  }));
}

export async function reopenDismissedEobLine(pendingId: string, actor: ActorContext, importBatchId: string): Promise<void> {
  const { error } = await supabase.rpc("reopen_dismissed_eob_line_with_audit", {
    p_pending_id: pendingId,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_import_batch_id: importBatchId,
  });
  if (error) throwImportRpcError("reopenDismissedEobLine", error as { code?: string; message?: string });
}

/** Periods this patient has claim lines in. A patient created by an import can have lines and no visits yet. */
export async function listPatientClaimPeriods(patientId: string): Promise<number[]> {
  const { data, error } = await supabase.from("claims_records").select("auth_period").eq("patient_id", patientId);
  if (error) {
    console.error("[Supabase] listPatientClaimPeriods:", error);
    throw error;
  }
  return Array.from(new Set((data ?? []).map((r: any) => r.auth_period as number))).sort((a, b) => a - b);
}

// ─── Insurer catalog (P4-P7) ────────────────────────────────────────────────
// Single source of truth for insurer choices shown in patient forms,
// insurance filters, and the generic claims import path. See
// shared/insuranceCatalog.ts for the normalization rule used both here (via
// normalizedName, computed by the caller) and client-side.

export async function listInsurerCatalog(): Promise<InsurerCatalogEntry[]> {
  const { data, error } = await supabase
    .from("insurer_catalog")
    .select("*")
    .order("name", { ascending: true });

  if (error) {
    console.error("[Supabase] listInsurerCatalog:", error);
    return [];
  }
  return (data ?? []).map(toInsurerCatalogEntry);
}

export async function getInsurerCatalogEntryByNormalizedName(
  normalizedName: string
): Promise<InsurerCatalogEntry | undefined> {
  const { data, error } = await supabase
    .from("insurer_catalog")
    .select("*")
    .eq("normalized_name", normalizedName)
    .maybeSingle();

  if (error) {
    console.error("[Supabase] getInsurerCatalogEntryByNormalizedName:", error);
    return undefined;
  }
  return data ? toInsurerCatalogEntry(data) : undefined;
}

/** Throws (with a Postgres `code` of "23505") if this name's normalized
 *  form already exists — the DB's UNIQUE(normalized_name) index is the real
 *  guard against a race between two simultaneous submissions; callers
 *  should treat that error as "duplicate", not a generic failure.
 *
 *  normalized_name is NOT passed here — it's a GENERATED column (see the
 *  insurer_catalog migration), computed by the DB from `name` itself, so
 *  this call can never persist a name/normalized_name pair that disagree. */
export async function createInsurerCatalogEntry(params: {
  name: string;
}, actor: ActorContext): Promise<InsurerCatalogEntry> {
  const { data: id, error } = await supabase.rpc("write_insurer_catalog_with_audit", {
    p_id: null,
    p_data: { name: params.name },
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: "INSURER_CREATE",
  });

  if (error) {
    console.error("[Supabase] createInsurerCatalogEntry:", error);
    throw error;
  }
  const created = await getInsurerCatalogEntryById(id as string);
  if (!created) {
    throw new Error(`createInsurerCatalogEntry: row ${id as string} not found after insert`);
  }
  return created;
}

export async function getInsurerCatalogEntryById(id: string): Promise<InsurerCatalogEntry | undefined> {
  const { data, error } = await supabase
    .from("insurer_catalog")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[Supabase] getInsurerCatalogEntryById:", error);
    return undefined;
  }
  return data ? toInsurerCatalogEntry(data) : undefined;
}

/** Soft delete (P4-P13) — flips is_active to false. Never deletes the row or
 *  touches name/aliases/normalized_name, so patient/visit/claim records
 *  already storing this insurer's name keep resolving against it. Callers
 *  (insurance.delete) are responsible for the admin/owner authorization
 *  check; this function does not re-check it. */
export async function deactivateInsurerCatalogEntry(
  id: string,
  actor: ActorContext
): Promise<InsurerCatalogEntry> {
  const { error } = await supabase.rpc("write_insurer_catalog_with_audit", {
    p_id: id,
    p_data: { is_active: false, deactivated_at: new Date().toISOString(), deactivated_by: actor.actorId },
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: "INSURER_DEACTIVATE",
  });

  if (error) {
    console.error("[Supabase] deactivateInsurerCatalogEntry:", error);
    throw error;
  }
  const updated = await getInsurerCatalogEntryById(id);
  if (!updated) {
    throw new Error(`deactivateInsurerCatalogEntry: row ${id} not found after update`);
  }
  return updated;
}

/** Deliberate reactivation (P4-P13) — used both by the Manage Insurance
 *  Companies dialog's own "Reactivate" action and by insurance.create when
 *  the submitted name's normalized form matches an existing INACTIVE row
 *  (re-adding a deleted name should restore that one row, never insert a
 *  second row that would collide with its still-unique normalized_name). */
export async function reactivateInsurerCatalogEntry(
  id: string,
  actor: ActorContext
): Promise<InsurerCatalogEntry> {
  const { error } = await supabase.rpc("write_insurer_catalog_with_audit", {
    p_id: id,
    p_data: { is_active: true, reactivated_at: new Date().toISOString(), reactivated_by: actor.actorId },
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: "INSURER_REACTIVATE",
  });

  if (error) {
    console.error("[Supabase] reactivateInsurerCatalogEntry:", error);
    throw error;
  }
  const updated = await getInsurerCatalogEntryById(id);
  if (!updated) {
    throw new Error(`reactivateInsurerCatalogEntry: row ${id} not found after update`);
  }
  return updated;
}

export class InsurerCatalogEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`Insurance company ${id} not found`);
    this.name = "InsurerCatalogEntryNotFoundError";
  }
}

/** Thrown when a patient write assigns an insurer that was permanently
 *  deleted — either concurrently with this write, or earlier from a form
 *  whose insurer list was already stale (P0041, raised by the
 *  guard_insurer_assignment trigger on patients.insurance; see the P4-P21
 *  and P4-P22 migrations). A patient that already stored the name before
 *  the delete keeps it, and saving it unchanged is never rejected. */
export class InsurerDeletedError extends Error {
  constructor() {
    super("This insurance company was permanently deleted. Choose a different insurance company.");
    this.name = "InsurerDeletedError";
  }
}

function mapInsurerAssignmentError(error: { code?: string }): void {
  if (error.code === "P0041") throw new InsurerDeletedError();
}

/** Thrown (P0042) if a foreign key into insurer_catalog ever exists: its ON
 *  DELETE action could change records, so the DB refuses to delete. */
export class InsurerCatalogHasForeignKeysError extends Error {
  constructor() {
    super("Insurance companies can't be permanently deleted until a database foreign key on the catalog is reviewed.");
    this.name = "InsurerCatalogHasForeignKeysError";
  }
}

/** Permanent catalog-only delete (P4-P21, P4-P22). One Postgres transaction
 *  locks the exact row by id, deletes it, tombstones its name/aliases so
 *  re-run seeds and backfills can't recreate it, and writes the
 *  INSURER_PERMANENT_DELETE audit row (with counts of the records that still
 *  carry the name) — all or nothing. Records that store the name are NOT a
 *  blocker and are never touched: patient/visit/claim insurer values are
 *  free text with no FK into the catalog, so they keep exactly what they
 *  recorded. Resolves only once the DB has confirmed it deleted `id`.
 *  Callers (insurance.permanentDelete) are responsible for the admin/owner
 *  authorization check; this function does not re-check it. */
export async function permanentlyDeleteInsurerCatalogEntry(
  id: string,
  actor: ActorContext
): Promise<void> {
  const { data: deletedId, error } = await supabase.rpc("delete_insurer_catalog_with_audit", {
    p_id: id,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
  });

  if (error) {
    console.error("[Supabase] permanentlyDeleteInsurerCatalogEntry:", error);
    if (error.code === "P0032") throw new InsurerCatalogEntryNotFoundError(id);
    if (error.code === "P0042") throw new InsurerCatalogHasForeignKeysError();
    throw error;
  }
  if (deletedId !== id) {
    throw new Error(`permanentlyDeleteInsurerCatalogEntry: DB did not confirm deleting ${id}`);
  }
}
