var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// server/supabase.ts
var supabase_exports = {};
__export(supabase_exports, {
  supabase: () => supabase
});
import { createClient } from "@supabase/supabase-js";
var supabaseUrl, supabaseKey, supabase;
var init_supabase = __esm({
  "server/supabase.ts"() {
    "use strict";
    supabaseUrl = process.env.SUPABASE_URL;
    supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      console.warn("[Supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set \u2014 DB calls will fail.");
    }
    supabase = createClient(
      supabaseUrl ?? "https://placeholder.supabase.co",
      supabaseKey ?? "placeholder-key",
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );
  }
});

// server/_core/env.ts
var ENV;
var init_env = __esm({
  "server/_core/env.ts"() {
    "use strict";
    ENV = {
      appId: process.env.VITE_APP_ID ?? "",
      cookieSecret: process.env.JWT_SECRET ?? "",
      databaseUrl: process.env.DATABASE_URL ?? "",
      oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
      ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
      isProduction: process.env.NODE_ENV === "production",
      // Manus's own built-in proxy — used only by unrelated platform features
      // (the file storage proxy). Not part of the AI claim-extraction pipeline.
      forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
      forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
      // AI provider for claim extraction (server/_core/llm.ts). Swap providers
      // by changing AI_PROVIDER alone — no code changes needed elsewhere.
      // "openai" (GPT-4 Vision via Chat Completions, default), "anthropic"
      // (native Claude Messages API), or "openrouter" (OpenAI-compatible proxy
      // that can reach Claude, Gemini, etc.).
      aiProvider: (process.env.AI_PROVIDER ?? "openai").trim().toLowerCase(),
      openaiApiKey: process.env.OPENAI_API_KEY ?? "",
      openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o",
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
      anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
      openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
      openrouterModel: process.env.OPENROUTER_MODEL ?? "anthropic/claude-3.5-sonnet",
      get aiModel() {
        if (ENV.aiProvider === "openrouter") return ENV.openrouterModel;
        if (ENV.aiProvider === "anthropic") return ENV.anthropicModel;
        return ENV.openaiModel;
      }
    };
  }
});

// server/_core/username.ts
function normalizeUsername(username) {
  return username.trim().toLowerCase();
}
function escapeLikePattern(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
var init_username = __esm({
  "server/_core/username.ts"() {
    "use strict";
  }
});

// shared/authPeriodMetrics.ts
function normalizePeriod(visit) {
  return visit.authPeriod ?? 1;
}
function getSortedUniquePeriods(visits) {
  return Array.from(new Set(visits.map(normalizePeriod))).sort((a, b) => a - b);
}
function getPeriodMetrics(visits, period) {
  const periodVisits = visits.filter((v) => normalizePeriod(v) === period);
  const authRow = periodVisits.find((v) => v.sessionsAuthorized != null);
  const authorized = authRow?.sessionsAuthorized ?? 0;
  const completed = periodVisits.filter((v) => v.dateOfService != null).length;
  const remaining = Math.max(0, authorized - completed);
  return { authorized, completed, remaining };
}
function determineActivePeriod(visits) {
  const periods = getSortedUniquePeriods(visits);
  for (const period of periods) {
    if (getPeriodMetrics(visits, period).remaining > 0) return period;
  }
  return null;
}
function deriveAuthPeriodMetrics(visits) {
  const periods = getSortedUniquePeriods(visits);
  const activePeriod = determineActivePeriod(visits);
  const activeMetrics = activePeriod != null ? getPeriodMetrics(visits, activePeriod) : { authorized: 0, completed: 0, remaining: 0 };
  return { periods, activePeriod, activeMetrics };
}
var init_authPeriodMetrics = __esm({
  "shared/authPeriodMetrics.ts"() {
    "use strict";
  }
});

// shared/authUrgency.ts
function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}
function deriveAuthorizationUrgency(input) {
  const { remaining, authStatus = null, authValidUntil = null, now = /* @__PURE__ */ new Date() } = input;
  let urgency = "ok";
  if (remaining === 0) urgency = "exhausted";
  else if (remaining <= 2) urgency = "critical";
  else if (remaining <= 3) urgency = "warning";
  if (authStatus === "pending" && urgency === "ok") urgency = "pending";
  if (authStatus === "denied") urgency = "denied";
  const nowMs = now.getTime();
  const authValidUntilMs = authValidUntil !== null ? toMillis(authValidUntil) : null;
  const expiresWithin7Days = authValidUntilMs !== null && authValidUntilMs > nowMs && authValidUntilMs - nowMs <= SEVEN_DAYS_MS;
  const alreadyExpired = authValidUntilMs !== null && authValidUntilMs < nowMs;
  const authExpiryWarning = (expiresWithin7Days || alreadyExpired) && urgency === "ok";
  if (authExpiryWarning) urgency = "warning";
  return { urgency, authExpiryWarning };
}
var SEVEN_DAYS_MS;
var init_authUrgency = __esm({
  "shared/authUrgency.ts"() {
    "use strict";
    SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1e3;
  }
});

// server/db.ts
var db_exports = {};
__export(db_exports, {
  ClaimLineIdentityAmbiguousError: () => ClaimLineIdentityAmbiguousError,
  ClaimRecordNotFoundError: () => ClaimRecordNotFoundError,
  ClaimRecordPatientMismatchError: () => ClaimRecordPatientMismatchError,
  ClinicUserConflictError: () => ClinicUserConflictError,
  FOLLOW_UP_STALE_DAYS: () => FOLLOW_UP_STALE_DAYS,
  LastActiveAccountManagerError: () => LastActiveAccountManagerError,
  adminResetClinicUserPassword: () => adminResetClinicUserPassword,
  aggregateClaimStatusCounts: () => aggregateClaimStatusCounts,
  applyCms1500Enrichment: () => applyCms1500Enrichment,
  approveAndCreateNewBatch: () => approveAndCreateNewBatch,
  archiveClinicUser: () => archiveClinicUser,
  bulkCreateVisitRecords: () => bulkCreateVisitRecords,
  changeClinicUserPassword: () => changeClinicUserPassword,
  classifyClaimFollowUp: () => classifyClaimFollowUp,
  createAuditLog: () => createAuditLog,
  createClaimRecord: () => createClaimRecord,
  createClinicUser: () => createClinicUser,
  createInsurerCatalogEntry: () => createInsurerCatalogEntry,
  createPatient: () => createPatient,
  createVisitRecord: () => createVisitRecord,
  deactivateInsurerCatalogEntry: () => deactivateInsurerCatalogEntry,
  deleteClaimRecordWithAudit: () => deleteClaimRecordWithAudit,
  deletePatient: () => deletePatient,
  determineActiveAuthPeriod: () => determineActiveAuthPeriod,
  determineMarkAsRequestedTargetRow: () => determineMarkAsRequestedTargetRow,
  diffPatientUpdate: () => diffPatientUpdate,
  findCms1500EnrichmentCandidates: () => findCms1500EnrichmentCandidates,
  getAllPatients: () => getAllPatients,
  getAuthAlertSummaries: () => getAuthAlertSummaries,
  getClaimsByPatientAndPeriod: () => getClaimsByPatientAndPeriod,
  getClinicUserById: () => getClinicUserById,
  getClinicUserByUsername: () => getClinicUserByUsername,
  getCompletedPatients: () => getCompletedPatients,
  getInsurerCatalogEntryById: () => getInsurerCatalogEntryById,
  getInsurerCatalogEntryByNormalizedName: () => getInsurerCatalogEntryByNormalizedName,
  getLatestVisitIdForPatient: () => getLatestVisitIdForPatient,
  getMarkAsRequestedTargetVisitId: () => getMarkAsRequestedTargetVisitId,
  getPatientById: () => getPatientById,
  getUserByOpenId: () => getUserByOpenId,
  getVisitsByPatientId: () => getVisitsByPatientId,
  listActivityLog: () => listActivityLog,
  listClinicUsers: () => listClinicUsers,
  listHistoryForEntity: () => listHistoryForEntity,
  listInsurerCatalog: () => listInsurerCatalog,
  patientHasAnyClaimRecords: () => patientHasAnyClaimRecords,
  reactivateClinicUser: () => reactivateClinicUser,
  reactivateInsurerCatalogEntry: () => reactivateInsurerCatalogEntry,
  setPatientActive: () => setPatientActive,
  sortByFollowUpUrgency: () => sortByFollowUpUrgency,
  touchClinicUserLastLogin: () => touchClinicUserLastLogin,
  updateClaimRecord: () => updateClaimRecord,
  updateClinicUserProfile: () => updateClinicUserProfile,
  updateClinicUserRole: () => updateClinicUserRole,
  updatePatient: () => updatePatient,
  updateVisitRecord: () => updateVisitRecord,
  upsertClaimRecord: () => upsertClaimRecord,
  upsertUser: () => upsertUser
});
function toUser(row) {
  return {
    id: row.id,
    openId: row.open_id,
    name: row.name ?? null,
    email: row.email ?? null,
    loginMethod: row.login_method ?? null,
    role: row.role ?? "user",
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastSignedIn: new Date(row.last_signed_in)
  };
}
function toPatient(row) {
  return {
    id: row.id,
    name: row.name,
    insurance: row.insurance ?? "",
    authDate: row.auth_date ? /* @__PURE__ */ new Date(row.auth_date + "T00:00:00Z") : null,
    authValidUntil: row.auth_valid_until ?? null,
    isActive: row.is_active !== false,
    // default true if column missing
    dischargeDate: row.discharge_date ?? null,
    dischargeReason: row.discharge_reason ?? null,
    claimsStatus: row.claims_status ?? "none",
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}
function toVisitRecord(row) {
  return {
    id: row.id,
    patientId: row.patient_id,
    sessionsAuthorized: row.sessions_authorized ?? null,
    sessionsRemaining: row.sessions_remaining ?? null,
    sessionNumber: row.session_number ?? null,
    authPeriod: row.auth_period ?? 1,
    dateOfService: row.date_of_service ? /* @__PURE__ */ new Date(row.date_of_service + "T00:00:00Z") : null,
    newAuth: row.new_auth ?? null,
    dateAshSubmitted: row.date_ash_submitted ? /* @__PURE__ */ new Date(row.date_ash_submitted + "T00:00:00Z") : null,
    authStatus: row.auth_status ?? "none",
    insuranceCompany: row.insurance_company ?? null,
    totalInsuranceReimbursement: row.total_insurance_reimbursement ?? null,
    totalPatientDue: row.total_patient_due ?? null,
    totalPatientPaid: row.total_patient_paid ?? null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}
function toClinicUser(row) {
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
    archivedAt: row.archived_at ? new Date(row.archived_at) : null
  };
}
function toInsurerCatalogEntry(row) {
  return {
    id: row.id,
    name: row.name,
    aliases: row.aliases ?? [],
    createdAt: new Date(row.created_at),
    isActive: row.is_active ?? true,
    deactivatedAt: row.deactivated_at ? new Date(row.deactivated_at) : null,
    reactivatedAt: row.reactivated_at ? new Date(row.reactivated_at) : null
  };
}
async function upsertUser(user) {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const role = user.role ?? (user.openId === ENV.ownerOpenId ? "admin" : "user");
  const { error } = await supabase.from("users").upsert(
    {
      open_id: user.openId,
      name: user.name ?? null,
      email: user.email ?? null,
      login_method: user.loginMethod ?? null,
      role,
      last_signed_in: (user.lastSignedIn ?? /* @__PURE__ */ new Date()).toISOString()
    },
    { onConflict: "open_id" }
  );
  if (error) {
    console.error("[Supabase] upsertUser:", error);
    throw error;
  }
}
async function getUserByOpenId(openId) {
  const { data, error } = await supabase.from("users").select("*").eq("open_id", openId).limit(1).maybeSingle();
  if (error) {
    console.error("[Supabase] getUserByOpenId:", error);
    return void 0;
  }
  return data ? toUser(data) : void 0;
}
async function getAllPatients() {
  const { data, error } = await supabase.from("patients").select("*").order("name", { ascending: true });
  if (error) {
    console.error("[Supabase] getAllPatients:", error);
    return [];
  }
  return (data ?? []).map(toPatient);
}
async function getPatientById(id) {
  const { data, error } = await supabase.from("patients").select("*").eq("id", id).maybeSingle();
  if (error) {
    console.error("[Supabase] getPatientById:", error);
    return void 0;
  }
  return data ? toPatient(data) : void 0;
}
async function createPatient(data, actor) {
  const payload = { name: data.name };
  if (data.insurance !== void 0) payload.insurance = data.insurance;
  if (data.authDate !== void 0) {
    payload.auth_date = data.authDate ? data.authDate.toISOString().split("T")[0] : null;
  }
  if (data.authValidUntil !== void 0) payload.auth_valid_until = data.authValidUntil ?? null;
  const { data: id, error } = await supabase.rpc("write_patient_with_audit", {
    p_id: null,
    p_data: payload,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: "PATIENT_CREATE"
  });
  if (error) {
    console.error("[Supabase] createPatient:", error);
    throw error;
  }
  return id;
}
async function updatePatient(id, data, actor) {
  const payload = {};
  if (data.name !== void 0) payload.name = data.name;
  if (data.insurance !== void 0) payload.insurance = data.insurance;
  if (data.authDate !== void 0) {
    payload.auth_date = data.authDate ? data.authDate.toISOString().split("T")[0] : null;
  }
  if (data.authValidUntil !== void 0) payload.auth_valid_until = data.authValidUntil ?? null;
  if (data.claimsStatus !== void 0) payload.claims_status = data.claimsStatus;
  if (Object.keys(payload).length === 0) return;
  const { error } = await supabase.rpc("write_patient_with_audit", {
    p_id: id,
    p_data: payload,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: "PATIENT_UPDATE"
  });
  if (error) {
    console.error("[Supabase] updatePatient:", error);
    throw error;
  }
}
function diffPatientUpdate(before, after) {
  const changes = [];
  if (after.name !== void 0 && after.name !== before.name) {
    changes.push({ action: "PATIENT_NAME_UPDATE", oldValue: before.name, newValue: after.name });
  }
  return changes;
}
async function createAuditLog(entry) {
  const { error } = await supabase.from("audit_logs").insert({
    patient_id: entry.patientId,
    actor_id: entry.actorId,
    action: entry.action,
    old_value: entry.oldValue,
    new_value: entry.newValue
  });
  if (error) {
    console.error("[Supabase] createAuditLog:", error);
    throw error;
  }
}
function toAuditLogRow(row) {
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
    createdAt: new Date(row.created_at)
  };
}
async function listHistoryForEntity(entityType, entityId) {
  const { data, error } = await supabase.from("audit_logs").select("*").eq("entity_type", entityType).eq("entity_id", entityId).order("created_at", { ascending: false });
  if (error) {
    console.error("[Supabase] listHistoryForEntity:", error);
    throw error;
  }
  return (data ?? []).map(toAuditLogRow);
}
async function listActivityLog(filters) {
  let query = supabase.from("audit_logs").select("*", { count: "exact" });
  if (filters.actorId) query = query.eq("actor_id", filters.actorId);
  if (filters.entityType) query = query.eq("entity_type", filters.entityType);
  if (filters.action) query = query.eq("action", filters.action);
  if (filters.dateFrom) query = query.gte("created_at", filters.dateFrom.toISOString());
  if (filters.dateTo) query = query.lte("created_at", filters.dateTo.toISOString());
  const from = filters.page * filters.pageSize;
  const to = from + filters.pageSize - 1;
  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);
  if (error) {
    console.error("[Supabase] listActivityLog:", error);
    throw error;
  }
  return { rows: (data ?? []).map(toAuditLogRow), total: count ?? 0 };
}
async function setPatientActive(id, isActive, dischargeDate, dischargeReason) {
  const update = { is_active: isActive };
  if (!isActive) {
    update.discharge_date = dischargeDate ?? Date.now();
    update.discharge_reason = dischargeReason ?? null;
  } else {
    update.discharge_date = null;
    update.discharge_reason = null;
  }
  const { error } = await supabase.from("patients").update(update).eq("id", id);
  if (error) {
    console.error("[Supabase] setPatientActive:", error);
    throw error;
  }
}
async function deletePatient(id) {
  const { error } = await supabase.from("patients").delete().eq("id", id);
  if (error) {
    console.error("[Supabase] deletePatient:", error);
    throw error;
  }
}
async function getVisitsByPatientId(patientId) {
  const { data, error } = await supabase.from("visit_records").select("*").eq("patient_id", patientId).order("auth_period", { ascending: true }).order("session_number", { ascending: true });
  if (error) {
    console.error("[Supabase] getVisitsByPatientId:", error);
    return [];
  }
  return (data ?? []).map(toVisitRecord);
}
async function createVisitRecord(data, actor) {
  const { data: row, error } = await supabase.from("visit_records").insert({
    patient_id: data.patientId,
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
    ...actor ? { created_by: actor.actorId, created_by_type: actor.actorType, updated_by: actor.actorId, updated_by_type: actor.actorType } : {}
  }).select("id").single();
  if (error) {
    console.error("[Supabase] createVisitRecord:", error);
    throw error;
  }
  return row.id;
}
async function updateVisitRecord(id, data, actor) {
  const update = {};
  if (actor) {
    update.updated_by = actor.actorId;
    update.updated_by_type = actor.actorType;
  }
  if (data.sessionsAuthorized !== void 0) update.sessions_authorized = data.sessionsAuthorized;
  if (data.sessionsRemaining !== void 0) update.sessions_remaining = data.sessionsRemaining;
  if (data.sessionNumber !== void 0) update.session_number = data.sessionNumber;
  if (data.authPeriod !== void 0) update.auth_period = data.authPeriod;
  if (data.dateOfService !== void 0) {
    update.date_of_service = data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null;
  }
  if (data.newAuth !== void 0) update.new_auth = data.newAuth;
  if (data.dateAshSubmitted !== void 0) {
    update.date_ash_submitted = data.dateAshSubmitted ? data.dateAshSubmitted.toISOString().split("T")[0] : null;
  }
  if (data.authStatus !== void 0) update.auth_status = data.authStatus;
  if (data.totalInsuranceReimbursement !== void 0) update.total_insurance_reimbursement = data.totalInsuranceReimbursement;
  if (data.totalPatientDue !== void 0) update.total_patient_due = data.totalPatientDue;
  if (data.totalPatientPaid !== void 0) update.total_patient_paid = data.totalPatientPaid;
  const { error } = await supabase.from("visit_records").update(update).eq("id", id);
  if (error) {
    console.error("[Supabase] updateVisitRecord:", error);
    throw error;
  }
}
async function bulkCreateVisitRecords(records, actor) {
  if (records.length === 0) return;
  const rows = records.map((r) => ({
    patient_id: r.patientId,
    sessions_authorized: r.sessionsAuthorized ?? null,
    sessions_remaining: r.sessionsRemaining ?? null,
    session_number: r.sessionNumber ?? null,
    auth_period: r.authPeriod ?? 1,
    date_of_service: r.dateOfService ? r.dateOfService.toISOString().split("T")[0] : null,
    new_auth: r.newAuth ?? null,
    date_ash_submitted: r.dateAshSubmitted ? r.dateAshSubmitted.toISOString().split("T")[0] : null,
    auth_status: r.authStatus ?? "none",
    ...actor ? { created_by: actor.actorId, created_by_type: actor.actorType, updated_by: actor.actorId, updated_by_type: actor.actorType } : {}
  }));
  const { error } = await supabase.from("visit_records").insert(rows);
  if (error) {
    console.error("[Supabase] bulkCreateVisitRecords:", error);
    throw error;
  }
}
async function getAuthAlertSummaries() {
  const { data: allPatients, error: pErr } = await supabase.from("patients").select("*").order("name", { ascending: true });
  if (pErr) {
    console.error("[Supabase] getAuthAlertSummaries patients:", pErr);
    return [];
  }
  if (!allPatients || allPatients.length === 0) return [];
  const { data: allVisits, error: vErr } = await supabase.from("visit_records").select("*").order("auth_period", { ascending: true }).order("session_number", { ascending: true });
  if (vErr) {
    console.error("[Supabase] getAuthAlertSummaries visits:", vErr);
    return [];
  }
  const visits = (allVisits ?? []).map(toVisitRecord);
  return allPatients.map((patientRow) => {
    const patient = toPatient(patientRow);
    const pVisits = visits.filter((v) => v.patientId === patient.id);
    if (pVisits.length === 0) {
      return {
        patientId: patient.id,
        patientName: patient.name,
        insurance: patient.insurance,
        sessionsAuthorized: null,
        sessionsRemaining: null,
        authStatus: "none",
        dateAshSubmitted: null,
        urgency: "ok",
        authValidUntil: patient.authValidUntil ?? null,
        authPeriod: null
      };
    }
    const { periods: allPeriods, activePeriod } = deriveAuthPeriodMetrics(pVisits);
    const latestPeriod = allPeriods[allPeriods.length - 1];
    const targetPeriod = activePeriod ?? latestPeriod;
    const targetVisits = pVisits.filter((v) => (v.authPeriod ?? 1) === targetPeriod);
    const authRow = targetVisits.find((v) => v.sessionsAuthorized != null);
    const sessionsAuthorized = authRow?.sessionsAuthorized ?? null;
    const sessionsRemaining = activePeriod !== null ? getPeriodMetrics(pVisits, targetPeriod).remaining : 0;
    const lastActiveRow = targetVisits[targetVisits.length - 1];
    const authStatus = lastActiveRow?.authStatus ?? "none";
    const dateAshSubmitted = lastActiveRow?.dateAshSubmitted ?? null;
    const authValidUntil = patient.authValidUntil ?? null;
    const { urgency, authExpiryWarning } = deriveAuthorizationUrgency({
      remaining: sessionsRemaining,
      authStatus,
      authValidUntil,
      now: /* @__PURE__ */ new Date()
    });
    return {
      patientId: patient.id,
      patientName: patient.name,
      insurance: patient.insurance,
      sessionsAuthorized,
      sessionsRemaining,
      authStatus,
      dateAshSubmitted: dateAshSubmitted instanceof Date ? dateAshSubmitted.toISOString().split("T")[0] : dateAshSubmitted,
      urgency,
      authValidUntil,
      authExpiryWarning,
      authPeriod: targetPeriod
    };
  });
}
async function getLatestVisitIdForPatient(patientId) {
  const { data, error } = await supabase.from("visit_records").select("id, auth_period, session_number").eq("patient_id", patientId).order("auth_period", { ascending: true }).order("session_number", { ascending: true });
  if (error) {
    console.error("[Supabase] getLatestVisitIdForPatient:", error);
    return null;
  }
  if (!data || data.length === 0) return null;
  return data[data.length - 1].id;
}
function determineActiveAuthPeriod(visits) {
  return determineActivePeriod(
    visits.map((v) => ({
      authPeriod: v.auth_period,
      sessionsAuthorized: v.sessions_authorized,
      dateOfService: v.date_of_service
    }))
  );
}
function determineMarkAsRequestedTargetRow(visits) {
  if (visits.length === 0) return null;
  const periods = Array.from(new Set(visits.map((v) => v.auth_period ?? 1))).sort((a, b) => a - b);
  const latestPeriod = periods[periods.length - 1];
  const activePeriod = determineActiveAuthPeriod(visits);
  const targetPeriod = activePeriod ?? latestPeriod;
  const targetVisits = visits.filter((v) => (v.auth_period ?? 1) === targetPeriod).sort((a, b) => (a.session_number ?? 0) - (b.session_number ?? 0));
  return targetVisits[targetVisits.length - 1] ?? null;
}
async function getMarkAsRequestedTargetVisitId(patientId) {
  const { data, error } = await supabase.from("visit_records").select("id, auth_period, session_number, sessions_authorized, date_of_service").eq("patient_id", patientId);
  if (error) {
    console.error("[Supabase] getMarkAsRequestedTargetVisitId:", error);
    return null;
  }
  if (!data || data.length === 0) return null;
  const target = determineMarkAsRequestedTargetRow(data);
  return target?.id ?? null;
}
async function approveAndCreateNewBatch(patientId, sessionsAuthorized, authDate, newInsurance, authValidUntil, actor) {
  const { data: periodStatusRows, error: periodStatusErr } = await supabase.from("visit_records").select("auth_period, sessions_authorized, date_of_service").eq("patient_id", patientId);
  if (periodStatusErr) {
    console.error("[Supabase] approveAndCreateNewBatch periodStatus:", periodStatusErr);
    throw periodStatusErr;
  }
  const statusRows = periodStatusRows ?? [];
  const statusPeriods = Array.from(new Set(statusRows.map((r) => r.auth_period ?? 1))).sort((a, b) => a - b);
  const latestStatusPeriod = statusPeriods.length > 0 ? statusPeriods[statusPeriods.length - 1] : 1;
  const targetApprovalPeriod = determineActiveAuthPeriod(statusRows) ?? latestStatusPeriod;
  const { error: approveErr } = await supabase.from("visit_records").update({ auth_status: "approved", updated_by: actor.actorId, updated_by_type: actor.actorType }).eq("patient_id", patientId).eq("auth_period", targetApprovalPeriod);
  if (approveErr) {
    console.error("[Supabase] approveAndCreateNewBatch approve:", approveErr);
    throw approveErr;
  }
  const patientUpdates = {};
  if (authDate) patientUpdates.auth_date = authDate.toISOString().split("T")[0];
  if (newInsurance && newInsurance.trim()) patientUpdates.insurance = newInsurance.trim();
  if (authValidUntil !== void 0) patientUpdates.auth_valid_until = authValidUntil ?? null;
  if (Object.keys(patientUpdates).length > 0) {
    patientUpdates.updated_by = actor.actorId;
    patientUpdates.updated_by_type = actor.actorType;
    const { error: patErr } = await supabase.from("patients").update(patientUpdates).eq("id", patientId);
    if (patErr) {
      console.error("[Supabase] approveAndCreateNewBatch update patient:", patErr);
      throw patErr;
    }
  }
  const { data: periodRows, error: periodErr } = await supabase.from("visit_records").select("auth_period").eq("patient_id", patientId);
  if (periodErr) {
    console.error("[Supabase] approveAndCreateNewBatch periods:", periodErr);
    throw periodErr;
  }
  const maxPeriod = periodRows && periodRows.length > 0 ? Math.max(...periodRows.map((r) => r.auth_period ?? 1)) : 1;
  const nextPeriod = maxPeriod + 1;
  let batchInsurance = newInsurance?.trim() || null;
  if (!batchInsurance) {
    const { data: patRow } = await supabase.from("patients").select("insurance").eq("id", patientId).single();
    batchInsurance = patRow?.insurance ?? null;
  }
  const newRows = Array.from({ length: sessionsAuthorized }, (_, i) => ({
    patient_id: patientId,
    sessions_authorized: sessionsAuthorized,
    sessions_remaining: sessionsAuthorized - i,
    session_number: i + 1,
    auth_period: nextPeriod,
    date_of_service: null,
    new_auth: null,
    date_ash_submitted: null,
    auth_status: "none",
    insurance_company: batchInsurance
  }));
  const stampedRows = newRows.map((r) => ({
    ...r,
    created_by: actor.actorId,
    created_by_type: actor.actorType,
    updated_by: actor.actorId,
    updated_by_type: actor.actorType
  }));
  const { data: inserted, error: insertErr } = await supabase.from("visit_records").insert(stampedRows).select("id");
  if (insertErr) {
    console.error("[Supabase] approveAndCreateNewBatch insert:", insertErr);
    throw insertErr;
  }
  const newVisitIds = (inserted ?? []).map((r) => r.id);
  const { error: auditErr } = await supabase.from("audit_logs").insert({
    entity_type: "visit_record",
    entity_id: patientId,
    patient_id: patientId,
    actor_id: actor.actorId,
    actor_type: actor.actorType,
    actor_display: actor.actorDisplay,
    action: "AUTHORIZATION_APPROVED",
    before_data: { auth_period: targetApprovalPeriod },
    after_data: { new_auth_period: nextPeriod, sessions_authorized: sessionsAuthorized }
  });
  if (auditErr) {
    console.error("[Supabase] approveAndCreateNewBatch audit insert failed (approval already applied):", auditErr);
  }
  return { newVisitIds };
}
async function getCompletedPatients() {
  const { data: allPatients, error: pErr } = await supabase.from("patients").select("id").order("name", { ascending: true });
  if (pErr) {
    console.error("[Supabase] getCompletedPatients:", pErr);
    return [];
  }
  if (!allPatients || allPatients.length === 0) return [];
  const { data: allVisits, error: vErr } = await supabase.from("visit_records").select("id, patient_id, date_of_service, sessions_authorized, auth_period");
  if (vErr) {
    console.error("[Supabase] getCompletedPatients visits:", vErr);
    return [];
  }
  const visits = (allVisits ?? []).map(toVisitRecord);
  return allPatients.filter((patient) => {
    const pVisits = visits.filter((v) => v.patientId === patient.id);
    if (pVisits.length === 0) return false;
    return determineActivePeriod(pVisits) === null;
  }).map((p) => p.id);
}
async function getClinicUserByUsername(username) {
  const normalized = normalizeUsername(username);
  const { data, error } = await supabase.from("clinic_users").select("*").ilike("username", escapeLikePattern(normalized)).maybeSingle();
  if (error) {
    console.error("[Supabase] getClinicUserByUsername:", error);
    return void 0;
  }
  return data ? toClinicUser(data) : void 0;
}
async function getClinicUserById(id) {
  const { data, error } = await supabase.from("clinic_users").select("*").eq("id", id).maybeSingle();
  if (error) {
    console.error("[Supabase] getClinicUserById:", error);
    return void 0;
  }
  return data ? toClinicUser(data) : void 0;
}
async function touchClinicUserLastLogin(id) {
  const { error } = await supabase.from("clinic_users").update({ last_login_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", id);
  if (error) {
    console.error("[Supabase] touchClinicUserLastLogin:", error);
  }
}
async function changeClinicUserPassword(params) {
  const { data, error } = await supabase.from("clinic_users").update({
    password_hash: params.passwordHash,
    must_change_password: false,
    token_version: params.expectedTokenVersion + 1
  }).eq("id", params.id).eq("token_version", params.expectedTokenVersion).select().maybeSingle();
  if (error) {
    console.error("[Supabase] changeClinicUserPassword:", error);
    throw error;
  }
  return data ? toClinicUser(data) : void 0;
}
async function listClinicUsers() {
  const { data, error } = await supabase.from("clinic_users").select("*").order("name", { ascending: true });
  if (error) {
    console.error("[Supabase] listClinicUsers:", error);
    return [];
  }
  return (data ?? []).map(toClinicUser);
}
function mapClinicUserRpcError(error, id) {
  if (error.code === "P0021" || error.code === "P0022") throw new ClinicUserConflictError(id);
  if (error.code === "P0023") throw new LastActiveAccountManagerError();
  throw error;
}
async function createClinicUser(data, actor) {
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
    p_actor_display: actor.actorDisplay
  });
  if (error) {
    console.error("[Supabase] createClinicUser:", error);
    throw error;
  }
  const created = await getClinicUserById(id);
  if (!created) throw new Error("createClinicUser: row not found immediately after insert");
  return created;
}
async function updateClinicUserProfile(id, data) {
  const update = {};
  if (data.name !== void 0) update.name = data.name;
  if (data.email !== void 0) update.email = data.email;
  if (data.department !== void 0) update.department = data.department;
  if (Object.keys(update).length === 0) {
    return getClinicUserById(id);
  }
  const { data: row, error } = await supabase.from("clinic_users").update(update).eq("id", id).select().maybeSingle();
  if (error) {
    console.error("[Supabase] updateClinicUserProfile:", error);
    throw error;
  }
  return row ? toClinicUser(row) : void 0;
}
async function updateClinicUserRole(params, actor) {
  const { error } = await supabase.rpc("update_clinic_user_role_with_audit", {
    p_id: params.id,
    p_role: params.role,
    p_expected_token_version: params.expectedTokenVersion,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay
  });
  if (error) {
    console.error("[Supabase] updateClinicUserRole:", error);
    mapClinicUserRpcError(error, params.id);
  }
  return getClinicUserById(params.id);
}
async function adminResetClinicUserPassword(params, actor) {
  const { error } = await supabase.rpc("admin_reset_clinic_user_password_with_audit", {
    p_id: params.id,
    p_password_hash: params.passwordHash,
    p_expected_token_version: params.expectedTokenVersion,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay
  });
  if (error) {
    console.error("[Supabase] adminResetClinicUserPassword:", error);
    mapClinicUserRpcError(error, params.id);
  }
  return getClinicUserById(params.id);
}
async function archiveClinicUser(params, actor) {
  const { error } = await supabase.rpc("archive_clinic_user_with_audit", {
    p_id: params.id,
    p_expected_token_version: params.expectedTokenVersion,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay
  });
  if (error) {
    console.error("[Supabase] archiveClinicUser:", error);
    mapClinicUserRpcError(error, params.id);
  }
  return getClinicUserById(params.id);
}
async function reactivateClinicUser(id, actor) {
  const { error } = await supabase.rpc("reactivate_clinic_user_with_audit", {
    p_id: id,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay
  });
  if (error) {
    console.error("[Supabase] reactivateClinicUser:", error);
    mapClinicUserRpcError(error, id);
  }
  return getClinicUserById(id);
}
function daysSince(dateStr, now) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return (now.getTime() - d.getTime()) / (1e3 * 60 * 60 * 24);
}
function classifyClaimFollowUp(claim, now = /* @__PURE__ */ new Date()) {
  const status = claim.claimStatus ?? "";
  const unpaid = claim.insuranceReimbursement == null || claim.insuranceReimbursement === 0;
  const days = daysSince(claim.claimSubmittedDate, now);
  const isStale = days != null && days > FOLLOW_UP_STALE_DAYS;
  let urgency = null;
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
function sortByFollowUpUrgency(items) {
  return [...items].sort((a, b) => FOLLOW_UP_URGENCY_RANK[a.urgency] - FOLLOW_UP_URGENCY_RANK[b.urgency]);
}
function aggregateClaimStatusCounts(rows) {
  const counts = { all: rows.length };
  const patientIdSets = {};
  for (const key of [...CLAIM_STATUS_KEYS, "none"]) {
    counts[key] = 0;
    patientIdSets[key] = /* @__PURE__ */ new Set();
  }
  for (const row of rows) {
    const status = row.claimStatus?.trim();
    const key = status && CLAIM_STATUS_KEYS.includes(status) ? status : "none";
    counts[key] += 1;
    patientIdSets[key].add(row.patientId);
  }
  const patientIdsByStatus = Object.fromEntries(
    Object.entries(patientIdSets).map(([key, set]) => [key, Array.from(set)])
  );
  return { counts, patientIdsByStatus };
}
async function getClaimsByPatientAndPeriod(patientId, authPeriod) {
  const { data, error } = await supabase.from("claims_records").select("*").eq("patient_id", patientId).eq("auth_period", authPeriod).order("date_of_service", { ascending: false }).order("created_at", { ascending: true }).order("id", { ascending: true });
  if (error) {
    console.error("[Supabase] getClaimsByPatientAndPeriod:", error);
    return [];
  }
  return data ?? [];
}
function claimFieldsToPayload(data) {
  const payload = {};
  if (data.authPeriod !== void 0) payload.auth_period = data.authPeriod;
  if (data.placeOfService !== void 0) payload.place_of_service = data.placeOfService;
  if (data.dateOfService !== void 0) payload.date_of_service = dateOnly(data.dateOfService);
  if (data.visitNumber !== void 0) payload.visit_number = data.visitNumber;
  if (data.cptCodes !== void 0) payload.cpt_codes = data.cptCodes;
  if (data.unitsBilled !== void 0) payload.units_billed = data.unitsBilled;
  if (data.diagnosisCodes !== void 0) payload.diagnosis_codes = data.diagnosisCodes;
  if (data.modifier !== void 0) payload.modifier = data.modifier;
  if (data.chargeAmount !== void 0) payload.charge_amount = data.chargeAmount;
  if (data.insuranceReimbursement !== void 0) payload.insurance_reimbursement = data.insuranceReimbursement;
  if (data.patientAmountPaid !== void 0) payload.patient_amount_paid = data.patientAmountPaid;
  if (data.patientAmountDue !== void 0) payload.patient_amount_due = data.patientAmountDue;
  if (data.insuranceBilled !== void 0) payload.insurance_billed = data.insuranceBilled;
  if (data.oaClaimNumber !== void 0) payload.oa_claim_number = data.oaClaimNumber;
  if (data.claimSubmittedDate !== void 0) payload.claim_submitted_date = dateOnly(data.claimSubmittedDate);
  if (data.expireBcbsClaimNumber !== void 0) payload.expire_bcbs_claim_number = data.expireBcbsClaimNumber;
  if (data.claimStatus !== void 0) payload.claim_status = data.claimStatus;
  if (data.paymentReceived !== void 0) payload.payment_received = data.paymentReceived;
  if (data.checkDate !== void 0) payload.check_date = dateOnly(data.checkDate);
  if (data.checkNumberVirtualCard !== void 0) payload.check_number_virtual_card = data.checkNumberVirtualCard;
  if (data.dateReceived !== void 0) payload.date_received = dateOnly(data.dateReceived);
  if (data.dateOfAppeal !== void 0) payload.date_of_appeal = dateOnly(data.dateOfAppeal);
  if (data.referenceNo !== void 0) payload.reference_no = data.referenceNo;
  if (data.lmn !== void 0) payload.lmn = data.lmn;
  if (data.sourceLineIndex !== void 0) payload.source_line_index = data.sourceLineIndex;
  return payload;
}
async function writeClaimRecordWithAudit(params) {
  const { data: id, error } = await supabase.rpc("write_claim_record_with_audit", {
    p_id: params.id,
    p_patient_id: params.patientId,
    p_data: params.payload,
    p_actor_id: params.actor.actorId,
    p_actor_type: params.actor.actorType,
    p_actor_display: params.actor.actorDisplay,
    p_action: params.action,
    p_import_batch_id: params.importBatchId ?? null
  });
  if (error) {
    console.error("[Supabase] writeClaimRecordWithAudit:", error);
    if (error.code === "P0010") throw new ClaimRecordNotFoundError(params.id ?? "");
    if (error.code === "P0011") throw new ClaimRecordPatientMismatchError(params.id ?? "", params.patientId);
    throw error;
  }
  return id;
}
async function createClaimRecord(data, actor, importBatchId) {
  const payload = claimFieldsToPayload(data);
  payload.claim_status = data.claimStatus ?? "submitted";
  return writeClaimRecordWithAudit({
    id: null,
    patientId: data.patientId,
    payload,
    actor,
    action: "CLAIM_RECORD_CREATE",
    importBatchId
  });
}
async function updateClaimRecord(id, data, actor) {
  const payload = claimFieldsToPayload(data);
  if (Object.keys(payload).length === 0) return;
  const { data: row, error: lookupErr } = await supabase.from("claims_records").select("patient_id").eq("id", id).maybeSingle();
  if (lookupErr) {
    console.error("[Supabase] updateClaimRecord (lookup):", lookupErr);
    throw lookupErr;
  }
  if (!row) throw new ClaimRecordNotFoundError(id);
  await writeClaimRecordWithAudit({
    id,
    patientId: row.patient_id,
    payload,
    actor,
    action: "CLAIM_RECORD_UPDATE"
  });
}
async function deleteClaimRecordWithAudit(params) {
  const { claimId, patientId, actorId, actorType, actorDisplay } = params;
  const { error } = await supabase.rpc("delete_claim_record_with_audit", {
    p_claim_id: claimId,
    p_patient_id: patientId,
    p_actor_id: actorId,
    p_actor_type: actorType ?? null,
    p_actor_display: actorDisplay ?? null
  });
  if (error) {
    if (error.code === "P0010") {
      throw new ClaimRecordNotFoundError(claimId);
    }
    if (error.code === "P0011") {
      throw new ClaimRecordPatientMismatchError(claimId, patientId);
    }
    console.error("[Supabase] deleteClaimRecordWithAudit (rpc):", error);
    throw error;
  }
}
async function findCms1500EnrichmentCandidates(patientId, dateOfService, cptCodes) {
  const dosStr = dateOfService.toISOString().split("T")[0];
  let query = supabase.from("claims_records").select([
    "id",
    "auth_period",
    "charge_amount",
    "insurance_reimbursement",
    "patient_amount_paid",
    "patient_amount_due",
    "visit_number",
    "diagnosis_codes",
    "modifier",
    "units_billed",
    ...REIMBURSEMENT_EVIDENCE_COLUMNS
  ].join(", ")).eq("patient_id", patientId).eq("date_of_service", dosStr);
  query = cptCodes ? query.eq("cpt_codes", cptCodes) : query.is("cpt_codes", null);
  const { data, error } = await query;
  if (error) {
    console.error("[Supabase] findCms1500EnrichmentCandidates:", error);
    throw error;
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    authPeriod: r.auth_period,
    chargeAmount: r.charge_amount,
    insuranceReimbursement: r.insurance_reimbursement,
    patientAmountPaid: r.patient_amount_paid,
    patientAmountDue: r.patient_amount_due,
    visitNumber: r.visit_number,
    diagnosisCodes: r.diagnosis_codes,
    modifier: r.modifier,
    unitsBilled: r.units_billed,
    hasReimbursementEvidence: REIMBURSEMENT_EVIDENCE_COLUMNS.some((col) => r[col] !== null && r[col] !== void 0)
  }));
}
async function patientHasAnyClaimRecords(patientId) {
  const { count, error } = await supabase.from("claims_records").select("id", { count: "exact", head: true }).eq("patient_id", patientId);
  if (error) {
    console.error("[Supabase] patientHasAnyClaimRecords:", error);
    throw error;
  }
  return (count ?? 0) > 0;
}
async function applyCms1500Enrichment(params) {
  const dosStr = params.dateOfService.toISOString().split("T")[0];
  let ownershipQuery = supabase.from("claims_records").select("id").eq("id", params.claimRecordId).eq("patient_id", params.patientId).eq("date_of_service", dosStr);
  ownershipQuery = params.cptCodes ? ownershipQuery.eq("cpt_codes", params.cptCodes) : ownershipQuery.is("cpt_codes", null);
  const { data: owned, error: ownErr } = await ownershipQuery.maybeSingle();
  if (ownErr) {
    console.error("[Supabase] applyCms1500Enrichment (ownership check):", ownErr);
    throw ownErr;
  }
  if (!owned) {
    throw new Error("Selected claim row does not belong to this patient or no longer matches the service date/CPT code.");
  }
  const patch = {};
  if (params.visitNumber != null) patch.visit_number = params.visitNumber;
  if (params.diagnosisCodes != null) patch.diagnosis_codes = params.diagnosisCodes;
  if (params.modifier != null) patch.modifier = params.modifier;
  if (params.unitsBilled != null) patch.units_billed = params.unitsBilled;
  if (Object.keys(patch).length === 0) return;
  try {
    await writeClaimRecordWithAudit({
      id: params.claimRecordId,
      patientId: params.patientId,
      payload: patch,
      actor: params.actor,
      action: "CLAIM_RECORD_CMS1500_ENRICHMENT",
      importBatchId: params.importBatchId
    });
  } catch (err) {
    if (err instanceof ClaimRecordNotFoundError || err instanceof ClaimRecordPatientMismatchError) {
      throw new Error("Selected claim row does not belong to this patient or no longer matches the service date/CPT code.");
    }
    throw err;
  }
}
async function upsertClaimRecord(data, actor, importBatchId) {
  const dosStr = data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null;
  const baseQuery = () => {
    let q = supabase.from("claims_records").select("id").eq("patient_id", data.patientId).eq("auth_period", data.authPeriod).eq("date_of_service", dosStr);
    q = data.cptCodes ? q.eq("cpt_codes", data.cptCodes) : q.is("cpt_codes", null);
    return q;
  };
  let existingId = null;
  let promoteLegacyRow = false;
  if (dosStr) {
    if (data.sourceLineIndex != null) {
      const { data: exact, error: exactErr } = await baseQuery().eq("source_line_index", data.sourceLineIndex).maybeSingle();
      if (exactErr) {
        console.error("[Supabase] upsertClaimRecord (exact line-index lookup):", exactErr);
        throw exactErr;
      }
      existingId = exact ? exact.id : null;
      if (!existingId) {
        const { data: legacy, error: legacyErr } = await baseQuery().is("source_line_index", null).maybeSingle();
        if (legacyErr) {
          if (legacyErr.code === "PGRST116") {
            throw new ClaimLineIdentityAmbiguousError(data.patientId, dosStr, data.cptCodes ?? null, data.sourceLineIndex);
          }
          console.error("[Supabase] upsertClaimRecord (legacy line-index lookup):", legacyErr);
          throw legacyErr;
        }
        const legacyId = legacy ? legacy.id : null;
        if (legacyId && data.sourceLineIndex === 0) {
          existingId = legacyId;
          promoteLegacyRow = true;
        } else if (legacyId && data.sourceLineIndex > 0) {
          throw new ClaimLineIdentityAmbiguousError(data.patientId, dosStr, data.cptCodes ?? null, data.sourceLineIndex);
        }
      }
    } else {
      const { data: existing, error } = await baseQuery().maybeSingle();
      if (error) {
        console.error("[Supabase] upsertClaimRecord (lookup):", error);
        throw error;
      }
      existingId = existing ? existing.id : null;
    }
  }
  if (existingId) {
    const patch = {};
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
    if (promoteLegacyRow) patch.source_line_index = 0;
    if (Object.keys(patch).length > 0) {
      await writeClaimRecordWithAudit({
        id: existingId,
        patientId: data.patientId,
        payload: patch,
        actor,
        action: "CLAIM_RECORD_UPDATE",
        importBatchId
      });
    }
    return existingId;
  }
  return createClaimRecord(data, actor, importBatchId);
}
async function listInsurerCatalog() {
  const { data, error } = await supabase.from("insurer_catalog").select("*").order("name", { ascending: true });
  if (error) {
    console.error("[Supabase] listInsurerCatalog:", error);
    return [];
  }
  return (data ?? []).map(toInsurerCatalogEntry);
}
async function getInsurerCatalogEntryByNormalizedName(normalizedName) {
  const { data, error } = await supabase.from("insurer_catalog").select("*").eq("normalized_name", normalizedName).maybeSingle();
  if (error) {
    console.error("[Supabase] getInsurerCatalogEntryByNormalizedName:", error);
    return void 0;
  }
  return data ? toInsurerCatalogEntry(data) : void 0;
}
async function createInsurerCatalogEntry(params, actor) {
  const { data, error } = await supabase.from("insurer_catalog").insert({ name: params.name, created_by: actor.actorId, created_by_type: actor.actorType }).select().single();
  if (error) {
    console.error("[Supabase] createInsurerCatalogEntry:", error);
    throw error;
  }
  return toInsurerCatalogEntry(data);
}
async function getInsurerCatalogEntryById(id) {
  const { data, error } = await supabase.from("insurer_catalog").select("*").eq("id", id).maybeSingle();
  if (error) {
    console.error("[Supabase] getInsurerCatalogEntryById:", error);
    return void 0;
  }
  return data ? toInsurerCatalogEntry(data) : void 0;
}
async function deactivateInsurerCatalogEntry(id, actorId) {
  const { data, error } = await supabase.from("insurer_catalog").update({ is_active: false, deactivated_at: (/* @__PURE__ */ new Date()).toISOString(), deactivated_by: actorId }).eq("id", id).select().single();
  if (error) {
    console.error("[Supabase] deactivateInsurerCatalogEntry:", error);
    throw error;
  }
  return toInsurerCatalogEntry(data);
}
async function reactivateInsurerCatalogEntry(id, actorId) {
  const { data, error } = await supabase.from("insurer_catalog").update({ is_active: true, reactivated_at: (/* @__PURE__ */ new Date()).toISOString(), reactivated_by: actorId }).eq("id", id).select().single();
  if (error) {
    console.error("[Supabase] reactivateInsurerCatalogEntry:", error);
    throw error;
  }
  return toInsurerCatalogEntry(data);
}
var LastActiveAccountManagerError, ClinicUserConflictError, FOLLOW_UP_STALE_DAYS, FOLLOW_UP_URGENCY_RANK, FOLLOW_UP_REASONS, CLAIM_STATUS_KEYS, dateOnly, ClaimRecordNotFoundError, ClaimRecordPatientMismatchError, REIMBURSEMENT_EVIDENCE_COLUMNS, ClaimLineIdentityAmbiguousError;
var init_db = __esm({
  "server/db.ts"() {
    "use strict";
    init_supabase();
    init_env();
    init_username();
    init_authPeriodMetrics();
    init_authUrgency();
    LastActiveAccountManagerError = class extends Error {
      constructor() {
        super("This is the only active admin account \u2014 it cannot be demoted or deactivated.");
        this.name = "LastActiveAccountManagerError";
      }
    };
    ClinicUserConflictError = class extends Error {
      constructor(id) {
        super(`Staff account ${id} changed during this request`);
        this.name = "ClinicUserConflictError";
      }
    };
    FOLLOW_UP_STALE_DAYS = 30;
    FOLLOW_UP_URGENCY_RANK = {
      rejected: 1,
      denied: 2,
      pended: 3,
      approved_unpaid: 4,
      pending_stale: 5,
      submitted_stale: 6,
      resubmitted_stale: 7
    };
    FOLLOW_UP_REASONS = {
      rejected: "Claim rejected \u2014 needs review",
      denied: "Claim denied \u2014 needs appeal or resubmission",
      pended: "Claim pended \u2014 waiting on additional info",
      approved_unpaid: "Approved but no reimbursement recorded",
      pending_stale: `Pending >${FOLLOW_UP_STALE_DAYS} days \u2014 follow up with payer`,
      submitted_stale: `Submitted >${FOLLOW_UP_STALE_DAYS} days ago \u2014 no payment received`,
      resubmitted_stale: `Resubmitted >${FOLLOW_UP_STALE_DAYS} days ago \u2014 no response`
    };
    CLAIM_STATUS_KEYS = [
      "submitted",
      "approved",
      "pending",
      "denied",
      "pended",
      "rejected",
      "resubmitted"
    ];
    dateOnly = (d) => d ? d.toISOString().split("T")[0] : null;
    ClaimRecordNotFoundError = class extends Error {
      constructor(id) {
        super(`Claim record ${id} not found`);
        this.name = "ClaimRecordNotFoundError";
      }
    };
    ClaimRecordPatientMismatchError = class extends Error {
      constructor(id, expectedPatientId) {
        super(`Claim record ${id} does not belong to patient ${expectedPatientId}`);
        this.name = "ClaimRecordPatientMismatchError";
      }
    };
    REIMBURSEMENT_EVIDENCE_COLUMNS = [
      "insurance_reimbursement",
      "patient_amount_paid",
      "patient_amount_due",
      "oa_claim_number",
      "check_date",
      "check_number_virtual_card",
      "reference_no",
      "payment_received"
    ];
    ClaimLineIdentityAmbiguousError = class extends Error {
      constructor(patientId, dateOfService, cptCodes, sourceLineIndex) {
        super(
          `Cannot safely save repeated line #${sourceLineIndex + 1} for CPT ${cptCodes ?? "(none)"} on ${dateOfService}: an existing claim row at this patient/date/CPT predates per-line identity tracking and might already represent merged or overwritten data from more than one source line. Needs manual review before saving.`
        );
        this.patientId = patientId;
        this.dateOfService = dateOfService;
        this.cptCodes = cptCodes;
        this.sourceLineIndex = sourceLineIndex;
        this.name = "ClaimLineIdentityAmbiguousError";
      }
    };
  }
});

// shared/nameMatch.ts
var nameMatch_exports = {};
__export(nameMatch_exports, {
  classifyPatientMatch: () => classifyPatientMatch,
  findMatchingPatient: () => findMatchingPatient,
  fuzzyNameMatch: () => fuzzyNameMatch
});
function normalizeName(name) {
  return name.toUpperCase().replace(/['']/g, "").replace(/[,.\-]/g, " ").replace(/\s+/g, " ").trim();
}
function tokenize(name) {
  return normalizeName(name).split(" ").filter((t2) => t2.length > 0);
}
function nameVariants(name) {
  const tokens = tokenize(name);
  const variants = /* @__PURE__ */ new Set();
  variants.add(tokens.join(" "));
  if (tokens.length === 2) {
    variants.add([tokens[1], tokens[0]].join(" "));
  }
  if (tokens.length >= 3) {
    variants.add([tokens[0], ...tokens.slice(1)].join(" "));
    variants.add([...tokens.slice(0, tokens.length - 1), tokens[tokens.length - 1]].join(" "));
    variants.add([...tokens].reverse().join(" "));
  }
  return Array.from(variants);
}
function suffixTolerantMatch(tokensA, tokensB) {
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  if (longer.length === shorter.length) return false;
  const remaining = [...longer];
  for (const t2 of shorter) {
    const idx = remaining.indexOf(t2);
    if (idx === -1) return false;
    remaining.splice(idx, 1);
  }
  return remaining.length > 0 && remaining.every((t2) => NAME_SUFFIXES.has(t2) || t2.length <= 2);
}
function fuzzyNameMatch(eobName, dashName) {
  if (!eobName || !dashName) return false;
  const normEob = normalizeName(eobName);
  const normDash = normalizeName(dashName);
  if (normEob === normDash) return true;
  const tokensEob = tokenize(eobName);
  const tokensDash = tokenize(dashName);
  const setEob = new Set(tokensEob);
  const setDash = new Set(tokensDash);
  if (setEob.size === setDash.size && Array.from(setEob).every((t2) => setDash.has(t2))) return true;
  const variantsEob = nameVariants(eobName);
  const variantsDash = nameVariants(dashName);
  for (const ve of variantsEob) {
    for (const vd of variantsDash) {
      if (ve === vd) return true;
    }
  }
  if (suffixTolerantMatch(tokensEob, tokensDash)) return true;
  return false;
}
function findMatchingPatient(eobName, patients) {
  const exact = patients.find(
    (p) => normalizeName(p.name) === normalizeName(eobName)
  );
  if (exact) return exact;
  return patients.find((p) => fuzzyNameMatch(eobName, p.name)) ?? null;
}
function isNameSubsequence(shorter, longer) {
  let i = 0;
  for (const token of longer) {
    if (token === shorter[i]) i++;
    if (i === shorter.length) return true;
  }
  return shorter.length === 0;
}
function isCandidateNameMatch(eobName, dashName) {
  if (!eobName || !dashName) return false;
  const tokensEob = tokenize(eobName);
  const tokensDash = tokenize(dashName);
  if (tokensEob.length === tokensDash.length) return false;
  if (tokensEob.length < 2 || tokensDash.length < 2) return false;
  const [shorter, longer] = tokensEob.length < tokensDash.length ? [tokensEob, tokensDash] : [tokensDash, tokensEob];
  return isNameSubsequence(shorter, longer);
}
function classifyPatientMatch(eobName, patients) {
  const exactMatches = patients.filter((p) => normalizeName(p.name) === normalizeName(eobName));
  const safeMatches = exactMatches.length > 0 ? exactMatches : patients.filter((p) => fuzzyNameMatch(eobName, p.name));
  if (safeMatches.length === 1) return { confirmed: safeMatches[0], candidates: [] };
  if (safeMatches.length > 1) {
    return { confirmed: null, candidates: safeMatches };
  }
  return { confirmed: null, candidates: patients.filter((p) => isCandidateNameMatch(eobName, p.name)) };
}
var NAME_SUFFIXES;
var init_nameMatch = __esm({
  "shared/nameMatch.ts"() {
    "use strict";
    NAME_SUFFIXES = /* @__PURE__ */ new Set([
      "JR",
      "SR",
      "II",
      "III",
      "IV",
      "V",
      "MD",
      "DO",
      "PT",
      "DPT",
      "RN",
      "PHD",
      "ESQ"
    ]);
  }
});

// server/vercelEntry.ts
import "dotenv/config";
import express2 from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;
var AXIOS_TIMEOUT_MS = 3e4;
var UNAUTHED_ERR_MSG = "Please login (10001)";
var NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
var PASSWORD_CHANGE_REQUIRED_ERR_MSG = "Password change required (10003)";
var MIN_CLINIC_PASSWORD_LENGTH = 8;

// server/_core/oauth.ts
init_db();

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  const secure = isSecureRequest(req);
  return {
    httpOnly: true,
    path: "/",
    // SameSite=None is only valid alongside Secure — browsers silently drop
    // the cookie otherwise (e.g. on local http://localhost dev), which
    // looked like a successful login that never actually persisted a session.
    sameSite: secure ? "none" : "lax",
    secure
  };
}

// shared/_core/errors.ts
var HttpError = class extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
};
var ForbiddenError = (msg) => new HttpError(403, msg);

// server/_core/sdk.ts
init_db();
init_env();
import axios from "axios";
import { parse as parseCookieHeader } from "cookie";
import { SignJWT, jwtVerify } from "jose";
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
var EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
var GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
var GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;
var OAuthService = class {
  constructor(client) {
    this.client = client;
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }
  decodeState(state) {
    const redirectUri = atob(state);
    return redirectUri;
  }
  async getTokenByCode(code, state) {
    const payload = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state)
    };
    const { data } = await this.client.post(
      EXCHANGE_TOKEN_PATH,
      payload
    );
    return data;
  }
  async getUserInfoByToken(token) {
    const { data } = await this.client.post(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken
      }
    );
    return data;
  }
};
var createOAuthHttpClient = () => axios.create({
  baseURL: ENV.oAuthServerUrl,
  timeout: AXIOS_TIMEOUT_MS
});
var SDKServer = class {
  client;
  oauthService;
  constructor(client = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }
  deriveLoginMethod(platforms, fallback) {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set(
      platforms.filter((p) => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (set.has("REGISTERED_PLATFORM_MICROSOFT") || set.has("REGISTERED_PLATFORM_AZURE"))
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }
  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(code, state) {
    return this.oauthService.getTokenByCode(code, state);
  }
  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken) {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken
    });
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  parseCookies(cookieHeader) {
    if (!cookieHeader) {
      return /* @__PURE__ */ new Map();
    }
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }
  getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }
  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(openId, options = {}) {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || ""
      },
      options
    );
  }
  async signSession(payload, options = {}) {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1e3);
    const secretKey = this.getSessionSecret();
    const claims = {
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name
    };
    if (payload.authType === "clinic") {
      claims.authType = payload.authType;
      claims.clinicUserId = payload.clinicUserId;
      claims.tokenVersion = payload.tokenVersion;
    }
    return new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expirationSeconds).sign(secretKey);
  }
  /** Create a clinic staff session carrying the staff identity + token_version
   * needed to enforce archived/stale-session checks on every request. */
  async createClinicSessionToken(params, options = {}) {
    return this.signSession(
      {
        openId: `clinic_${params.username}`,
        appId: ENV.appId,
        name: params.username,
        authType: "clinic",
        clinicUserId: params.clinicUserId,
        tokenVersion: params.tokenVersion
      },
      options
    );
  }
  async verifySession(cookieValue) {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }
    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"]
      });
      const { openId, appId, name, authType, clinicUserId, tokenVersion } = payload;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }
      if (authType === "clinic") {
        if (!isNonEmptyString(clinicUserId) || typeof tokenVersion !== "number") {
          console.warn("[Auth] Clinic session payload missing required fields");
          return null;
        }
        return { openId, appId, name, authType: "clinic", clinicUserId, tokenVersion };
      }
      return { openId, appId, name };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }
  async getUserInfoWithJwt(jwtToken) {
    const payload = {
      jwtToken,
      projectId: ENV.appId
    };
    const { data } = await this.client.post(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  async authenticateRequest(req) {
    const cookies = this.parseCookies(req.headers.cookie);
    const sessionCookie = cookies.get(COOKIE_NAME);
    const session = await this.verifySession(sessionCookie);
    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }
    if (session.authType === "clinic") {
      return this.authenticateClinicSession(session);
    }
    if (session.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
      const userInfo = await this.getUserInfoWithJwt(sessionCookie ?? "");
      const taskUid = userInfo.taskUid ?? null;
      if (!taskUid) {
        throw ForbiddenError("Cron session missing task_uid");
      }
      return buildCronUser(userInfo);
    }
    const sessionUserId = session.openId;
    const signedInAt = /* @__PURE__ */ new Date();
    let user = await getUserByOpenId(sessionUserId);
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionCookie ?? "");
        await upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt
        });
        user = await getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }
    if (!user) {
      throw ForbiddenError("User not found");
    }
    await upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt
    });
    return user;
  }
  /** Resolves a clinic staff session against the current clinic_users row on
   * every request — this is what makes archived accounts and stale
   * token_version reject already-issued sessions, not just new logins. */
  async authenticateClinicSession(session) {
    const clinicUser = await getClinicUserById(session.clinicUserId);
    if (!clinicUser) {
      throw ForbiddenError("Clinic session invalid");
    }
    if (clinicUser.status !== "active") {
      throw ForbiddenError("Account is not active");
    }
    if (clinicUser.tokenVersion !== session.tokenVersion) {
      throw ForbiddenError("Session expired, please sign in again");
    }
    const signedInAt = /* @__PURE__ */ new Date();
    const syntheticOpenId = session.openId;
    let user = await getUserByOpenId(syntheticOpenId);
    if (!user) {
      await upsertUser({
        openId: syntheticOpenId,
        name: clinicUser.username,
        email: null,
        loginMethod: "password",
        lastSignedIn: signedInAt
      });
      user = await getUserByOpenId(syntheticOpenId);
    }
    if (!user) {
      throw ForbiddenError("User not found");
    }
    await upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt
    });
    const clinicStaffInfo = {
      clinicUserId: clinicUser.id,
      username: clinicUser.username,
      name: clinicUser.name,
      email: clinicUser.email,
      department: clinicUser.department,
      role: clinicUser.role,
      mustChangePassword: clinicUser.mustChangePassword
    };
    return { ...user, clinicUser: clinicStaffInfo };
  }
};
var CRON_OPEN_ID_PREFIX = "cron_";
function buildCronUser(userInfo) {
  const now = /* @__PURE__ */ new Date();
  return {
    id: "00000000-0000-0000-0000-000000000000",
    openId: userInfo.openId,
    name: userInfo.name || "Manus Scheduled Task",
    email: null,
    loginMethod: null,
    role: "user",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    taskUid: userInfo.taskUid ?? void 0,
    isCron: true
  };
}
var sdk = new SDKServer();

// server/_core/oauth.ts
function getQueryParam(req, key) {
  const value = req.query[key];
  return typeof value === "string" ? value : void 0;
}
function registerOAuthRoutes(app2) {
  app2.get("/api/oauth/callback", async (req, res) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }
    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }
      await upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: /* @__PURE__ */ new Date()
      });
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}

// server/_core/storageProxy.ts
init_env();

// server/_core/requireAuth.ts
async function requireAuthenticatedUser(req, res, next) {
  try {
    await sdk.authenticateRequest(req);
    next();
  } catch {
    res.status(401).json({ error: "Authentication required" });
  }
}

// server/_core/storageProxy.ts
function registerStorageProxy(app2) {
  app2.get("/manus-storage/*", requireAuthenticatedUser, async (req, res) => {
    const key = req.params[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }
    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/"
      );
      forgeUrl.searchParams.set("path", key);
      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` }
      });
      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }
      const { url } = await forgeResp.json();
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}

// server/claimUpload.ts
import { Router } from "express";
import multer from "multer";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// server/_core/llm.ts
init_env();
var ensureArray = (value) => Array.isArray(value) ? value : [value];
var normalizeContentPart = (part) => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }
  if (part.type === "text") {
    return part;
  }
  if (part.type === "image_url") {
    return part;
  }
  if (part.type === "file_url") {
    return part;
  }
  if (part.type === "file") {
    return part;
  }
  throw new Error("Unsupported message content part");
};
var normalizeMessage = (message) => {
  const { role, name, tool_call_id } = message;
  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content).map((part) => typeof part === "string" ? part : JSON.stringify(part)).join("\n");
    return {
      role,
      name,
      tool_call_id,
      content
    };
  }
  const contentParts = ensureArray(message.content).map(normalizeContentPart);
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text
    };
  }
  return {
    role,
    name,
    content: contentParts
  };
};
var normalizeToolChoice = (toolChoice, tools) => {
  if (!toolChoice) return void 0;
  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }
  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }
    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }
    return {
      type: "function",
      function: { name: tools[0].function.name }
    };
  }
  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name }
    };
  }
  return toolChoice;
};
var normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema
}) => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (explicitFormat.type === "json_schema" && !explicitFormat.json_schema?.schema) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }
  const schema = outputSchema || output_schema;
  if (!schema) return void 0;
  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }
  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...typeof schema.strict === "boolean" ? { strict: schema.strict } : {}
    }
  };
};
var RETRY_MAX_RETRIES = 4;
var RETRY_BASE_DELAY_MS = 500;
var RETRY_MAX_DELAY_MS = 3e4;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var parseRetryAfter = (value) => {
  if (!value) return void 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1e3);
  const at = Date.parse(value);
  return Number.isNaN(at) ? void 0 : Math.max(0, at - Date.now());
};
var computeBackoffDelay = (attempt, retryAfterMs) => {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  const jittered = cap / 2 + Math.random() * (cap / 2);
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), RETRY_MAX_DELAY_MS);
};
var fetchWithBackoff = async (url, init) => {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || attempt === RETRY_MAX_RETRIES) {
        return response;
      }
      const retryAfterMs = parseRetryAfter(
        response.headers.get("retry-after")
      );
      try {
        await response.body?.cancel();
      } catch {
      }
      console.warn(
        `[LLM:${ENV.aiProvider}] retry ${attempt + 1}/${RETRY_MAX_RETRIES} after status ${response.status}`
      );
      await sleep(computeBackoffDelay(attempt, retryAfterMs));
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_MAX_RETRIES) throw error;
      console.warn(
        `[LLM:${ENV.aiProvider}] retry ${attempt + 1}/${RETRY_MAX_RETRIES} after network error`
      );
      await sleep(computeBackoffDelay(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("LLM request failed after exhausting retries");
};
var REQUEST_TIMEOUT_MS = 9e4;
var fetchWithTimeout = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchWithBackoff(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
var resolveOpenAIUrl = () => "https://api.openai.com/v1/chat/completions";
async function invokeOpenAI(params) {
  if (!ENV.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
    model,
    maxTokens,
    max_tokens
  } = params;
  const payload = {
    model: model || ENV.openaiModel,
    messages: messages.map(normalizeMessage)
  };
  if (tools && tools.length > 0) {
    payload.tools = tools;
  }
  const normalizedToolChoice = normalizeToolChoice(toolChoice || tool_choice, tools);
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }
  const resolvedMaxTokens = max_tokens ?? maxTokens;
  if (typeof resolvedMaxTokens === "number") {
    payload.max_tokens = resolvedMaxTokens;
  }
  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema
  });
  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }
  const response = await fetchWithTimeout(resolveOpenAIUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.openaiApiKey}`
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM invoke failed: ${response.status} ${response.statusText} \u2013 ${errorText}`);
  }
  return await response.json();
}
var ANTHROPIC_API_VERSION = "2023-06-01";
var ANTHROPIC_PDF_BETA = "pdfs-2024-09-25";
var ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;
var ANTHROPIC_TOOL_NAME = "emit_structured_output";
var resolveAnthropicUrl = () => "https://api.anthropic.com/v1/messages";
var dataUriToBase64 = (dataUri) => {
  const commaIdx = dataUri.indexOf(",");
  return commaIdx === -1 ? dataUri : dataUri.slice(commaIdx + 1);
};
var toAnthropicContentBlock = (part) => {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "image_url") {
    return { type: "image", source: { type: "url", url: part.image_url.url } };
  }
  if (part.type === "file") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: dataUriToBase64(part.file.file_data)
      },
      title: part.file.filename
    };
  }
  if (part.type === "file_url") {
    if (part.file_url.mime_type === "application/pdf") {
      return { type: "document", source: { type: "url", url: part.file_url.url } };
    }
    return { type: "image", source: { type: "url", url: part.file_url.url } };
  }
  throw new Error("Unsupported message content part for Anthropic provider");
};
var buildAnthropicRequest = (messages) => {
  let systemPrompt = "";
  const anthropicMessages = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = ensureArray(message.content).map((part) => typeof part === "string" ? part : part.type === "text" ? part.text : "").filter(Boolean).join("\n\n");
      systemPrompt = systemPrompt ? `${systemPrompt}

${text}` : text;
      continue;
    }
    if (message.role === "tool" || message.role === "function") {
      const text = ensureArray(message.content).map((part) => typeof part === "string" ? part : JSON.stringify(part)).join("\n");
      anthropicMessages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: text }]
      });
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const parts = ensureArray(message.content);
    if (parts.length === 1 && typeof parts[0] === "string") {
      anthropicMessages.push({ role, content: parts[0] });
      continue;
    }
    const blocks = parts.map(
      (part) => typeof part === "string" ? { type: "text", text: part } : toAnthropicContentBlock(part)
    );
    anthropicMessages.push({ role, content: blocks });
  }
  return { systemPrompt, anthropicMessages };
};
async function invokeAnthropic(params) {
  if (!ENV.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  const {
    messages,
    model,
    maxTokens,
    max_tokens,
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
    tools,
    toolChoice,
    tool_choice
  } = params;
  const { systemPrompt, anthropicMessages } = buildAnthropicRequest(messages);
  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema
  });
  const payload = {
    model: model || ENV.anthropicModel,
    max_tokens: max_tokens ?? maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: anthropicMessages
  };
  if (systemPrompt) payload.system = systemPrompt;
  let forcedToolName;
  if (normalizedResponseFormat?.type === "json_schema") {
    forcedToolName = ANTHROPIC_TOOL_NAME;
    payload.tools = [
      {
        name: ANTHROPIC_TOOL_NAME,
        description: `Emit the extraction result matching the "${normalizedResponseFormat.json_schema.name}" schema.`,
        input_schema: normalizedResponseFormat.json_schema.schema
      }
    ];
    payload.tool_choice = { type: "tool", name: ANTHROPIC_TOOL_NAME };
  } else if (tools && tools.length > 0) {
    payload.tools = tools.map((t2) => ({
      name: t2.function.name,
      description: t2.function.description,
      input_schema: t2.function.parameters ?? { type: "object", properties: {} }
    }));
    const normalizedChoice = normalizeToolChoice(toolChoice || tool_choice, tools);
    if (normalizedChoice && normalizedChoice !== "none" && normalizedChoice !== "auto") {
      payload.tool_choice = { type: "tool", name: normalizedChoice.function.name };
    } else if (normalizedChoice === "auto") {
      payload.tool_choice = { type: "auto" };
    }
  }
  const usesPdf = anthropicMessages.some(
    (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "document")
  );
  const response = await fetchWithTimeout(resolveAnthropicUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ENV.anthropicApiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      ...usesPdf ? { "anthropic-beta": ANTHROPIC_PDF_BETA } : {}
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM invoke failed: ${response.status} ${response.statusText} \u2013 ${errorText}`);
  }
  const data = await response.json();
  const blocks = Array.isArray(data.content) ? data.content : [];
  let content = "";
  const toolUseBlock = blocks.find((b) => b.type === "tool_use" && (!forcedToolName || b.name === forcedToolName));
  if (toolUseBlock) {
    content = JSON.stringify(toolUseBlock.input ?? {});
  } else {
    content = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  const finishReasonMap = {
    end_turn: "stop",
    stop_sequence: "stop",
    max_tokens: "length",
    tool_use: "tool_calls"
  };
  return {
    id: data.id ?? `anthropic_${Date.now()}`,
    created: Math.floor(Date.now() / 1e3),
    model: data.model ?? payload.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReasonMap[data.stop_reason] ?? data.stop_reason ?? null
      }
    ],
    usage: data.usage ? {
      prompt_tokens: data.usage.input_tokens ?? 0,
      completion_tokens: data.usage.output_tokens ?? 0,
      total_tokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0)
    } : void 0
  };
}
var resolveOpenRouterUrl = () => "https://openrouter.ai/api/v1/chat/completions";
async function invokeOpenRouter(params) {
  if (!ENV.openrouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }
  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
    model,
    thinking,
    reasoning,
    maxTokens,
    max_tokens
  } = params;
  const payload = {
    model: model || ENV.openrouterModel,
    messages: messages.map(normalizeMessage)
  };
  if (tools && tools.length > 0) {
    payload.tools = tools;
  }
  const normalizedToolChoice = normalizeToolChoice(toolChoice || tool_choice, tools);
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }
  const resolvedMaxTokens = max_tokens ?? maxTokens;
  if (typeof resolvedMaxTokens === "number") {
    payload.max_tokens = resolvedMaxTokens;
  }
  if (thinking) payload.thinking = thinking;
  if (reasoning) payload.reasoning = reasoning;
  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema
  });
  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }
  const response = await fetchWithTimeout(resolveOpenRouterUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.openrouterApiKey}`,
      "HTTP-Referer": "https://nyc-dashboard-eight.vercel.app",
      "X-Title": "NYC Home Rehab Claims Dashboard"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM invoke failed: ${response.status} ${response.statusText} \u2013 ${errorText}`);
  }
  return await response.json();
}
async function invokeLLM(params) {
  const provider = ENV.aiProvider;
  try {
    if (provider === "openrouter") {
      return await invokeOpenRouter(params);
    }
    if (provider === "anthropic") {
      return await invokeAnthropic(params);
    }
    if (provider === "openai") {
      return await invokeOpenAI(params);
    }
    throw new Error(`Unsupported AI_PROVIDER "${provider}". Use "openai", "anthropic", or "openrouter".`);
  } catch (error) {
    console.error(`[LLM:${provider}] invoke failed:`, error instanceof Error ? error.message : error);
    throw error;
  }
}

// server/claimUpload.ts
init_env();

// server/insuranceTemplates.ts
var PatientBoundaryError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PatientBoundaryError";
  }
};
function parseDate(raw) {
  if (!raw) return null;
  const clean = raw.trim();
  const m1 = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m1) return `${m1[3]}-${m1[1].padStart(2, "0")}-${m1[2].padStart(2, "0")}`;
  const m2 = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m2) {
    const year = parseInt(m2[3], 10);
    const fullYear = year > 50 ? 1900 + year : 2e3 + year;
    return `${fullYear}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`;
  }
  const m3 = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m3) return clean;
  return null;
}
function parseMoney(raw) {
  if (!raw) return null;
  const clean = raw.replace(/[$,\s]/g, "").trim();
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}
function clampVisitNumber(n) {
  return n >= 1 && n <= 6 ? n : null;
}
function detectMeritain(text) {
  return /meritain health/i.test(text) || /epc draft #/i.test(text) || /administered by:\s*meritain/i.test(text);
}
function parseMeritainEOB(text) {
  return parseMeritainEOBWithGroups(text).flatMap((g) => g.claims);
}
function parseMeritainEOBWithGroups(text) {
  const epcDraftMatch = text.match(/EPC Draft #:\s*\n?\s*(\d+)/);
  const paymentDateMatch = text.match(/Payment Date:\s*\n?\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  const docPaymentDate = paymentDateMatch ? parseDate(paymentDateMatch[1]) : null;
  const epcDraftNo = epcDraftMatch ? epcDraftMatch[1].trim() : null;
  const patientClaimsMap = /* @__PURE__ */ new Map();
  const patientSections = text.split(/(?=Patient:\s+[A-Z])/g);
  for (let sIdx = 0; sIdx < patientSections.length; sIdx++) {
    let section = patientSections[sIdx];
    if (!section.includes("Claim #:")) continue;
    const claimTotalIdx = section.indexOf("Claim Total:");
    if (claimTotalIdx !== -1) {
      section = section.slice(0, claimTotalIdx);
    }
    const nameMatch = section.match(/Patient:\s+([A-Z][A-Z\s]+?)(?=\s{2,}|\n)/);
    const patientName = nameMatch ? nameMatch[1].trim() : "UNKNOWN";
    const patientHeaderCount = (section.match(/Patient\s*:\s*[A-Z]/g) || []).length;
    if (patientHeaderCount > 1) {
      throw new PatientBoundaryError(
        `Patient boundaries could not be determined (section ${sIdx} contains ${patientHeaderCount} patient headers that should have been split into separate sections).`
      );
    }
    const claimMatch = section.match(/Claim #:\s+([A-Z0-9]+)/);
    const claimNo = claimMatch ? claimMatch[1].trim() : null;
    const groupMatch = section.match(/Group Name\/Check:\s+(\S+)/);
    const groupName = groupMatch ? groupMatch[1].trim() : null;
    const checkEftMatch = groupName ? groupName.match(/\/([\d]+)$/) : null;
    const checkEftNumber = checkEftMatch ? checkEftMatch[1] : null;
    if (!patientClaimsMap.has(patientName)) {
      patientClaimsMap.set(patientName, []);
    }
    const patientClaims = patientClaimsMap.get(patientName);
    const serviceLinePattern = /(\d{1,2}\/\d{1,2}\/\d{2,4})-(\d{1,2}\/\d{1,2}\/\d{2,4})\s+([A-Z0-9]+)\s+\d+\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)(?:\s+(\d+\.\d+))?/g;
    let lineMatch;
    while ((lineMatch = serviceLinePattern.exec(section)) !== null) {
      const rawDate = lineMatch[1];
      const cptCode = lineMatch[3];
      const totalCharge = parseMoney(lineMatch[4]);
      const notPaymentAmount = parseMoney(lineMatch[5]);
      const coIns = parseMoney(lineMatch[9]) ?? 0;
      const coPay = parseMoney(lineMatch[10]) ?? 0;
      const deductible = parseMoney(lineMatch[11]) ?? 0;
      const nonCov = parseMoney(lineMatch[12]) ?? 0;
      const coPayAmountFromLine = coPay;
      const patientDue = coIns + coPay + deductible + nonCov;
      const parsedDate = parseDate(rawDate);
      let claimStatus = "submitted";
      if (notPaymentAmount !== null && notPaymentAmount > 0) claimStatus = "approved";
      else if (notPaymentAmount === 0) claimStatus = "denied";
      patientClaims.push({
        dateOfService: parsedDate,
        cptCodes: cptCode || null,
        // "total charge" is the provider's billed amount for this line,
        // printed directly in Meritain's service-line table (group 4) —
        // the same concept as a CMS-1500's Box 24F charge, safe to carry
        // through on a Reimbursement/EOB upload too.
        chargeAmount: totalCharge,
        insuranceReimbursement: notPaymentAmount,
        patientAmountPaid: coPayAmountFromLine,
        // groupName ("16404/137040261") is the Group Name/Check billing
        // identifier printed on the EOB, not the payer name — insuranceBilled
        // must never hold the insurance company name (see anti-hallucination
        // check in aiClaimExtractor.ts).
        insuranceBilled: groupName,
        oaClaimNumber: claimNo,
        claimStatus,
        checkDate: docPaymentDate,
        dateReceived: docPaymentDate,
        referenceNo: epcDraftNo,
        checkNumberVirtualCard: checkEftNumber,
        // EOBs never print the CMS-1500 Box 24 line number — visitNumber
        // comes only from a CMS-1500 upload and is preserved through the
        // upsert merge (see enforceFieldBoundary's CMS1500_ONLY_FIELDS).
        visitNumber: null,
        placeOfService: null,
        // Meritain's service-line table (see the column list above this
        // function) genuinely does not print per-line units, diagnosis
        // codes, or modifiers — there's no source data to extract, unlike
        // chargeAmount above. REIMBURSEMENT_LINE_FIELDS_TO_BACKFILL in
        // claimUpload.ts will fill these from the AI backfill pass if a
        // future Meritain layout variant does print them.
        unitsBilled: null,
        diagnosisCodes: null,
        modifier: null,
        patientAmountDue: patientDue,
        // 0 is a valid value meaning no patient obligation
        claimSubmittedDate: null,
        expireBcbsClaimNumber: null,
        paymentReceived: notPaymentAmount,
        lmn: null,
        dateOfAppeal: null,
        notes: null
      });
    }
  }
  const result = [];
  for (const [patientName, flatClaims] of Array.from(patientClaimsMap.entries())) {
    if (flatClaims.length === 0) continue;
    const dateMap = /* @__PURE__ */ new Map();
    for (const claim of flatClaims) {
      const dateKey = claim.dateOfService || "no-date";
      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, { ...claim, cptLines: [] });
      }
      const group = dateMap.get(dateKey);
      group.cptLines.push({
        cptCodes: claim.cptCodes ?? null,
        chargeAmount: claim.chargeAmount ?? null,
        insuranceReimbursement: claim.insuranceReimbursement ?? null,
        patientAmountPaid: claim.patientAmountPaid ?? null,
        patientAmountDue: claim.patientAmountDue ?? null,
        unitsBilled: claim.unitsBilled ?? null,
        modifier: claim.modifier ?? null,
        diagnosisCodes: claim.diagnosisCodes ?? null
      });
    }
    result.push({ patientName, claims: Array.from(dateMap.values()) });
  }
  return result;
}
function detectGlobeLife(text) {
  return /globe life/i.test(text) && (/medicare control #/i.test(text) || /explanation of payment/i.test(text) || /payee id/i.test(text));
}
function parseGlobeLifeHeaderDate(raw) {
  const months = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12"
  };
  const m = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = months[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[2].padStart(2, "0")}`;
}
function parseGlobeLifeEOB(text) {
  return parseGlobeLifeEOBWithGroups(text).flatMap((g) => g.claims.flatMap((c) => {
    const { cptLines, unresolvedClaimTotal: _unresolvedClaimTotal, ...base } = c;
    if (cptLines.length === 0) return [base];
    return cptLines.map((line) => ({ ...base, ...line }));
  }));
}
function findValueNearLabel(text, label, valuePattern, maxLines = 8) {
  const sameLine = text.match(new RegExp(label.source + "[ \\t]+(" + valuePattern.source + ")"));
  if (sameLine) return sameLine[1].trim();
  const labelMatch = text.match(label);
  if (!labelMatch || labelMatch.index === void 0) return null;
  const after = text.slice(labelMatch.index + labelMatch[0].length);
  const lines = after.split("\n").slice(0, maxLines);
  for (const line of lines) {
    const m = line.trim().match(new RegExp("^(" + valuePattern.source + ")$"));
    if (m) return m[1].trim();
  }
  return null;
}
function parseGlobeLifeEOBWithGroups(text) {
  const checkNumber = findValueNearLabel(text, /Check Number:/, /\d{6,}/);
  const paymentDateRaw = findValueNearLabel(text, /Payment Date:/, /[A-Za-z]+ \d{1,2},\s*\d{4}/);
  const docPaymentDate = paymentDateRaw ? parseGlobeLifeHeaderDate(paymentDateRaw) : null;
  const patientClaimsMap = /* @__PURE__ */ new Map();
  const blockStartRe = /^[A-Z][A-Z .,'-]{3,}\n[ \t]*Patient Acct #:/m;
  const validateHeaderRe = /^[A-Z][A-Z .,'-]{3,}\s*\n\s*Patient Acct #:/gm;
  const patientSections = text.split(new RegExp("(?=" + blockStartRe.source + ")", "m"));
  for (let sIdx = 0; sIdx < patientSections.length; sIdx++) {
    let section = patientSections[sIdx];
    if (!/medicare control #/i.test(section)) continue;
    const totalsIdx = section.search(/\bTotals\b/);
    const totalsLine = totalsIdx !== -1 ? section.slice(totalsIdx, section.indexOf("\n", totalsIdx) + 1 || void 0) : "";
    if (totalsIdx !== -1) {
      const afterTotalsLineEnd = section.indexOf("\n", totalsIdx);
      section = section.slice(0, afterTotalsLineEnd !== -1 ? afterTotalsLineEnd : void 0);
    }
    const nameMatch = section.match(/^([A-Z][A-Z .,'-]{3,}?)\s*\n\s*Patient Acct #:/m);
    const patientName = nameMatch ? nameMatch[1].trim() : "UNKNOWN";
    const blockHeaderCount = (section.match(validateHeaderRe) || []).length;
    if (blockHeaderCount > 1) {
      throw new PatientBoundaryError(
        `Patient boundaries could not be determined (section ${sIdx} contains ${blockHeaderCount} patient headers that should have been split into separate sections).`
      );
    }
    const claimNo = findValueNearLabel(section, /Medicare Control #:/, /\d{10,}/);
    if (!patientClaimsMap.has(patientName)) {
      patientClaimsMap.set(patientName, []);
    }
    const patientClaims = patientClaimsMap.get(patientName);
    const serviceLinePattern = /(\d{1,2}\/\d{1,2}\/\d{2,4})-(\d{1,2}\/\d{1,2}\/\d{2,4})\s+([A-Z0-9]+)\s+\(([A-Z0-9,]+)\)\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s+([A-Z]{1,3}-\d+)/g;
    const dateMap = /* @__PURE__ */ new Map();
    const datesSeen = /* @__PURE__ */ new Set();
    let lineMatch;
    while ((lineMatch = serviceLinePattern.exec(section)) !== null) {
      const parsedDate = parseDate(lineMatch[1]);
      const cptCode = lineMatch[3];
      const modifier = lineMatch[4] || null;
      const billed = parseMoney(lineMatch[5]);
      const dateKey = parsedDate || "no-date";
      datesSeen.add(dateKey);
      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, {
          dateOfService: parsedDate,
          cptCodes: null,
          chargeAmount: null,
          // Deliberately null, never invented from Medicare Allowed /
          // Adjustments / the block Totals row -- see unresolvedClaimTotal.
          insuranceReimbursement: null,
          patientAmountPaid: null,
          patientAmountDue: null,
          insuranceBilled: null,
          oaClaimNumber: claimNo,
          claimStatus: "submitted",
          checkDate: docPaymentDate,
          dateReceived: docPaymentDate,
          referenceNo: null,
          checkNumberVirtualCard: checkNumber,
          visitNumber: null,
          placeOfService: null,
          unitsBilled: null,
          diagnosisCodes: null,
          claimSubmittedDate: null,
          expireBcbsClaimNumber: null,
          paymentReceived: null,
          lmn: null,
          dateOfAppeal: null,
          notes: null,
          cptLines: [],
          unresolvedClaimTotal: null
        });
      }
      dateMap.get(dateKey).cptLines.push({
        cptCodes: cptCode,
        chargeAmount: billed,
        insuranceReimbursement: null,
        patientAmountPaid: null,
        patientAmountDue: null,
        unitsBilled: null,
        modifier,
        diagnosisCodes: null
      });
    }
    const groups = Array.from(dateMap.values());
    for (const group of groups) {
      if (group.cptLines.length > 0) {
        group.cptCodes = group.cptLines.map((l) => l.cptCodes).filter(Boolean).join(", ") || null;
        group.chargeAmount = group.cptLines.reduce((sum, l) => sum + (l.chargeAmount ?? 0), 0);
      }
    }
    const totalsMatch = totalsLine.match(/Totals\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})/);
    if (totalsMatch && groups.length === 1 && datesSeen.size === 1) {
      const planPaid = parseMoney(totalsMatch[4]);
      const patientResp = parseMoney(totalsMatch[5]);
      if (planPaid !== null) {
        groups[0].unresolvedClaimTotal = {
          planPaid,
          patientResponsibility: patientResp,
          cptCount: groups[0].cptLines.length
        };
      }
    }
    patientClaims.push(...groups);
  }
  const result = [];
  for (const [patientName, claims] of Array.from(patientClaimsMap.entries())) {
    if (claims.length === 0) continue;
    result.push({ patientName, claims });
  }
  return result;
}
function parseIndexedDiagnosisCodes(text) {
  const map = /* @__PURE__ */ new Map();
  const box21Start = text.search(/DIAGNOSIS\s+OR\s+NATURE\s+OF\s+ILLNESS/i);
  const box24Start = text.search(/24\.\s*A\.?\s*DATE|DATE\(S\)\s*OF\s*SERVICE/i);
  const box21End = box24Start >= 0 ? box24Start : text.length;
  const box21Text = box21Start >= 0 ? text.slice(box21Start, box21End) : text.slice(0, box21End);
  const labeledRe = /(?<![\w.])([1-9]|1[0-2]|[A-L])[.\)]?\s+([A-Z]\d{2,3}\.\d{1,4})\b/g;
  const labeled = [];
  let lm;
  while ((lm = labeledRe.exec(box21Text)) !== null) {
    const label = lm[1];
    const idx = /^[A-L]$/.test(label) ? label.charCodeAt(0) - 64 : parseInt(label, 10);
    labeled.push({ idx, code: lm[2] });
  }
  if (labeled.length > 0) {
    for (const { idx, code } of labeled) if (!map.has(idx)) map.set(idx, code);
    return map;
  }
  const plainRe = /([A-Z]\d{2,3}\.\d{1,4})/g;
  let i = 0;
  let pm;
  while ((pm = plainRe.exec(box21Text)) !== null) {
    i++;
    if (!map.has(i)) map.set(i, pm[1]);
  }
  return map;
}
function resolveDiagnosisPointer(pointerToken, indexed) {
  if (!pointerToken) return null;
  const tokens = pointerToken.toUpperCase().match(/[1-9]|1[0-2]|[A-L]/g);
  if (!tokens) return null;
  const codes = [];
  for (const t2 of tokens) {
    const idx = /^[A-L]$/.test(t2) ? t2.charCodeAt(0) - 64 : parseInt(t2, 10);
    const code = indexed.get(idx);
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes.length > 0 ? codes.join(", ") : null;
}
function resolveLineDiagnosisCodes(indexed, pointerToken, allDiagCodesFallback) {
  if (indexed.size <= 1) return allDiagCodesFallback;
  return resolveDiagnosisPointer(pointerToken, indexed);
}
function parseCMS1500Date(mm, dd, yy) {
  const m = mm.trim().padStart(2, "0");
  const d = dd.trim().padStart(2, "0");
  const y = yy.trim();
  if (!m || !d || !y) return null;
  const year = y.length === 2 ? parseInt(y) > 50 ? 1900 + parseInt(y) : 2e3 + parseInt(y) : parseInt(y);
  return `${year}-${m}-${d}`;
}
function parseCMS1500(text) {
  let patientName = "UNKNOWN";
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (/NAME.*Last.*First|INSURED'S NAME|OTHER INSURED|REFERRING|PROVIDER/i.test(trimmed)) continue;
    const m = trimmed.match(/^([A-Za-z][a-zA-Z'\-]+,\s*[A-Za-z][a-zA-Z'\-]+(?:\s+[A-Za-z])?)/);
    if (m && m[1].length > 5) {
      patientName = m[1].trim().toUpperCase();
      break;
    }
  }
  const diagCodes = [];
  const diagPattern = /([A-Z]\d{2,3}\.\d{1,4})/g;
  let diagMatch;
  while ((diagMatch = diagPattern.exec(text)) !== null) {
    const code = diagMatch[1];
    if (!diagCodes.includes(code)) diagCodes.push(code);
  }
  const allDiagCodes = diagCodes.join(", ");
  const indexedDiagnoses = parseIndexedDiagnosisCodes(text);
  let dateSubmitted = null;
  const signedDateMatch = text.match(/SIGNED\s+SOF[\s\S]{0,200}DATE[\s\S]{0,50}(\d{2}\/\d{2}\/\d{4})/);
  if (signedDateMatch) {
    dateSubmitted = parseDate(signedDateMatch[1]);
  } else {
    const dateMatches = Array.from(text.matchAll(/(\d{2}\/\d{2}\/\d{4})/g));
    if (dateMatches.length > 0) {
      dateSubmitted = parseDate(dateMatches[dateMatches.length - 1][1]);
    }
  }
  const section24Idx = text.search(/24\.\s*A\.?\s*DATE|DATE\(S\)\s*OF\s*SERVICE/i);
  const serviceArea = section24Idx >= 0 ? text.slice(section24Idx) : text;
  const dateMap = /* @__PURE__ */ new Map();
  const compactPattern = /(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{1,2})\s+((?:9|G|H|T)\d{4})\s+([A-Z0-9 ]+?)\s+([A-Z]{2,6})\s+([\d,]+\.\d{2})\s+(\d+)/g;
  let cm2;
  let compactRowCounter = 0;
  while ((cm2 = compactPattern.exec(serviceArea)) !== null) {
    compactRowCounter++;
    const fromDate = parseCMS1500Date(cm2[1], cm2[2], cm2[3]);
    const placeOfService = cm2[7];
    const cptCode = cm2[8];
    const modifierTokens = cm2[9].trim().split(/\s+/);
    const modifier = modifierTokens[0];
    const inlinePointerCandidate = modifierTokens.length > 1 ? modifierTokens.slice(1).join("") : null;
    const letterPointerCandidate = /^[A-L]{1,6}$/.test(cm2[10]) ? cm2[10] : null;
    const pointerToken = inlinePointerCandidate || letterPointerCandidate || null;
    const lineDiagnosisCodes = resolveLineDiagnosisCodes(indexedDiagnoses, pointerToken, allDiagCodes || null);
    const chargeAmount = parseMoney(cm2[11]);
    const units = parseInt(cm2[12], 10);
    const visitNumber = clampVisitNumber(compactRowCounter);
    const dateKey = fromDate || "no-date";
    if (!dateMap.has(dateKey)) {
      dateMap.set(dateKey, {
        dateOfService: fromDate,
        placeOfService,
        diagnosisCodes: lineDiagnosisCodes,
        claimSubmittedDate: dateSubmitted,
        visitNumber,
        cptCodes: null,
        chargeAmount: null,
        insuranceReimbursement: null,
        patientAmountPaid: null,
        patientAmountDue: null,
        unitsBilled: null,
        modifier: null,
        cptLines: [],
        // Reimbursement/EOB-only fields — explicit null (not undefined) since
        // a CMS-1500 form never carries claim/check/payment data.
        oaClaimNumber: null,
        checkDate: null,
        checkNumberVirtualCard: null,
        expireBcbsClaimNumber: null
      });
    }
    dateMap.get(dateKey).cptLines.push({
      cptCodes: cptCode,
      chargeAmount,
      insuranceReimbursement: null,
      patientAmountPaid: null,
      patientAmountDue: null,
      unitsBilled: units,
      modifier,
      diagnosisCodes: lineDiagnosisCodes
    });
  }
  if (dateMap.size === 0) {
    const lines2 = serviceArea.split("\n");
    const cptLineRe = /\b((?:9|G|H|T)\d{4})\b/;
    const dateFragRe = /(?:I\s*)?(\d{2})\s*(?:I\s*)?(\d{2})\s*(?:I\s*)?(\d{2})\s*(?:I\s*)?(\d{2})\s*(?:I\s*)?(\d{2})\s*(?:I\s*)?(\d{2})\s*(?:I\s*)?(\d{1,2})\s*(?:I\s*)?/;
    let layoutRowCounter = 0;
    for (let i = 0; i < lines2.length; i++) {
      const cptMatch = lines2[i].match(cptLineRe);
      if (!cptMatch) continue;
      layoutRowCounter++;
      const cptCode = cptMatch[1];
      const windowStart = Math.max(0, i - 15);
      const windowEnd = Math.min(lines2.length - 1, i + 15);
      const window = lines2.slice(windowStart, windowEnd + 1).join("\n");
      let fromDate = null;
      let placeOfService = null;
      const dfm = window.match(dateFragRe);
      if (dfm) {
        fromDate = parseCMS1500Date(dfm[1], dfm[2], dfm[3]);
        placeOfService = dfm[7] || null;
      }
      if (!fromDate) {
        const preWindow = lines2.slice(windowStart, i + 1).join("\n");
        const twoDigits = [];
        const tdRe = /\b(\d{2})\b/g;
        let tdm;
        while ((tdm = tdRe.exec(preWindow)) !== null) {
          twoDigits.push(tdm[1]);
        }
        for (let j = 0; j < twoDigits.length - 2; j++) {
          const mm = parseInt(twoDigits[j], 10);
          const dd = parseInt(twoDigits[j + 1], 10);
          const yy = parseInt(twoDigits[j + 2], 10);
          if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && yy >= 0 && yy <= 99) {
            const fullYear = yy > 50 ? 1900 + yy : 2e3 + yy;
            if (fullYear >= 2020 && fullYear <= 2035) {
              fromDate = `${fullYear}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
              break;
            }
          }
        }
      }
      const cptLine = lines2[i];
      let posMatch = cptLine.match(/I\s*(\d{2})\s*I/);
      if (posMatch) placeOfService = posMatch[1];
      let modifier = null;
      const modWindow = lines2.slice(i, Math.min(lines2.length - 1, i + 5)).join(" ");
      const modMatch = modWindow.match(/\b(GP|59|25|51|76|77|KX|CO|GN|GO|GT|95|AT)\b/);
      if (modMatch) modifier = modMatch[1];
      let pointerToken = null;
      if (modMatch) {
        let afterModifier = modWindow.slice(modMatch.index + modMatch[0].length, modMatch.index + modMatch[0].length + 15);
        const chargeBoundary = afterModifier.match(/\d+\.\d{2}/);
        if (chargeBoundary) afterModifier = afterModifier.slice(0, chargeBoundary.index);
        const pointerMatch = afterModifier.match(/\b([1-9](?:,?[1-9]){0,3})\b/);
        if (pointerMatch) pointerToken = pointerMatch[1];
      }
      const lineDiagnosisCodes = resolveLineDiagnosisCodes(indexedDiagnoses, pointerToken, allDiagCodes || null);
      let chargeAmount = null;
      let units = null;
      const rowWindowStart = Math.max(0, i - 2);
      const rowWindowEnd = Math.min(lines2.length - 1, i + 3);
      const rowWindow = lines2.slice(rowWindowStart, rowWindowEnd + 1).join(" ");
      const chargeMatch = rowWindow.match(/(?<!\d)(\d{2,4})\s*I{0,3}\s*\.(\d{2})\b/);
      if (chargeMatch) {
        chargeAmount = parseFloat(`${chargeMatch[1]}.${chargeMatch[2]}`);
        const chargeEnd = chargeMatch.index + chargeMatch[0].length;
        const afterCharge = rowWindow.slice(chargeEnd, chargeEnd + 20);
        const afterUnitsMatch = afterCharge.match(/\b(\d{1,2})I?\b/);
        if (afterUnitsMatch) {
          units = parseInt(afterUnitsMatch[1], 10);
        } else {
          const beforeCharge = rowWindow.slice(Math.max(0, chargeMatch.index - 150), chargeMatch.index);
          const beforeMatches = Array.from(beforeCharge.matchAll(/\b(\d{1,2})I?\b/g));
          if (beforeMatches.length > 0) units = parseInt(beforeMatches[beforeMatches.length - 1][1], 10);
        }
      }
      const visitNumber = clampVisitNumber(layoutRowCounter);
      const dateKey = fromDate || "no-date";
      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, {
          dateOfService: fromDate,
          placeOfService,
          diagnosisCodes: lineDiagnosisCodes,
          claimSubmittedDate: dateSubmitted,
          visitNumber,
          cptCodes: null,
          chargeAmount: null,
          insuranceReimbursement: null,
          patientAmountPaid: null,
          patientAmountDue: null,
          unitsBilled: null,
          modifier: null,
          cptLines: []
        });
      }
      dateMap.get(dateKey).cptLines.push({
        cptCodes: cptCode,
        chargeAmount,
        insuranceReimbursement: null,
        patientAmountPaid: null,
        patientAmountDue: null,
        unitsBilled: units,
        modifier,
        diagnosisCodes: lineDiagnosisCodes
      });
    }
  }
  const claims = Array.from(dateMap.values());
  if (claims.length === 0) return [];
  for (const claim of claims) {
    if (claim.cptLines.length > 0) {
      const first = claim.cptLines[0];
      claim.cptCodes = claim.cptLines.map((l) => l.cptCodes).filter(Boolean).join(", ") || null;
      claim.chargeAmount = first.chargeAmount;
      claim.unitsBilled = first.unitsBilled;
      claim.modifier = first.modifier;
    }
  }
  return [{ patientName, claims }];
}
var TEMPLATES = [
  {
    name: "Meritain Health EOB",
    detect: (text, filename) => detectMeritain(text) || (filename ? /^epp_/i.test(filename) : false),
    parse: parseMeritainEOB
  },
  {
    name: "Globe Life Insurance EOB",
    detect: detectGlobeLife,
    parse: parseGlobeLifeEOB
  }
  // Add more templates here as new insurers are onboarded:
  // { name: 'Aetna EOB', detect: detectAetna, parse: parseAetnaEOB },
  // { name: 'BCBS Remittance', detect: detectBCBS, parse: parseBCBSRemittance },
  // { name: 'Cigna EOB', detect: detectCigna, parse: parseCignaEOB },
  // { name: 'Medicare Advantage EOB', detect: detectMedicare, parse: parseMedicareEOB },
];
function tryTemplateExtraction(text, filename) {
  for (const template of TEMPLATES) {
    if (template.detect(text, filename)) {
      const claims = template.parse(text);
      let patientGroups;
      if (template.name === "Meritain Health EOB") {
        patientGroups = parseMeritainEOBWithGroups(text);
      } else if (template.name === "Globe Life Insurance EOB") {
        patientGroups = parseGlobeLifeEOBWithGroups(text);
      }
      return {
        templateName: template.name,
        claims,
        patientGroups
      };
    }
  }
  return null;
}

// server/aiClaimExtractor.ts
init_env();
function recoverJson(raw) {
  const attempts = [
    raw,
    raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
  ];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt.trim());
    } catch {
    }
  }
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
    }
  }
  return null;
}
var KNOWN_INSURER_NAMES = [
  "aetna",
  "bcbs",
  "blue cross",
  "blue shield",
  "cigna",
  "unitedhealthcare",
  "united healthcare",
  "uhc",
  "humana",
  "meritain",
  "anthem",
  "medicare",
  "medicaid",
  "optum",
  "wellpoint",
  "molina",
  "kaiser",
  "tricare",
  "geico",
  "oxford",
  "empire",
  "health net",
  "centene",
  "ambetter"
];
function sanitizeInsuranceBilled(claim) {
  if (!claim.insuranceBilled) return;
  const lower = claim.insuranceBilled.toLowerCase();
  if (KNOWN_INSURER_NAMES.some((name) => lower.includes(name))) {
    claim.notes = [
      claim.notes,
      `\u26A0\uFE0F insuranceBilled "${claim.insuranceBilled}" looks like an insurance company name, not a billing identifier \u2014 cleared to null`
    ].filter(Boolean).join(" | ");
    claim.insuranceBilled = null;
  }
}
function sanitizeVisitNumber(claim) {
  if (claim.visitNumber === null || claim.visitNumber === void 0) return;
  const isCopyOfUnits = claim.unitsBilled != null && claim.visitNumber === claim.unitsBilled;
  const isCopyOfCharge = claim.chargeAmount != null && claim.visitNumber === Math.trunc(claim.chargeAmount);
  const isCopyOfCpt = claim.cptCodes != null && claim.cptCodes.trim() === String(claim.visitNumber);
  const outOfRange = claim.visitNumber < 1 || claim.visitNumber > 6;
  if (isCopyOfUnits || isCopyOfCharge || isCopyOfCpt || outOfRange) {
    const reason = outOfRange ? `outside the valid 1-6 Box 24 row range` : `matches unitsBilled/chargeAmount/cptCodes for this line \u2014 likely a misread`;
    claim.notes = [claim.notes, `\u26A0\uFE0F visitNumber ${claim.visitNumber} ${reason}, cleared to null`].filter(Boolean).join(" | ");
    claim.visitNumber = null;
  }
}
function reconcileClaimStatusWithPaymentEvidence(claim) {
  if (claim.insuranceReimbursement == null) return;
  if (claim.claimStatus === "denied" && claim.insuranceReimbursement > 0) {
    claim.notes = [
      claim.notes,
      `\u26A0\uFE0F claimStatus corrected from "denied" to "approved" \u2014 this line has an insurance reimbursement of $${claim.insuranceReimbursement.toFixed(2)}, which a denied line cannot have.`
    ].filter(Boolean).join(" | ");
    claim.claimStatus = "approved";
    return;
  }
  if (claim.claimStatus === "approved" && claim.insuranceReimbursement === 0) {
    claim.notes = [
      claim.notes,
      `\u26A0\uFE0F claimStatus flagged "needs_review" \u2014 extracted as "approved" but insurance reimbursement is $0, which needs staff confirmation before relying on either status.`
    ].filter(Boolean).join(" | ");
    claim.claimStatus = "needs_review";
  }
}
function verifyClaimAgainstSourceText(claim, sourceText) {
  const warnings = [];
  if (claim.cptCodes) {
    const cptCore = claim.cptCodes.match(/^[A-Z]?\d{4,5}/)?.[0] ?? claim.cptCodes;
    if (!sourceText.includes(claim.cptCodes) && !sourceText.includes(cptCore)) {
      warnings.push(`CPT "${claim.cptCodes}" not found in source text`);
    }
  }
  const checkAmount = (label, value) => {
    if (value === null || value === void 0) return;
    const withCents = value.toFixed(2);
    const withoutCents = String(Math.trunc(value));
    if (!sourceText.includes(withCents) && !sourceText.includes(withoutCents)) {
      warnings.push(`${label} ${withCents} not found in source text`);
    }
  };
  checkAmount("Charge", claim.chargeAmount);
  checkAmount("Reimbursement", claim.insuranceReimbursement);
  checkAmount("Patient due", claim.patientAmountDue);
  if (claim.unitsBilled != null && claim.cptCodes) {
    const unitsStr = String(Math.round(claim.unitsBilled));
    const cptCore = claim.cptCodes.match(/^[A-Z]?\d{4,5}/)?.[0] ?? claim.cptCodes;
    if (!sourceText.includes(unitsStr)) {
      warnings.push(`Units ${unitsStr} not found in source text`);
    } else {
      const coOccurs = sourceText.split("\n").some(
        (line) => (line.includes(claim.cptCodes) || line.includes(cptCore)) && line.includes(unitsStr)
      );
      if (!coOccurs) {
        warnings.push(`Units ${unitsStr} not found on the same line as CPT "${claim.cptCodes}" \u2014 possible misattribution`);
      }
    }
  }
  const checkStringField = (label, value) => {
    if (!value) return;
    if (!sourceText.includes(value)) {
      warnings.push(`${label} "${value}" not found in source text`);
    }
  };
  checkStringField("Claim #", claim.oaClaimNumber);
  checkStringField("Check/EFT", claim.checkNumberVirtualCard);
  checkStringField("Ins. Billed", claim.insuranceBilled);
  if (claim.cptCodes && claim.chargeAmount != null) {
    const cptCore = claim.cptCodes.match(/^[A-Z]?\d{4,5}/)?.[0] ?? claim.cptCodes;
    const chargeStr = claim.chargeAmount.toFixed(2);
    const chargeStrNoCents = String(Math.trunc(claim.chargeAmount));
    const coOccurs = sourceText.split("\n").some(
      (line) => (line.includes(claim.cptCodes) || line.includes(cptCore)) && (line.includes(chargeStr) || line.includes(chargeStrNoCents))
    );
    if (!coOccurs) {
      warnings.push(
        `CPT "${claim.cptCodes}" and charge ${chargeStr} each appear somewhere in source text but never together on the same line \u2014 possible pattern-completion fabrication`
      );
    }
  }
  return warnings;
}
function findSourceLineForClaim(claim, sourceText) {
  if (!claim.cptCodes) return null;
  const cptCore = claim.cptCodes.match(/^[A-Z]?\d{4,5}/)?.[0] ?? claim.cptCodes;
  const line = sourceText.split("\n").find((l) => l.includes(claim.cptCodes) || l.includes(cptCore));
  return line ? line.trim().replace(/\s+/g, " ") : null;
}
async function extractClaimsWithAI(source, uploadType) {
  console.log(`[AIExtractor] Starting ${uploadType} extraction (source: ${source.kind}, provider: ${ENV.aiProvider})`);
  const systemPrompt = uploadType === "reimbursement" ? `You are a medical claims data extraction specialist with deep experience reading Explanation of Benefits (EOB) and remittance advice documents from every major US payer (Aetna, UnitedHealthcare/Optum, Cigna, Humana, Medicare/Medicare Advantage administrators like Wellpoint/NGS, BCBS, Meritain, and others). Extract all claim information accurately from the provided document text.

*** CRITICAL: You MUST extract the PATIENT NAME for EACH claim, individually. This is required for matching against the clinic's patient database. ***

*** DOCUMENT-TYPE BOUNDARY: This is a Reimbursement/EOB document. Extract payment-side data \u2014 insuranceReimbursement, patientAmountPaid, patientAmountDue, oaClaimNumber (Claim #), checkDate (Check/Payment Date), and checkNumberVirtualCard (Check/EFT) \u2014 plus dateOfService and cptCodes, which double as the key used to identify which existing claim this payment applies to. Many EOBs also print a per-line "Line Level Information" billing table (Billed Amount, DX/Diagnosis Codes, Modifier, Quantity/Units) alongside the payment columns \u2014 when that table is present, ALSO extract chargeAmount, diagnosisCodes, modifier, and unitsBilled from it (see field list below); leave any of those null only when the document genuinely does not print it. Do NOT extract placeOfService for this document type \u2014 leave it null even if a "Place of Service" column happens to be visible (some payer portal exports print one), since it is only ever saved from CMS-1500 uploads (Box 24B) and is discarded for Reimbursement/EOB claims regardless of what you extract. ***

Payers lay these documents out very differently \u2014 a table of many patients on one page, a single-patient web-portal export, a per-claim narrative block, etc. Do not assume there is only one patient name at the top of the document: scan the ENTIRE document and re-identify the patient name at each claim/service-line block, since one EOB commonly covers many different patients (e.g. a check remitting payment for a whole clinic's batch of claims).

For each claim/service line, extract EVERY one of these fields when it appears anywhere in the document \u2014 a payment line's reimbursement, patient-paid, patient-due, claim #, check date, and check/EFT number are often printed in different parts of the same claim block, not all in one place, so check the whole block before leaving any of them null:
- patientName: REQUIRED - full name exactly as shown next to that specific claim (e.g., "JOHN SMITH" or "Smith, John" or "JOHN M SMITH"). Never reuse a different claim's patient name.
- dateOfService: MM/DD/YYYY format \u2014 doubles as part of the match key against the existing claim record
- cptCodes: CPT/HCPCS code(s), comma-separated if multiple \u2014 doubles as part of the match key against the existing claim record
- chargeAmount: the provider's BILLED charge for this specific line, when the EOB prints a line-item billing table (labeled "Billed Amount", "Charge", "Submitted Charges", "Amount Charged", etc.). This is the same concept as a CMS-1500's Box 24F charge \u2014 NOT the Allowed Amount (contracted/allowable rate) and NOT the Paid Amount. Null if the document only prints payment-side totals with no per-line billed figure.
- diagnosisCodes: ICD-10 diagnosis code(s) for this line, comma-separated, when printed in the EOB's line-item table (labeled "DX", "Diagnosis Codes", "Dx Codes", etc.). Null if not printed.
- modifier: CPT modifier code(s) for this line, when printed (e.g. "GP", "59"). If more than one modifier applies to the same line, join them in printed order separated by ", " (e.g. "59, GP") \u2014 never truncate to only the first one. Null if not printed.
- unitsBilled: units/quantity billed for this line (labeled "Quantity", "Units", "Qty"), when printed. Normalize to a plain number (e.g. "1.000" \u2192 1). Null if not printed.
- insuranceReimbursement: insurance reimbursement/allowed/paid amount (numeric only)
- patientAmountPaid: patient co-pay amount already paid (numeric only)
- patientAmountDue: patient balance/responsibility still due (numeric only)
- oaClaimNumber: claim number/ID/ICN/reference number for this claim \u2014 copy it character-for-character exactly as printed; never reformat, abbreviate, or invent one
- checkDate: check/payment/EFT date in MM/DD/YYYY format
- checkNumberVirtualCard: check number, EFT trace number, or virtual card number
- claimStatus: one of "approved", "denied", or "submitted" \u2014 determine this INDEPENDENTLY for EACH service line using ONLY that specific line's own evidence (its own denial reason/remark code, or its own $0 payment paired with an explicit denial code/phrase). NEVER mark a line "denied" solely because the DOCUMENT contains the word "denied" somewhere else, or because a DIFFERENT line on the same claim was denied \u2014 a document or claim can have some lines paid and others denied, and each line's status must reflect only itself. NEVER infer "denied" purely from a $0 payment, a remaining patient balance, or an adjustment/reduction code by themselves \u2014 those also occur on lines that are simply still processing, fully adjusted to a contractual rate, or awaiting a coordination-of-benefits step; use "submitted" instead when a line has no payment and no explicit denial evidence of its own. A line with any positive insuranceReimbursement amount must never be "denied".
- insuranceBilled: the NUMERIC billing/group/payer identifier for this claim \u2014 e.g. "Group #", "Group Number", "Group No", "Group ID", "Billing ID", "Billing Number", "Payer ID", "Payer Number", or a slash-separated identifier like "16404/137040261". This is NEVER the insurance company/payer name (do not write "Aetna", "Meritain Health", "BCBS", "Cigna", etc. here \u2014 that is a completely different field, not this one). If no such numeric identifier is visible anywhere in this claim's block, use null \u2014 do not substitute the payer name as a fallback.
- visitNumber: Always return null for EOB documents. Visit number comes only from CMS-1500 forms.

FIELD NAME VARIATIONS \u2014 the same data point is labeled differently across payers; map by meaning, not by exact label. Some payers print several *different, non-interchangeable* dollar columns \u2014 read carefully, don't just grab the first similar-sounding label:
- Charge (chargeAmount) = the provider's ORIGINAL BILLED charge for this line: "Billed Amount", "Charge", "Submitted Charges", "Amount Charged". This is NOT "Allowed Amount"/"Allowable"/"QPA" (the contracted rate) and NOT "Paid"/"Payable" (what insurance actually paid) \u2014 those are separate columns; do not substitute either of them into chargeAmount.
- Insurance Reimbursement = the amount the payer actually PAID/will pay: "Paid Amount", "Payable Amount", "Plan Paid", "Claim Payment Amount". This is NOT the same as "Allowed Amount"/"Allowable"/"QPA" \u2014 that is only the contractually recognized rate the patient-responsibility math is based on, and is often larger than what was actually paid (especially out-of-network). If both an "Allowed" and a "Paid"/"Payable" column exist, use the "Paid"/"Payable" one.
- Patient Due = the patient's owed balance under the plan: "Patient Responsibility", "Patient Resp", "Balance Due". Some EOBs instead print separate "Coinsurance Amount", "Copay Amount", and "Deductible Amount" columns without a single combined "Patient Responsibility" figure \u2014 do NOT sum those three yourself and do NOT write any one of them individually into patientAmountDue or patientAmountPaid; leave patientAmountDue null in that case rather than guessing which figure(s) apply, unless an explicit combined "Patient Responsibility"/"Balance Due" label is also present. Some EOBs separately print a "Not Payable"/"Not Covered" column for amounts the plan simply doesn't cover \u2014 that is a different concept from Patient Responsibility (it's often only billable to the patient if a separate balance-billing agreement applies) \u2014 prefer the explicit "Patient Responsibility" figure when both are present.
- CRITICAL \u2014 a claim/date's own "Totals" row (which sums all of its service lines) is NEVER a per-line patientAmountDue value. If a date has multiple CPT lines and only ONE Patient Due figure is legible per line (e.g. the individual per-line split is unclear from the layout, but a "Totals" row prints one combined figure for the whole date), assign that combined figure only to the FIRST service line for that date and leave patientAmountDue null on the other lines under the same date \u2014 never copy the same total onto every line just because it's the clearest number nearby. Each line's real, distinct value (when legible) always takes priority over substituting the total.
- "Allowed Amount" and any per-line "Coinsurance Amount" / "Copay Amount" / "Deductible Amount" columns are not captured by any field in this schema \u2014 do not write them into chargeAmount, insuranceReimbursement, patientAmountPaid, or patientAmountDue.
- Claim Number = "Claim ID", "ICN", "Reference #", "Claim #", "Transaction ID", "Control Number"
- Check/Payment Date = "Payment Date", "Check Date", "Direct Deposit Date", "EFT Date"
- Auto/PIP (e.g. GEICO) EOBs use their own labels: Date of Service = "DOS"; CPT Codes = "PROC CODE"; Charge = "CHARGE". These documents commonly print a "REDUCTION" column \u2014 this is the insurer's own fee-schedule/contractual reduction, NOT patientAmountDue. No-fault auto/PIP coverage typically has zero patient responsibility, so do not map REDUCTION to patientAmountDue just because it's a dollar amount near the charge/paid columns; if no explicit patient-responsibility label exists, patientAmountDue is null. insuranceReimbursement on these documents is usually labeled "PROVIDER REIMBURSE".

IMPORTANT:
- Re-identify patient name per claim/service-line block \u2014 do NOT assume one name applies to the whole document
- If multiple patients are in the document, create separate claim objects for each patient's claims
- Patient name is REQUIRED - never leave it null or empty
- Use null (not a guess) for any field that isn't actually visible in the document \u2014 do not use outside/training knowledge to fill a gap (e.g. don't infer an insurer's usual claim number format, or a typical charge for a CPT code); if it isn't printed in this text, it's null
- Each individual service line is its own claim object \u2014 never combine two service lines (e.g. two different CPT codes) into one object. If you see two CPT codes on what looks like one row, that's two service lines that got visually close together; output them as two separate claim objects, never as one object with a comma-joined cptCodes value.
- Never output a CLAIM TOTALS, SUBTOTAL, or grand-total row as a service line \u2014 those summary rows repeat/sum the individual lines' amounts (e.g. a $700 total when the actual lines are $350/$175/$175) and must be skipped entirely, not extracted as their own claim or used as any line's chargeAmount.
- Do not complete patterns. If one date has 4 service lines and a later date for the same patient has only 2, output exactly 2 for that date \u2014 do not add the other 2 CPT codes just because they appeared on the earlier dates. Repetition across dates is a coincidence of the data, not a rule to extend. Count the actual service lines under each date before outputting; never output more rows for a date than that date actually has.
- Return ONLY valid JSON, no markdown or explanations.` : `You are a medical claims data extraction specialist. Extract all CMS-1500 Health Insurance Claim Form information accurately from the provided document text.

*** CRITICAL: You MUST extract the PATIENT NAME from Box 2. This is required for matching against the clinic's patient database. ***

*** DOCUMENT-TYPE BOUNDARY: This is a CMS-1500 claim form. Only extract billing-side data \u2014 dateOfService, placeOfService, diagnosisCodes, unitsBilled, modifier, cptCodes, and chargeAmount. NEVER extract insuranceReimbursement, patientAmountPaid, patientAmountDue, oaClaimNumber (Claim #), checkDate, or checkNumberVirtualCard (Check/EFT) \u2014 those belong exclusively to Reimbursement/EOB payment documents and a CMS-1500 form never carries that data. ***

For each service line, extract EVERY one of these fields when it appears anywhere in the document \u2014 do not leave a field null just because it wasn't on the exact box you checked first; CPT/charge/units/modifier are frequently printed on the same physical row and must all be read together:
- patientName: REQUIRED - from Box 2 of form (e.g., "JOHN SMITH" or "Smith, John")
- dateOfService: MM/DD/YYYY format (from Box 24A)
- placeOfService: place of service code (from Box 24B)
- cptCodes: CPT/HCPCS code(s), comma-separated if multiple (from Box 24D)
- diagnosisCodes: ICD-10 diagnosis codes, comma-separated (from Box 21)
- unitsBilled: units/days billed (from Box 24G \u2014 labeled "DAYS OR UNITS")
- modifier: modifier codes if present (from Box 24D, immediately after the CPT code)
- chargeAmount: total charge amount for this line (numeric only, from Box 24F)
- claimSubmittedDate: MM/DD/YYYY format \u2014 the physician/supplier signature date (from Box 31, usually printed after "SIGNED"/"DATE")
- insuranceBilled: the NUMERIC billing/group/payer identifier printed near Box 11 \u2014 e.g. "Group #", "Group Number", "Group No", "Group ID", "Billing ID", "Billing Number", "Payer ID", "Payer Number", or a slash-separated identifier like "16404/137040261". This is NEVER the insurance plan/payer name (do not write "Aetna", "Blue Cross", etc. here). If no such numeric identifier is visible on the form, use null.
- visitNumber: The service line number from Box 24 of the CMS-1500 form. Assign integers 1, 2, 3, ... in the order the service lines appear top-to-bottom in Box 24. The first service line is visitNumber 1, the second is visitNumber 2, and so on. This is a positional value \u2014 do NOT search for a label. Return as integer.

IMPORTANT:
- Patient name is REQUIRED - never leave it null or empty
- Extract one service line = one claim object. A CMS-1500 form with multiple service lines (Box 24, rows 1-6) must produce one claim object per row, each with its OWN dateOfService/cptCodes/chargeAmount/unitsBilled/modifier \u2014 never merge two rows together or repeat the same row's values across every date.
- Use null (not a guess) only for a field that is genuinely not visible anywhere in the document \u2014 do not leave a field null when the value is printed on the form.
- Return ONLY valid JSON, no markdown or explanations.`;
  const instruction = uploadType === "reimbursement" ? "Extract all EOB claims from this document. IMPORTANT: Make sure to extract the patient name for each claim." : "Extract all CMS-1500 claims from this document. IMPORTANT: Make sure to extract the patient name from Box 2 for each claim.";
  const userContent = source.kind === "text" ? `${instruction}

${source.text}` : [
    { type: "text", text: instruction },
    {
      type: "file",
      file: {
        filename: source.filename,
        file_data: `data:application/pdf;base64,${source.buffer.toString("base64")}`
      }
    }
  ];
  const reimbursementClaimProperties = {
    patientName: { type: "string" },
    // REQUIRED
    dateOfService: { type: ["string", "null"] },
    cptCodes: { type: ["string", "null"] },
    chargeAmount: { type: ["number", "null"] },
    diagnosisCodes: { type: ["string", "null"] },
    modifier: { type: ["string", "null"] },
    unitsBilled: { type: ["number", "null"] },
    insuranceReimbursement: { type: ["number", "null"] },
    patientAmountPaid: { type: ["number", "null"] },
    patientAmountDue: { type: ["number", "null"] },
    oaClaimNumber: { type: ["string", "null"] },
    checkDate: { type: ["string", "null"] },
    checkNumberVirtualCard: { type: ["string", "null"] },
    claimStatus: {
      type: "string",
      enum: ["submitted", "approved", "denied"]
    },
    insuranceBilled: { type: ["string", "null"] },
    visitNumber: {
      type: ["integer", "null"],
      description: "Always null for EOB/Reimbursement documents \u2014 visit number comes only from CMS-1500 forms."
    }
  };
  const cms1500ClaimProperties = {
    patientName: { type: "string" },
    // REQUIRED
    dateOfService: { type: ["string", "null"] },
    cptCodes: { type: ["string", "null"] },
    chargeAmount: { type: ["number", "null"] },
    placeOfService: { type: ["string", "null"] },
    diagnosisCodes: { type: ["string", "null"] },
    unitsBilled: { type: ["number", "null"] },
    modifier: { type: ["string", "null"] },
    claimSubmittedDate: { type: ["string", "null"] },
    claimStatus: {
      type: "string",
      enum: ["submitted", "approved", "denied"]
    },
    insuranceBilled: { type: ["string", "null"] },
    visitNumber: {
      type: ["integer", "null"],
      description: "Box 24 service line position (1-6), assigned top-to-bottom in printed order \u2014 not a text label."
    }
  };
  const claimItemProperties = uploadType === "reimbursement" ? reimbursementClaimProperties : cms1500ClaimProperties;
  try {
    const response = await invokeLLM({
      model: ENV.aiModel,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userContent
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "claim_extraction",
          strict: true,
          schema: {
            type: "object",
            properties: {
              claims: {
                type: "array",
                items: {
                  type: "object",
                  properties: claimItemProperties,
                  // OpenAI's strict json_schema mode rejects the request unless every
                  // property is listed here (use a nullable type for "optional" fields)
                  // and additionalProperties is explicitly false — Anthropic's tool-use
                  // schema validation is more lenient and accepts this shape too, so one
                  // schema definition works for both adapters.
                  required: Object.keys(claimItemProperties),
                  additionalProperties: false
                }
              },
              detectedInsurer: { type: ["string", "null"] },
              confidence: { type: "number" },
              extractionNotes: { type: ["string", "null"] }
            },
            required: ["claims", "detectedInsurer", "confidence", "extractionNotes"],
            additionalProperties: false
          }
        }
      }
    });
    const content = response.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("No response from AI provider");
    }
    const parsed = recoverJson(content);
    if (!parsed) {
      console.error("[AIExtractor] Could not parse AI response as JSON:", content.slice(0, 500));
      throw new Error("AI provider returned malformed JSON that could not be recovered");
    }
    const claimsArray = Array.isArray(parsed.claims) ? parsed.claims : [];
    const normalizedClaims = claimsArray.map(
      (claim) => ({
        // Preserved per-claim (not just the aggregate top-level patientName below)
        // so multi-patient documents — e.g. a single combined EOB covering many
        // patients on one check — don't lose per-claim patient attribution.
        patientName: claim.patientName ? String(claim.patientName).trim() : null,
        dateOfService: claim.dateOfService || null,
        cptCodes: claim.cptCodes || null,
        chargeAmount: claim.chargeAmount !== null && claim.chargeAmount !== void 0 ? Number(claim.chargeAmount) : null,
        insuranceReimbursement: claim.insuranceReimbursement !== null && claim.insuranceReimbursement !== void 0 ? Number(claim.insuranceReimbursement) : null,
        patientAmountPaid: claim.patientAmountPaid !== null && claim.patientAmountPaid !== void 0 ? Number(claim.patientAmountPaid) : null,
        patientAmountDue: claim.patientAmountDue !== null && claim.patientAmountDue !== void 0 ? Number(claim.patientAmountDue) : null,
        oaClaimNumber: claim.oaClaimNumber || null,
        checkDate: claim.checkDate || null,
        checkNumberVirtualCard: claim.checkNumberVirtualCard || null,
        claimStatus: claim.claimStatus || "submitted",
        placeOfService: claim.placeOfService || null,
        diagnosisCodes: claim.diagnosisCodes || null,
        unitsBilled: claim.unitsBilled !== null && claim.unitsBilled !== void 0 ? Number(claim.unitsBilled) : null,
        modifier: claim.modifier || null,
        // insuranceBilled is the numeric billing/group/payer identifier, not
        // a payer name — must never fall back to detectedInsurer (a company
        // name) or a placeholder string. sanitizeInsuranceBilled() below also
        // strips it back to null if the model ignores the prompt and returns
        // a company name anyway.
        insuranceBilled: claim.insuranceBilled || null,
        claimSubmittedDate: claim.claimSubmittedDate || null,
        expireBcbsClaimNumber: null,
        paymentReceived: null,
        lmn: null,
        dateReceived: null,
        referenceNo: null,
        // The sequential visit/session number — must stay null when the model
        // didn't find one, never default to 0 (0 is not a valid visit number
        // and was previously hardcoded here, causing every AI-extracted claim
        // to show "0.00" in the Visit # column regardless of source content).
        visitNumber: claim.visitNumber !== null && claim.visitNumber !== void 0 ? Math.round(Number(claim.visitNumber)) : null,
        dateOfAppeal: null,
        notes: parsed.extractionNotes || null
      })
    );
    for (const claim of normalizedClaims) {
      sanitizeInsuranceBilled(claim);
      sanitizeVisitNumber(claim);
      reconcileClaimStatusWithPaymentEvidence(claim);
    }
    if (source.kind === "text") {
      for (const claim of normalizedClaims) {
        const warnings = verifyClaimAgainstSourceText(claim, source.text);
        if (warnings.length > 0) {
          console.warn(
            `[AIExtractor] Verification warning (CPT ${claim.cptCodes}, DOS ${claim.dateOfService}):`,
            warnings.join("; ")
          );
          claim.notes = [claim.notes, `\u26A0\uFE0F Unverified against source: ${warnings.join("; ")}`].filter(Boolean).join(" | ");
        }
        const sourceLine = findSourceLineForClaim(claim, source.text);
        if (sourceLine) {
          claim.notes = [claim.notes, `\u{1F4C4} Source: "${sourceLine}"`].filter(Boolean).join(" | ");
        }
      }
    }
    const byDate = /* @__PURE__ */ new Map();
    for (const claim of normalizedClaims) {
      if (claim.patientAmountDue == null || !claim.dateOfService) continue;
      const key = claim.dateOfService;
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(claim);
    }
    for (const claimsOnDate of Array.from(byDate.values())) {
      if (claimsOnDate.length < 2) continue;
      const seen = /* @__PURE__ */ new Map();
      for (const claim of claimsOnDate) {
        const amount = claim.patientAmountDue;
        const countSoFar = seen.get(amount) ?? 0;
        seen.set(amount, countSoFar + 1);
        if (countSoFar > 0) {
          claim.notes = [
            claim.notes,
            `\u26A0\uFE0F Patient Due $${amount.toFixed(2)} matches another CPT line on this date \u2014 likely a single combined figure duplicated across lines, not per-line data. Verify against source.`
          ].filter(Boolean).join(" | ");
        }
      }
    }
    const uniquePatientNames = new Set(
      claimsArray.map((c) => c.patientName?.toUpperCase().trim())
    );
    const patientName = uniquePatientNames.size === 1 ? Array.from(uniquePatientNames)[0] : void 0;
    console.log(`[AIExtractor] Extracted ${normalizedClaims.length} claim(s), confidence ${parsed.confidence ?? "n/a"}`);
    return {
      claims: normalizedClaims,
      confidence: parsed.confidence || 0.8,
      detectedInsurer: parsed.detectedInsurer,
      extractionNotes: parsed.extractionNotes,
      patientName
    };
  } catch (error) {
    console.error("[AIExtractor] Extraction error:", error);
    throw new Error(
      `Failed to extract claims with AI (${ENV.aiProvider}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
async function detectInsuranceType(pdfText) {
  try {
    const response = await invokeLLM({
      model: ENV.aiModel,
      messages: [
        {
          role: "system",
          content: `You are an insurance document classifier. Identify the insurance company and document type from the provided text.

Return a JSON object with:
- insurer: The insurance company name (e.g., "Meritain Health", "Aetna", "BCBS", "Cigna", "Medicare", "UnitedHealth")
- documentType: Either "eob" (Explanation of Benefits), "cms1500" (CMS-1500 form), or "other"
- confidence: A number between 0 and 1 indicating how confident you are in the classification

Return ONLY valid JSON, no markdown.`
        },
        {
          role: "user",
          content: `Identify the insurance company and document type from this text:

${pdfText.substring(0, 2e3)}`
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "insurance_detection",
          strict: true,
          schema: {
            type: "object",
            properties: {
              insurer: { type: "string" },
              documentType: {
                type: "string",
                enum: ["eob", "cms1500", "other"]
              },
              confidence: { type: "number" }
            },
            required: ["insurer", "documentType", "confidence"],
            additionalProperties: false
          }
        }
      }
    });
    const content = response.choices[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("No response from AI provider");
    }
    const parsed = recoverJson(content);
    if (!parsed) {
      throw new Error("AI provider returned malformed JSON for insurance detection");
    }
    return parsed;
  } catch (error) {
    console.error("[AIExtractor] Insurance detection error:", error);
    return {
      insurer: "Unknown",
      documentType: "other",
      confidence: 0
    };
  }
}

// server/claimUpload.ts
var CMS1500_CLAIM_FIELDS_TO_BACKFILL = [
  "placeOfService",
  "diagnosisCodes",
  "claimSubmittedDate",
  // visitNumber lives on the DateClaimGroup itself (bulkImportFromEOB reads
  // claim.visitNumber, not line.visitNumber — see server/routers.ts), so it
  // belongs in the claim-level list, not the line-level one below.
  "visitNumber"
];
var CMS1500_LINE_FIELDS_TO_BACKFILL = [
  "cptCodes",
  "chargeAmount",
  "unitsBilled",
  "modifier",
  "diagnosisCodes"
];
var REIMBURSEMENT_CLAIM_FIELDS_TO_BACKFILL = [
  "oaClaimNumber",
  "checkDate",
  "checkNumberVirtualCard"
];
var REIMBURSEMENT_LINE_FIELDS_TO_BACKFILL = [
  "insuranceReimbursement",
  "patientAmountPaid",
  "patientAmountDue",
  // Line-item billing detail (Billed Amount / DX / Modifier / Quantity) that
  // many EOBs print alongside the payment columns in their own "Line Level
  // Information" table — no longer CMS1500-exclusive, see the comment on
  // CMS1500_ONLY_FIELDS below.
  "chargeAmount",
  "diagnosisCodes",
  "modifier",
  "unitsBilled"
];
function hasMissingFields(claims, claimFields, lineFields) {
  return claims.some((claim) => {
    if (claimFields.some((field) => claim[field] === null || claim[field] === void 0)) return true;
    const lines = claim.cptLines;
    if (lines === void 0) return false;
    if (lines.length === 0) return lineFields.length > 0;
    return lines.some((line) => lineFields.some((field) => line[field] === null || line[field] === void 0));
  });
}
function backfillMissingFields(claims, aiClaims, claimFields, lineFields) {
  claims.forEach((claim, i) => {
    const dateMatches = aiClaims.filter((a) => a.dateOfService === claim.dateOfService);
    const claimMatch = dateMatches[0] ?? aiClaims[i];
    if (claimMatch) {
      for (const field of claimFields) {
        if ((claim[field] === null || claim[field] === void 0) && claimMatch[field] !== null && claimMatch[field] !== void 0) {
          claim[field] = claimMatch[field];
        }
      }
    }
    const lines = claim.cptLines;
    if (lines === void 0) return;
    if (lines.length === 0) {
      for (const aiClaim of dateMatches) {
        const newLine = {};
        for (const field of lineFields) newLine[field] = aiClaim[field] ?? null;
        lines.push(newLine);
      }
      return;
    }
    lines.forEach((line, li) => {
      const lineMatch = dateMatches.find((a) => a.cptCodes && a.cptCodes === line.cptCodes) ?? dateMatches[li] ?? dateMatches[0];
      if (!lineMatch) return;
      for (const field of lineFields) {
        if ((line[field] === null || line[field] === void 0) && lineMatch[field] !== null && lineMatch[field] !== void 0) {
          line[field] = lineMatch[field];
        }
      }
    });
  });
}
var CMS1500_ONLY_FIELDS = [
  "placeOfService",
  "claimSubmittedDate",
  // Matches the existing isCms gate in bulkImportFromEOB (server/routers.ts),
  // which already only ever writes visitNumber for CMS-1500 claims.
  "visitNumber"
];
var REIMBURSEMENT_ONLY_FIELDS = [
  "insuranceReimbursement",
  "patientAmountPaid",
  "patientAmountDue",
  "oaClaimNumber",
  "checkDate",
  "checkNumberVirtualCard"
];
function enforceFieldBoundary(claims, uploadType) {
  const fieldsToStrip = uploadType === "reimbursement" ? CMS1500_ONLY_FIELDS : REIMBURSEMENT_ONLY_FIELDS;
  for (const claim of claims) {
    for (const field of fieldsToStrip) {
      claim[field] = null;
    }
  }
}
var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  // 16 MB
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const allowed = [
      "application/pdf",
      "text/csv",
      "text/plain",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // .xlsx
      "application/vnd.ms-excel.sheet.macroEnabled.12"
      // .xlsm
    ];
    if (allowed.includes(file.mimetype) || name.endsWith(".csv") || name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".xlsm")) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, CSV, and Excel (.xlsx/.xls) files are supported."));
    }
  }
});
var COLUMN_DESCRIPTIONS = `
Extract claim line items and map each one to these columns (use null if not found):
- placeOfService: string \u2014 place of service code or description (e.g. "11", "Home", "Office")
- dateOfService: string \u2014 date of service in YYYY-MM-DD format
- visitNumber: integer \u2014 CMS-1500 only: the Box 24 service line's position (1-6), assigned top-to-bottom in printed order, not a text label. Always null for Reimbursement/EOB documents.
- cptCodes: string \u2014 CPT/procedure codes (comma-separated if multiple)
- unitsBilled: number \u2014 units billed
- diagnosisCodes: string \u2014 ICD-10 diagnosis codes (comma-separated)
- modifier: string \u2014 modifier codes
- chargeAmount: number \u2014 total charge/billed amount (numeric, no $ sign)
- insuranceReimbursement: number \u2014 amount paid/reimbursed by insurance (numeric, no $ sign)
- patientAmountPaid: number \u2014 amount paid by patient
- patientAmountDue: number \u2014 patient balance/amount due
- insuranceBilled: string \u2014 the numeric billing/group/payer identifier (e.g. Group #, Billing ID, Payer ID); NEVER the insurance company name (do not write "Aetna", "Meritain Health", etc.) \u2014 use null if no such identifier is visible
- oaClaimNumber: string \u2014 OA or internal claim number
- claimSubmittedDate: string \u2014 date claim was submitted in YYYY-MM-DD format
- expireBcbsClaimNumber: string \u2014 BCBS or external claim/reference number
- claimStatus: string \u2014 one of: submitted, approved, pending, denied, pended, rejected, resubmitted
- paymentReceived: number \u2014 payment received amount
- checkDate: string \u2014 check/payment date in YYYY-MM-DD format
- checkNumberVirtualCard: string \u2014 check number or virtual card number
- dateReceived: string \u2014 date payment was received in YYYY-MM-DD format
- lmn: string \u2014 LMN documents date sent
- referenceNo: string \u2014 reference number
- dateOfAppeal: string \u2014 date of appeal in YYYY-MM-DD format
- notes: string \u2014 any additional notes or remarks from the document
`;
async function extractPdfText(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;
  const textParts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => "str" in item ? item.str : "").join(" ");
    textParts.push(pageText);
  }
  return textParts.join("\n");
}
function extractPdfTextLayout(buffer) {
  const tmpFile = join(tmpdir(), `cms1500_${Date.now()}.pdf`);
  try {
    writeFileSync(tmpFile, buffer);
    const text = execSync(`pdftotext -layout "${tmpFile}" -`, { maxBuffer: 10 * 1024 * 1024 }).toString();
    return text;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
    }
  }
}
async function extractPdfTextLayoutJS(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;
  const pageTexts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = content.items.filter((item) => typeof item.str === "string" && item.str.length > 0);
    const rows = [];
    let currentRow = [];
    let lastY = null;
    const sortedByY = [...items].sort((a, b) => b.transform[5] - a.transform[5]);
    for (const item of sortedByY) {
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        if (currentRow.length > 0) rows.push(currentRow);
        currentRow = [];
      }
      currentRow.push({ x: item.transform[4], str: item.str, width: item.width ?? 0 });
      lastY = y;
    }
    if (currentRow.length > 0) rows.push(currentRow);
    const pageLines = rows.map((row) => {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      let line = "";
      let prevEnd = null;
      for (const frag of sorted) {
        if (prevEnd !== null) {
          const gap = frag.x - prevEnd;
          const spaces = Math.max(1, Math.round(gap / 4));
          line += " ".repeat(Math.min(spaces, 20));
        }
        line += frag.str;
        prevEnd = frag.x + frag.width;
      }
      return line;
    });
    pageTexts.push(pageLines.join("\n"));
  }
  return pageTexts.join("\n\n");
}
function extractXlsxText(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const allRows = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    allRows.push(...rows);
  }
  if (allRows.length === 0) throw new Error("No data found in Excel file.");
  return allRows.map((r) => JSON.stringify(r)).join("\n");
}
function extractCsvText(buffer) {
  const csvString = buffer.toString("utf-8");
  const result = Papa.parse(csvString, { header: true, skipEmptyLines: true });
  if (result.errors.length > 0 && result.data.length === 0) {
    throw new Error("Could not parse CSV file.");
  }
  return JSON.stringify(result.data, null, 2);
}
async function mapToClaimColumns(extractedText) {
  const trimmedText = extractedText.slice(0, 2e4);
  const prompt = `You are a medical billing assistant. You will be given text extracted from a PDF, CSV, or Excel file that contains insurance claim information.

${COLUMN_DESCRIPTIONS}

IMPORTANT RULES:
- Return a JSON object with a single key "claims" whose value is an array of claim objects.
- Each object in the array represents one claim line item.
- Use null for any field that cannot be determined from the document.
- Dates must be in YYYY-MM-DD format or null.
- Numbers must be numeric (no currency symbols), or null.
- claimStatus must be one of: submitted, approved, pending, denied, pended, rejected, resubmitted \u2014 pick the closest match or use "submitted" as default.
- If the document contains multiple claim lines, return one object per line.
- If only one claim is found, return {"claims": [one object]}.
- Column names in the source file may differ \u2014 map them by meaning (e.g. "Billed Amount" \u2192 chargeAmount, "Paid" \u2192 insuranceReimbursement, etc.).

Document content:
---
${trimmedText}
---

Return JSON object with "claims" array:`;
  const response = await invokeLLM({
    model: ENV.aiModel,
    messages: [
      { role: "system", content: "You are a medical billing data extraction assistant. Always respond with valid JSON only." },
      { role: "user", content: prompt }
    ],
    response_format: { type: "json_object" }
  });
  const rawContent = response?.choices?.[0]?.message?.content;
  const content = typeof rawContent === "string" ? rawContent : '{"claims":[]}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      return [];
    }
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed.claims && Array.isArray(parsed.claims)) return parsed.claims;
  if (parsed.data && Array.isArray(parsed.data)) return parsed.data;
  if (parsed.rows && Array.isArray(parsed.rows)) return parsed.rows;
  if (typeof parsed === "object" && parsed !== null) return [parsed];
  return [];
}
function registerClaimUploadRoute(app2) {
  const router2 = Router();
  router2.post(
    "/api/claims/upload-extract",
    requireAuthenticatedUser,
    (req, res, next) => {
      upload.single("file")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
          res.status(400).json({ error: `Upload error: ${err.message}` });
          return;
        }
        if (err) {
          res.status(400).json({ error: err.message });
          return;
        }
        next();
      });
    },
    async (req, res) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: "No file uploaded." });
          return;
        }
        const { buffer, mimetype, originalname } = req.file;
        const name = originalname.toLowerCase();
        let extractedText = "";
        console.log(`[ClaimUpload] Stage 1/7 \u2014 PDF uploaded: "${originalname}" (${(buffer.length / 1024).toFixed(1)} KB, ${mimetype})`);
        const isXlsx = name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".xlsm") || mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mimetype === "application/vnd.ms-excel.sheet.macroEnabled.12";
        const isCsv = !isXlsx && (mimetype === "text/csv" || name.endsWith(".csv"));
        if (isXlsx) {
          extractedText = extractXlsxText(buffer);
        } else if (isCsv) {
          extractedText = extractCsvText(buffer);
        } else {
          try {
            extractedText = await extractPdfText(buffer);
          } catch (pdfjsError) {
            console.error("[ClaimUpload] pdfjs-dist extraction failed, falling back to pdftotext:", pdfjsError);
            try {
              extractedText = extractPdfTextLayout(buffer);
            } catch (pdftotextError) {
              console.error("[ClaimUpload] pdftotext also failed:", pdftotextError);
              extractedText = "";
            }
          }
        }
        if (!extractedText.trim() && (isXlsx || isCsv)) {
          res.status(422).json({ error: "Could not extract any data from the file. Please ensure it is a valid CSV or Excel file." });
          return;
        }
        console.log(`[ClaimUpload] Stage 2/7 \u2014 OCR/text extraction completed: ${extractedText.trim() ? `${extractedText.length} chars` : "no text extracted, will rely on AI vision fallback"}`);
        let uploadType = req.body?.uploadType || "reimbursement";
        if (!req.body?.uploadType && !isXlsx && !isCsv && extractedText.trim()) {
          try {
            const detection = await detectInsuranceType(extractedText);
            console.log(`[ClaimUpload] Stage 3/7 \u2014 Template/type detection: ${detection.insurer} (${detection.documentType}, confidence: ${detection.confidence})`);
            const isKnownInsurer = KNOWN_INSURER_NAMES.some((name2) => detection.insurer.toLowerCase().includes(name2));
            const confidenceThreshold = isKnownInsurer ? 0.9 : 0.7;
            if (detection.confidence > confidenceThreshold && detection.documentType === "cms1500") {
              uploadType = "cms1500";
              console.log("[ClaimUpload] Auto-detected CMS1500 format");
            }
          } catch (error) {
            console.error("[ClaimUpload] Document type detection failed (non-fatal, continuing with default uploadType):", error);
          }
        }
        if (uploadType === "cms1500") {
          let cms1500Text = extractedText;
          if (!isXlsx && !isCsv) {
            try {
              cms1500Text = extractPdfTextLayout(buffer);
            } catch (pdftotextError) {
              console.warn("[ClaimUpload] pdftotext -layout unavailable for CMS1500 (expected on serverless):", pdftotextError instanceof Error ? pdftotextError.message : pdftotextError);
              try {
                cms1500Text = await extractPdfTextLayoutJS(buffer);
              } catch (jsLayoutError) {
                console.error("[ClaimUpload] JS layout extraction also failed for CMS1500, falling back to flat text:", jsLayoutError);
              }
            }
          }
          console.log("[ClaimUpload] Stage 4/7 \u2014 Regex template parsing (CMS1500)...");
          const patientGroups = parseCMS1500(cms1500Text);
          const flatClaims = patientGroups.flatMap((g) => g.claims);
          if (flatClaims.length > 0) {
            if (hasMissingFields(flatClaims, CMS1500_CLAIM_FIELDS_TO_BACKFILL, CMS1500_LINE_FIELDS_TO_BACKFILL)) {
              try {
                const cms1500Source = (cms1500Text || extractedText).trim() ? { kind: "text", text: cms1500Text || extractedText } : { kind: "pdf", buffer, filename: originalname };
                console.log("[ClaimUpload] Stage 4b/7 \u2014 CMS1500 regex parser left fields blank, running AI to backfill place of service / units / diagnosis / modifier...");
                const backfillResult = await extractClaimsWithAI(cms1500Source, "cms1500");
                if (backfillResult.claims.length > 0) {
                  backfillMissingFields(flatClaims, backfillResult.claims, CMS1500_CLAIM_FIELDS_TO_BACKFILL, CMS1500_LINE_FIELDS_TO_BACKFILL);
                }
              } catch (backfillError) {
                console.error("[ClaimUpload] CMS1500 AI backfill failed (continuing with regex-only result):", backfillError);
              }
            }
            enforceFieldBoundary(flatClaims, "cms1500");
            console.log(`[ClaimUpload] Stage 7/7 \u2014 Database save pending: ${flatClaims.length} claim(s) via CMS1500 template parser`);
            res.json({
              claims: flatClaims,
              patientGroups: patientGroups.length > 0 ? patientGroups : null,
              extractedLength: extractedText.length,
              templateUsed: "CMS1500",
              uploadType: "cms1500"
            });
            return;
          }
          try {
            const cms1500Source = (cms1500Text || extractedText).trim() ? { kind: "text", text: cms1500Text || extractedText } : { kind: "pdf", buffer, filename: originalname };
            console.log(`[ClaimUpload] Stage 5/7 \u2014 AI text parsing (CMS1500 regex parser found no claims, trying AI via ${cms1500Source.kind}${cms1500Source.kind === "pdf" ? " \u2014 Stage 5b/7 vision fallback" : ""})...`);
            const aiResult = await extractClaimsWithAI(cms1500Source, "cms1500");
            if (aiResult.claims.length > 0) {
              console.log(`[ClaimUpload] Stage 6/7 \u2014 JSON validation passed: ${aiResult.claims.length} claim(s)`);
              enforceFieldBoundary(aiResult.claims, "cms1500");
              const aiPatientGroups = aiResult.patientName ? [{ patientName: aiResult.patientName, claims: aiResult.claims }] : null;
              console.log(`[ClaimUpload] Stage 7/7 \u2014 Database save pending: ${aiResult.claims.length} claim(s) via AI (CMS1500)`);
              res.json({
                claims: aiResult.claims,
                patientGroups: aiPatientGroups,
                extractedLength: extractedText.length,
                templateUsed: `AI (CMS1500)`,
                uploadType: "cms1500",
                confidence: aiResult.confidence,
                extractionNotes: aiResult.extractionNotes
              });
              return;
            }
          } catch (aiError) {
            console.error("[ClaimUpload] CMS1500 AI extraction failed (continuing with empty template result, request will not crash):", aiError);
          }
          enforceFieldBoundary(flatClaims, "cms1500");
          res.json({
            claims: flatClaims,
            patientGroups: patientGroups.length > 0 ? patientGroups : null,
            extractedLength: extractedText.length,
            templateUsed: "CMS1500",
            uploadType: "cms1500"
          });
          return;
        }
        let reimbursementText = extractedText;
        if (!isXlsx && !isCsv) {
          try {
            reimbursementText = extractPdfTextLayout(buffer);
          } catch (pdftotextError) {
            console.warn("[ClaimUpload] pdftotext -layout unavailable for reimbursement doc (expected on serverless):", pdftotextError instanceof Error ? pdftotextError.message : pdftotextError);
            try {
              reimbursementText = await extractPdfTextLayoutJS(buffer);
            } catch (jsLayoutError) {
              console.error("[ClaimUpload] JS layout extraction also failed for reimbursement doc, falling back to flat text:", jsLayoutError);
              reimbursementText = extractedText;
            }
          }
        }
        console.log("[ClaimUpload] Stage 4/7 \u2014 Template detection (reimbursement)...");
        let templateResult;
        try {
          templateResult = tryTemplateExtraction(reimbursementText, originalname);
        } catch (err) {
          if (err instanceof PatientBoundaryError) {
            console.error("[ClaimUpload] Patient boundary extraction failure:", err.message);
            res.status(422).json({
              error: "Patient boundaries could not be determined. Review the document before importing."
            });
            return;
          }
          throw err;
        }
        if (templateResult && templateResult.claims.length > 0) {
          if (hasMissingFields(templateResult.claims, REIMBURSEMENT_CLAIM_FIELDS_TO_BACKFILL, REIMBURSEMENT_LINE_FIELDS_TO_BACKFILL)) {
            try {
              const reimbursementBackfillSource = reimbursementText.trim() ? { kind: "text", text: reimbursementText } : { kind: "pdf", buffer, filename: originalname };
              console.log(`[ClaimUpload] Stage 4b/7 \u2014 Template "${templateResult.templateName}" left fields blank, running AI to backfill place of service / units / diagnosis / modifier...`);
              const backfillResult = await extractClaimsWithAI(reimbursementBackfillSource, "reimbursement");
              if (backfillResult.claims.length > 0) {
                backfillMissingFields(templateResult.claims, backfillResult.claims, REIMBURSEMENT_CLAIM_FIELDS_TO_BACKFILL, REIMBURSEMENT_LINE_FIELDS_TO_BACKFILL);
                templateResult.patientGroups?.forEach((group) => {
                  backfillMissingFields(group.claims, backfillResult.claims, REIMBURSEMENT_CLAIM_FIELDS_TO_BACKFILL, REIMBURSEMENT_LINE_FIELDS_TO_BACKFILL);
                });
              }
            } catch (backfillError) {
              console.error("[ClaimUpload] Reimbursement AI backfill failed (continuing with template-only result):", backfillError);
            }
          }
          enforceFieldBoundary(templateResult.claims, "reimbursement");
          templateResult.patientGroups?.forEach((group) => {
            enforceFieldBoundary(group.claims, "reimbursement");
          });
          const reimbursementReviewNeeded = (templateResult.patientGroups ?? []).flatMap(
            (group) => group.claims.filter((c) => c.unresolvedClaimTotal).map((c) => ({
              patientName: group.patientName,
              dateOfService: c.dateOfService ?? null,
              cptCodes: c.cptCodes ?? null,
              planPaid: c.unresolvedClaimTotal.planPaid,
              patientResponsibility: c.unresolvedClaimTotal.patientResponsibility,
              cptCount: c.unresolvedClaimTotal.cptCount
            }))
          );
          console.log(`[ClaimUpload] Stage 7/7 \u2014 Database save pending: ${templateResult.claims.length} claim(s) via template "${templateResult.templateName}"${reimbursementReviewNeeded.length > 0 ? ` (${reimbursementReviewNeeded.length} claim block(s) need manual Plan Paid review)` : ""}`);
          res.json({
            claims: templateResult.claims,
            patientGroups: templateResult.patientGroups ?? null,
            extractedLength: extractedText.length,
            templateUsed: templateResult.templateName,
            uploadType: "reimbursement",
            reimbursementReviewNeeded: reimbursementReviewNeeded.length > 0 ? reimbursementReviewNeeded : void 0
          });
          return;
        }
        try {
          const reimbursementSource = reimbursementText.trim() ? { kind: "text", text: reimbursementText } : { kind: "pdf", buffer, filename: originalname };
          console.log(`[ClaimUpload] Stage 5/7 \u2014 AI text parsing (no template matched, using AI via ${reimbursementSource.kind}${reimbursementSource.kind === "pdf" ? " \u2014 Stage 5b/7 vision fallback" : ""})...`);
          const aiResult = await extractClaimsWithAI(reimbursementSource, "reimbursement");
          if (aiResult.claims.length > 0) {
            console.log(`[ClaimUpload] Stage 6/7 \u2014 JSON validation passed: ${aiResult.claims.length} claim(s) for patient: ${aiResult.patientName}`);
            enforceFieldBoundary(aiResult.claims, "reimbursement");
            let patientGroups = null;
            if (aiResult.patientName) {
              patientGroups = [{
                patientName: aiResult.patientName,
                claims: aiResult.claims
              }];
            }
            console.log(`[ClaimUpload] Stage 7/7 \u2014 Database save pending: ${aiResult.claims.length} claim(s) via AI (${aiResult.detectedInsurer || "Unknown"})`);
            res.json({
              claims: aiResult.claims,
              patientGroups,
              extractedLength: extractedText.length,
              templateUsed: `AI (${aiResult.detectedInsurer || "Unknown"})`,
              uploadType: "reimbursement",
              confidence: aiResult.confidence,
              extractionNotes: aiResult.extractionNotes
            });
            return;
          }
          console.log("[ClaimUpload] AI extraction succeeded but found zero claims -- returning empty result rather than falling back to the unscoped legacy extractor.");
          res.json({
            claims: [],
            patientGroups: null,
            extractedLength: extractedText.length,
            templateUsed: `AI (${aiResult.detectedInsurer || "Unknown"})`,
            uploadType: "reimbursement",
            confidence: aiResult.confidence,
            extractionNotes: aiResult.extractionNotes ?? "No service line data was found for this patient in the document."
          });
          return;
        } catch (aiError) {
          console.error("[ClaimUpload] AI extraction failed (continuing to legacy fallback, request will not crash):", aiError);
        }
        if (!extractedText.trim()) {
          console.error("[ClaimUpload] No text and AI extraction failed \u2014 returning controlled 422 instead of crashing.");
          res.status(422).json({ error: "Could not extract any claims from this file." });
          return;
        }
        console.log("[ClaimUpload] Stage 5/7 \u2014 AI text parsing failed upstream, using legacy AI extraction...");
        const claims = await mapToClaimColumns(extractedText);
        enforceFieldBoundary(claims, "reimbursement");
        claims.forEach(reconcileClaimStatusWithPaymentEvidence);
        console.log(`[ClaimUpload] Stage 7/7 \u2014 Database save pending: ${claims.length} claim(s) via legacy AI extraction`);
        res.json({ claims, extractedLength: extractedText.length, templateUsed: "AI Extraction (Legacy)", uploadType: "reimbursement" });
      } catch (err) {
        console.error("[ClaimUpload] Error:", err);
        res.status(500).json({ error: err.message ?? "Failed to process file." });
      }
    }
  );
  app2.use(router2);
}

// server/routers.ts
import { z as z2 } from "zod";
import bcrypt from "bcryptjs";
import { TRPCError as TRPCError3 } from "@trpc/server";

// server/_core/systemRouter.ts
import { z } from "zod";

// server/_core/notification.ts
init_env();
import { TRPCError } from "@trpc/server";
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString2 = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString2(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString2(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/trpc.ts
import { initTRPC, TRPCError as TRPCError2 } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
var t = initTRPC.context().create({
  transformer: superjson,
  // Default tRPC behavior surfaces the raw ZodError (a JSON-ish array of
  // {code, path, message} issues) as `error.message`, which clients then
  // show verbatim in toasts. Collapse it into one readable sentence per
  // field instead.
  errorFormatter(opts) {
    const { shape, error } = opts;
    const zodError = error.cause instanceof ZodError ? error.cause : null;
    if (!zodError) return shape;
    const message = zodError.issues.map((issue) => {
      const field = issue.path.join(".") || "input";
      return `${field}: ${issue.message}`;
    }).join("; ");
    return { ...shape, message: message || shape.message };
  }
});
var router = t.router;
var publicProcedure = t.procedure;
var requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError2({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user
    }
  });
});
var protectedProcedure = t.procedure.use(requireUser);
var normalProtectedProcedure = protectedProcedure.use(async (opts) => {
  const { ctx, next } = opts;
  if (ctx.user.clinicUser?.mustChangePassword) {
    throw new TRPCError2({ code: "FORBIDDEN", message: PASSWORD_CHANGE_REQUIRED_ERR_MSG });
  }
  return next({ ctx });
});
var adminProcedure = normalProtectedProcedure.use(async (opts) => {
  const { ctx, next } = opts;
  if (ctx.user.role !== "admin") {
    throw new TRPCError2({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
  }
  return next({ ctx });
});
var adminOrOwnerProcedure = normalProtectedProcedure.use(async (opts) => {
  const { ctx, next } = opts;
  const isClinicAdmin = ctx.user.clinicUser?.role === "admin";
  const isOwnerAdmin = !ctx.user.clinicUser && ctx.user.role === "admin";
  if (!isClinicAdmin && !isOwnerAdmin) {
    throw new TRPCError2({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
  }
  return next({ ctx });
});

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z.object({
      timestamp: z.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z.object({
      title: z.string().min(1, "title is required"),
      content: z.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/routers.ts
init_db();

// server/actorIdentity.ts
function getActorContext(user) {
  if (user.clinicUser) {
    return {
      actorId: user.clinicUser.clinicUserId,
      actorType: "clinic_user",
      actorDisplay: user.clinicUser.name || user.clinicUser.username
    };
  }
  return {
    actorId: user.id,
    actorType: "owner",
    actorDisplay: user.name || "Owner"
  };
}

// server/routers.ts
import { randomUUID } from "crypto";

// shared/insuranceCatalog.ts
function normalizeInsurerName(name) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

// server/_core/loginRateLimit.ts
init_username();
var WINDOW_MS = 15 * 60 * 1e3;
var MAX_FAILED_ATTEMPTS = 5;
var attemptsByKey = /* @__PURE__ */ new Map();
var writesSinceSweep = 0;
var SWEEP_EVERY_N_WRITES = 200;
function sweepExpired(now) {
  attemptsByKey.forEach((entry, key) => {
    if (now - entry.windowStart > WINDOW_MS) {
      attemptsByKey.delete(key);
    }
  });
}
function keyFor(normalizedUsername, ip) {
  return `${normalizedUsername}|${ip}`;
}
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}
function isRateLimited(normalizedUsername, ip) {
  const entry = attemptsByKey.get(keyFor(normalizedUsername, ip));
  if (!entry) return false;
  if (Date.now() - entry.windowStart > WINDOW_MS) return false;
  return entry.count >= MAX_FAILED_ATTEMPTS;
}
function recordFailedAttempt(normalizedUsername, ip) {
  const now = Date.now();
  const key = keyFor(normalizedUsername, ip);
  const entry = attemptsByKey.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attemptsByKey.set(key, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
  writesSinceSweep += 1;
  if (writesSinceSweep >= SWEEP_EVERY_N_WRITES) {
    writesSinceSweep = 0;
    sweepExpired(now);
  }
}
function clearFailedAttempts(normalizedUsername, ip) {
  attemptsByKey.delete(keyFor(normalizedUsername, ip));
}

// server/routers.ts
var visitRecordInput = z2.object({
  sessionsAuthorized: z2.number().nullable().optional(),
  sessionsRemaining: z2.number().nullable().optional(),
  sessionNumber: z2.number().nullable().optional(),
  authPeriod: z2.number().optional(),
  // Which authorization period this visit belongs to
  dateOfService: z2.string().nullable().optional(),
  // ISO date string "YYYY-MM-DD"
  newAuth: z2.string().nullable().optional(),
  dateAshSubmitted: z2.string().nullable().optional(),
  // ISO date string "YYYY-MM-DD"
  authStatus: z2.enum(["none", "pending", "approved", "denied"]).optional(),
  totalInsuranceReimbursement: z2.number().nullable().optional(),
  totalPatientDue: z2.number().nullable().optional(),
  totalPatientPaid: z2.number().nullable().optional()
});
function parseDate2(s) {
  if (!s) return null;
  const trimmed = s.trim();
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (slash) {
    const [, mm, dd, yy] = slash;
    const year = yy.length === 2 ? Number(yy) <= 79 ? 2e3 + Number(yy) : 1900 + Number(yy) : Number(yy);
    const d2 = new Date(Date.UTC(year, Number(mm) - 1, Number(dd)));
    return isNaN(d2.getTime()) ? null : d2;
  }
  const d = /* @__PURE__ */ new Date(trimmed + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}
function computeSourceLineIndices(lines) {
  const seenCount = /* @__PURE__ */ new Map();
  return lines.map((line) => {
    const key = (line.cptCodes ?? "").trim();
    const index = seenCount.get(key) ?? 0;
    seenCount.set(key, index + 1);
    return index;
  });
}
function toSafeStaff(user) {
  const { passwordHash: _passwordHash, tokenVersion: _tokenVersion, ...safe } = user;
  return safe;
}
var appRouter = router({
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
          authType: "clinic",
          id: user.id,
          clinicUserId: staff.clinicUserId,
          username: staff.username,
          name: staff.name,
          email: staff.email,
          department: staff.department,
          role: staff.role,
          mustChangePassword: staff.mustChangePassword
        };
      }
      return {
        authType: "owner",
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      };
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true };
    })
  }),
  // ── Clinic username/password login ────────────────────────────────────────────────────
  clinic: router({
    login: publicProcedure.input(z2.object({ username: z2.string().min(1), password: z2.string().min(1) })).mutation(async ({ ctx, input }) => {
      const ip = getClientIp(ctx.req);
      const rateLimitKey = normalizeUsername(input.username);
      if (isRateLimited(rateLimitKey, ip)) {
        throw new TRPCError3({
          code: "TOO_MANY_REQUESTS",
          message: "Too many login attempts. Please try again later."
        });
      }
      const clinicUser = await getClinicUserByUsername(input.username);
      if (!clinicUser) {
        recordFailedAttempt(rateLimitKey, ip);
        throw new TRPCError3({ code: "UNAUTHORIZED", message: "Invalid username or password" });
      }
      const valid = await bcrypt.compare(input.password, clinicUser.passwordHash);
      if (!valid) {
        recordFailedAttempt(rateLimitKey, ip);
        throw new TRPCError3({ code: "UNAUTHORIZED", message: "Invalid username or password" });
      }
      clearFailedAttempts(rateLimitKey, ip);
      if (clinicUser.status !== "active") {
        throw new TRPCError3({ code: "FORBIDDEN", message: "This account has been archived. Contact your administrator." });
      }
      await touchClinicUserLastLogin(clinicUser.id);
      let token;
      try {
        token = await sdk.createClinicSessionToken({
          clinicUserId: clinicUser.id,
          username: clinicUser.username,
          tokenVersion: clinicUser.tokenVersion
        });
      } catch (err) {
        console.error("[clinic.login] Failed to sign session token \u2014 check JWT_SECRET is set", err);
        throw new TRPCError3({
          code: "INTERNAL_SERVER_ERROR",
          message: "Login is temporarily unavailable. Please try again later."
        });
      }
      const { upsertUser: upsertUser2 } = await Promise.resolve().then(() => (init_db(), db_exports));
      await upsertUser2({
        openId: `clinic_${clinicUser.username}`,
        name: clinicUser.username,
        email: null,
        loginMethod: "password",
        lastSignedIn: /* @__PURE__ */ new Date()
      });
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, token, {
        ...cookieOptions,
        maxAge: ONE_YEAR_MS
      });
      return { success: true, username: clinicUser.username };
    }),
    // Operates only on the currently authenticated clinic user — identity is
    // derived from the session, never accepted from the client.
    // Stays on protectedProcedure (not normalProtectedProcedure) — a clinic
    // user with mustChangePassword=true must still be able to change it.
    changePassword: protectedProcedure.input(
      z2.object({
        currentPassword: z2.string().min(1),
        newPassword: z2.string().min(MIN_CLINIC_PASSWORD_LENGTH)
      })
    ).mutation(async ({ ctx, input }) => {
      const staff = ctx.user.clinicUser;
      if (!staff) {
        throw new TRPCError3({ code: "FORBIDDEN", message: "Not a clinic staff session" });
      }
      const ip = getClientIp(ctx.req);
      const rateLimitKey = normalizeUsername(staff.username);
      if (isRateLimited(rateLimitKey, ip)) {
        throw new TRPCError3({
          code: "TOO_MANY_REQUESTS",
          message: "Too many attempts. Please try again later."
        });
      }
      const clinicUser = await getClinicUserById(staff.clinicUserId);
      if (!clinicUser || clinicUser.status !== "active") {
        throw new TRPCError3({ code: "UNAUTHORIZED", message: "Session is no longer valid" });
      }
      const validCurrent = await bcrypt.compare(input.currentPassword, clinicUser.passwordHash);
      if (!validCurrent) {
        recordFailedAttempt(rateLimitKey, ip);
        throw new TRPCError3({ code: "UNAUTHORIZED", message: "Current password is incorrect" });
      }
      clearFailedAttempts(rateLimitKey, ip);
      if (input.newPassword === input.currentPassword) {
        throw new TRPCError3({
          code: "BAD_REQUEST",
          message: "New password must be different from your current password"
        });
      }
      const newPasswordHash = await bcrypt.hash(input.newPassword, 10);
      const updated = await changeClinicUserPassword({
        id: clinicUser.id,
        passwordHash: newPasswordHash,
        expectedTokenVersion: clinicUser.tokenVersion
      });
      if (!updated) {
        throw new TRPCError3({
          code: "CONFLICT",
          message: "Your session changed during this request. Please sign in again."
        });
      }
      const token = await sdk.createClinicSessionToken({
        clinicUserId: updated.id,
        username: updated.username,
        tokenVersion: updated.tokenVersion
      });
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, token, {
        ...cookieOptions,
        maxAge: ONE_YEAR_MS
      });
      return { success: true };
    })
  }),
  // ── Staff management (S3) ────────────────────────────────────────────────────
  // Every mutation here is owner/admin only — see adminOrOwnerProcedure in
  // _core/trpc.ts for why this can't reuse adminProcedure.
  staff: router({
    list: adminOrOwnerProcedure.query(async () => {
      const rows = await listClinicUsers();
      return rows.map(toSafeStaff);
    }),
    get: adminOrOwnerProcedure.input(z2.object({ id: z2.string().uuid() })).query(async ({ input }) => {
      const row = await getClinicUserById(input.id);
      if (!row) throw new TRPCError3({ code: "NOT_FOUND", message: "Staff account not found" });
      return toSafeStaff(row);
    }),
    create: adminOrOwnerProcedure.input(
      z2.object({
        name: z2.string().min(1, "Name is required"),
        email: z2.string().trim().optional(),
        department: z2.string().trim().optional(),
        username: z2.string().trim().min(1, "Username is required"),
        role: z2.enum(["admin", "staff"]).default("staff"),
        status: z2.enum(["active", "archived"]).default("active"),
        password: z2.string().min(MIN_CLINIC_PASSWORD_LENGTH, `Password must be at least ${MIN_CLINIC_PASSWORD_LENGTH} characters`),
        confirmPassword: z2.string().min(1)
      })
    ).mutation(async ({ ctx, input }) => {
      if (input.password !== input.confirmPassword) {
        throw new TRPCError3({ code: "BAD_REQUEST", message: "Passwords do not match" });
      }
      const username = input.username.trim();
      const existing = await getClinicUserByUsername(username);
      if (existing) {
        throw new TRPCError3({ code: "CONFLICT", message: "That username is already taken" });
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
          status: input.status
        }, getActorContext(ctx.user));
        return toSafeStaff(created);
      } catch (err) {
        if (err?.code === "23505") {
          throw new TRPCError3({ code: "CONFLICT", message: "That username is already taken" });
        }
        throw err;
      }
    }),
    update: adminOrOwnerProcedure.input(
      z2.object({
        id: z2.string().uuid(),
        name: z2.string().min(1, "Name is required").optional(),
        email: z2.string().trim().optional(),
        department: z2.string().trim().optional(),
        role: z2.enum(["admin", "staff"]).optional()
      })
    ).mutation(async ({ ctx, input }) => {
      const { id, role, ...profile } = input;
      const current = await getClinicUserById(id);
      if (!current) throw new TRPCError3({ code: "NOT_FOUND", message: "Staff account not found" });
      if (role !== void 0 && role !== current.role) {
        const isOwner = !ctx.user.clinicUser && ctx.user.role === "admin";
        if (!isOwner) {
          throw new TRPCError3({ code: "FORBIDDEN", message: "Only the owner can change account roles." });
        }
        const isSelf = ctx.user.clinicUser?.clinicUserId === id;
        if (isSelf) {
          throw new TRPCError3({ code: "FORBIDDEN", message: "You cannot change your own role." });
        }
        try {
          await updateClinicUserRole({ id, role, expectedTokenVersion: current.tokenVersion }, getActorContext(ctx.user));
        } catch (err) {
          if (err instanceof LastActiveAccountManagerError) {
            throw new TRPCError3({ code: "BAD_REQUEST", message: err.message });
          }
          if (err instanceof ClinicUserConflictError) {
            throw new TRPCError3({ code: "CONFLICT", message: "This account changed during the request. Please try again." });
          }
          throw err;
        }
      }
      const profileFields = {};
      if (profile.name !== void 0) profileFields.name = profile.name;
      if (profile.email !== void 0) profileFields.email = profile.email || null;
      if (profile.department !== void 0) profileFields.department = profile.department || null;
      if (Object.keys(profileFields).length > 0) {
        await updateClinicUserProfile(id, profileFields);
      }
      const final = await getClinicUserById(id);
      if (!final) throw new TRPCError3({ code: "NOT_FOUND", message: "Staff account not found" });
      return toSafeStaff(final);
    }),
    resetPassword: adminOrOwnerProcedure.input(
      z2.object({
        id: z2.string().uuid(),
        password: z2.string().min(MIN_CLINIC_PASSWORD_LENGTH, `Password must be at least ${MIN_CLINIC_PASSWORD_LENGTH} characters`),
        confirmPassword: z2.string().min(1)
      })
    ).mutation(async ({ ctx, input }) => {
      if (input.password !== input.confirmPassword) {
        throw new TRPCError3({ code: "BAD_REQUEST", message: "Passwords do not match" });
      }
      const current = await getClinicUserById(input.id);
      if (!current) throw new TRPCError3({ code: "NOT_FOUND", message: "Staff account not found" });
      const passwordHash = await bcrypt.hash(input.password, 10);
      try {
        const updated = await adminResetClinicUserPassword({
          id: input.id,
          passwordHash,
          expectedTokenVersion: current.tokenVersion
        }, getActorContext(ctx.user));
        return toSafeStaff(updated);
      } catch (err) {
        if (err instanceof ClinicUserConflictError) {
          throw new TRPCError3({ code: "CONFLICT", message: "This account changed during the request. Please try again." });
        }
        throw err;
      }
    }),
    archive: adminOrOwnerProcedure.input(z2.object({ id: z2.string().uuid() })).mutation(async ({ ctx, input }) => {
      const isSelf = ctx.user.clinicUser?.clinicUserId === input.id;
      if (isSelf) {
        throw new TRPCError3({ code: "FORBIDDEN", message: "You cannot archive your own account." });
      }
      const current = await getClinicUserById(input.id);
      if (!current) throw new TRPCError3({ code: "NOT_FOUND", message: "Staff account not found" });
      try {
        const updated = await archiveClinicUser({ id: input.id, expectedTokenVersion: current.tokenVersion }, getActorContext(ctx.user));
        return toSafeStaff(updated);
      } catch (err) {
        if (err instanceof LastActiveAccountManagerError) {
          throw new TRPCError3({ code: "BAD_REQUEST", message: err.message });
        }
        if (err instanceof ClinicUserConflictError) {
          throw new TRPCError3({ code: "CONFLICT", message: "This account changed during the request. Please try again." });
        }
        throw err;
      }
    }),
    reactivate: adminOrOwnerProcedure.input(z2.object({ id: z2.string().uuid() })).mutation(async ({ ctx, input }) => {
      const updated = await reactivateClinicUser(input.id, getActorContext(ctx.user));
      if (!updated) throw new TRPCError3({ code: "NOT_FOUND", message: "Staff account not found" });
      return toSafeStaff(updated);
    }),
    history: adminOrOwnerProcedure.input(z2.object({ id: z2.string().uuid() })).query(async ({ input }) => {
      return listHistoryForEntity("clinic_user", input.id);
    })
  }),
  // ── Patients ────────────────────────────────────────────────────────────────
  patients: router({
    list: normalProtectedProcedure.query(async () => {
      return getAllPatients();
    }),
    get: normalProtectedProcedure.input(z2.object({ id: z2.string().uuid() })).query(async ({ input }) => {
      const patient = await getPatientById(input.id);
      if (!patient) throw new TRPCError3({ code: "NOT_FOUND", message: "Patient not found" });
      return patient;
    }),
    create: normalProtectedProcedure.input(
      z2.object({
        name: z2.string().min(1),
        insurance: z2.string().default(""),
        authDate: z2.string().nullable().optional(),
        authValidUntil: z2.number().nullable().optional()
        // Unix ms timestamp
      })
    ).mutation(async ({ input, ctx }) => {
      const id = await createPatient({
        name: input.name,
        insurance: input.insurance,
        authDate: parseDate2(input.authDate),
        authValidUntil: input.authValidUntil ?? null
      }, getActorContext(ctx.user));
      return { id };
    }),
    update: normalProtectedProcedure.input(
      z2.object({
        id: z2.string().uuid(),
        name: z2.string().min(1).optional(),
        insurance: z2.string().optional(),
        authDate: z2.string().nullable().optional(),
        authValidUntil: z2.number().nullable().optional(),
        // "none" is the API-level sentinel for "no claims status set" (see
        // getPatientById/listPatients in db.ts, which map a NULL claims_status
        // column to "none"). It is NOT a column value — accepting it here and
        // translating it to `null` below lets the edit form round-trip an
        // unset status without that NULL ever being asked to match the
        // 7-value DB enum, which is what previously threw invalid_value.
        claimsStatus: z2.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "none"]).optional()
      })
    ).mutation(async ({ input, ctx }) => {
      const { id, authDate, authValidUntil, claimsStatus, ...rest } = input;
      const before = await getPatientById(id);
      if (!before) throw new TRPCError3({ code: "NOT_FOUND", message: "Patient not found" });
      await updatePatient(id, {
        ...rest,
        ...authDate !== void 0 ? { authDate: parseDate2(authDate) } : {},
        ...authValidUntil !== void 0 ? { authValidUntil } : {},
        // Field omitted entirely → key absent → updatePatient leaves the
        // column untouched. Field present as "none" → explicit clear (NULL).
        ...claimsStatus !== void 0 ? { claimsStatus: claimsStatus === "none" ? null : claimsStatus } : {}
      }, getActorContext(ctx.user));
      return { success: true };
    }),
    delete: normalProtectedProcedure.input(z2.object({ id: z2.string().uuid() })).mutation(async ({ input }) => {
      await deletePatient(input.id);
      return { success: true };
    }),
    setActive: normalProtectedProcedure.input(z2.object({
      id: z2.string().uuid(),
      isActive: z2.boolean(),
      dischargeDate: z2.number().nullable().optional(),
      dischargeReason: z2.string().nullable().optional()
    })).mutation(async ({ input }) => {
      await setPatientActive(input.id, input.isActive, input.dischargeDate, input.dischargeReason);
      return { success: true };
    }),
    history: normalProtectedProcedure.input(z2.object({ id: z2.string().uuid() })).query(async ({ input }) => {
      return listHistoryForEntity("patient", input.id);
    })
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
    create: adminOrOwnerProcedure.input(
      z2.object({
        // Blank-after-trim is rejected by the .refine below rather than
        // z.string().min(1) alone, which would accept e.g. "   ".
        name: z2.string().transform((v) => v.trim()).refine((v) => v.length > 0, {
          message: "Insurance company name is required"
        })
      })
    ).mutation(async ({ input, ctx }) => {
      const normalizedName = normalizeInsurerName(input.name);
      const existing = await getInsurerCatalogEntryByNormalizedName(normalizedName);
      if (existing) {
        if (existing.isActive) {
          throw new TRPCError3({ code: "CONFLICT", message: "This insurance company already exists" });
        }
        return await reactivateInsurerCatalogEntry(existing.id, getActorContext(ctx.user).actorId);
      }
      try {
        return await createInsurerCatalogEntry({ name: input.name }, getActorContext(ctx.user));
      } catch (err) {
        if (err?.code === "23505") {
          throw new TRPCError3({ code: "CONFLICT", message: "This insurance company already exists" });
        }
        throw err;
      }
    }),
    // Soft delete (P4-P13) — admin/owner only. Hides the entry from
    // new-selection dropdowns without touching any patient/visit/claim
    // record (those store the insurer name as free text, not an FK into
    // this table) and without deleting the catalog row itself.
    delete: adminOrOwnerProcedure.input(z2.object({ id: z2.string().uuid() })).mutation(async ({ input, ctx }) => {
      const existing = await getInsurerCatalogEntryById(input.id);
      if (!existing) {
        throw new TRPCError3({ code: "NOT_FOUND", message: "Insurance company not found" });
      }
      return await deactivateInsurerCatalogEntry(input.id, getActorContext(ctx.user).actorId);
    }),
    // Deliberate reactivation (P4-P13) from the Manage Insurance Companies
    // dialog — distinct from insurance.create's own reactivate-on-conflict
    // path above, for an admin who wants to bring an entry back without
    // retyping its exact name.
    reactivate: adminOrOwnerProcedure.input(z2.object({ id: z2.string().uuid() })).mutation(async ({ input, ctx }) => {
      const existing = await getInsurerCatalogEntryById(input.id);
      if (!existing) {
        throw new TRPCError3({ code: "NOT_FOUND", message: "Insurance company not found" });
      }
      return await reactivateInsurerCatalogEntry(input.id, getActorContext(ctx.user).actorId);
    })
  }),
  // ── Visit Records ────────────────────────────────────────────────────────────
  visits: router({
    listByPatient: normalProtectedProcedure.input(z2.object({ patientId: z2.string().uuid() })).query(async ({ input }) => {
      return getVisitsByPatientId(input.patientId);
    }),
    create: normalProtectedProcedure.input(visitRecordInput.extend({ patientId: z2.string().uuid() })).mutation(async ({ input, ctx }) => {
      const { patientId, dateOfService, dateAshSubmitted, ...rest } = input;
      const id = await createVisitRecord({
        patientId,
        ...rest,
        dateOfService: parseDate2(dateOfService),
        dateAshSubmitted: parseDate2(dateAshSubmitted)
      }, getActorContext(ctx.user));
      return { id };
    }),
    update: normalProtectedProcedure.input(visitRecordInput.extend({ id: z2.string().uuid() })).mutation(async ({ input, ctx }) => {
      const { id, dateOfService, dateAshSubmitted, ...rest } = input;
      await updateVisitRecord(id, {
        ...rest,
        ...dateOfService !== void 0 ? { dateOfService: parseDate2(dateOfService) } : {},
        ...dateAshSubmitted !== void 0 ? { dateAshSubmitted: parseDate2(dateAshSubmitted) } : {}
      }, getActorContext(ctx.user));
      return { success: true };
    }),
    bulkCreate: normalProtectedProcedure.input(
      z2.object({
        patientId: z2.string().uuid(),
        records: z2.array(visitRecordInput)
      })
    ).mutation(async ({ input, ctx }) => {
      const rows = input.records.map((r) => ({
        patientId: input.patientId,
        sessionsAuthorized: r.sessionsAuthorized ?? null,
        sessionsRemaining: r.sessionsRemaining ?? null,
        sessionNumber: r.sessionNumber ?? null,
        authPeriod: r.authPeriod ?? 1,
        dateOfService: parseDate2(r.dateOfService),
        newAuth: r.newAuth ?? null,
        dateAshSubmitted: parseDate2(r.dateAshSubmitted),
        authStatus: r.authStatus ?? "none"
      }));
      await bulkCreateVisitRecords(rows, getActorContext(ctx.user));
      return { success: true };
    }),
    // Returns urgency summaries for ALL patients — used by the homepage alert panel
    authAlerts: normalProtectedProcedure.query(async () => {
      return getAuthAlertSummaries();
    }),
    // Approves a pending authorization and creates a new batch of visit records
    approveAuthorization: normalProtectedProcedure.input(z2.object({
      patientId: z2.string().uuid(),
      sessionsAuthorized: z2.number().min(1).max(200),
      authDate: z2.string().nullable().optional(),
      // ISO date string "YYYY-MM-DD"
      newInsurance: z2.string().optional(),
      // optional insurance change for new period
      authValidUntil: z2.number().nullable().optional()
      // Unix ms timestamp for expiry
    })).mutation(async ({ input, ctx }) => {
      const authDate = input.authDate ? /* @__PURE__ */ new Date(input.authDate + "T00:00:00Z") : null;
      const { newVisitIds } = await approveAndCreateNewBatch(
        input.patientId,
        input.sessionsAuthorized,
        authDate,
        input.newInsurance,
        input.authValidUntil ?? void 0,
        getActorContext(ctx.user)
      );
      return { success: true, newVisitCount: newVisitIds.length };
    }),
    // Returns IDs of patients whose sessions are fully completed (0 remaining + all dated)
    completedPatientIds: normalProtectedProcedure.query(async () => {
      return getCompletedPatients();
    }),
    // Sets the active-period visit row (same period getAuthAlertSummaries is
    // showing) to authStatus=pending + today's dateAshSubmitted
    markAsRequested: normalProtectedProcedure.input(z2.object({ patientId: z2.string().uuid() })).mutation(async ({ input, ctx }) => {
      const visitId = await getMarkAsRequestedTargetVisitId(input.patientId);
      if (!visitId) throw new TRPCError3({ code: "NOT_FOUND", message: "No visit records found for this patient" });
      const today = /* @__PURE__ */ new Date();
      const todayMidnight = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
      const actor = getActorContext(ctx.user);
      await updateVisitRecord(visitId, {
        authStatus: "pending",
        dateAshSubmitted: todayMidnight
      }, actor);
      return { success: true, visitId, date: todayMidnight.toISOString().split("T")[0] };
    }),
    historyForPatient: normalProtectedProcedure.input(z2.object({ patientId: z2.string().uuid() })).query(async ({ input }) => {
      return listHistoryForEntity("visit_record", input.patientId);
    })
  }),
  claims: router({
    getByPatientAndPeriod: normalProtectedProcedure.input(z2.object({ patientId: z2.string().uuid(), authPeriod: z2.number() })).query(async ({ input }) => {
      return await getClaimsByPatientAndPeriod(input.patientId, input.authPeriod);
    }),
    create: normalProtectedProcedure.input(z2.object({
      patientId: z2.string().uuid(),
      authPeriod: z2.number(),
      placeOfService: z2.string().nullable().optional(),
      dateOfService: z2.string().nullable().optional(),
      visitNumber: z2.number().nullable().optional(),
      cptCodes: z2.string().nullable().optional(),
      unitsBilled: z2.number().nullable().optional(),
      diagnosisCodes: z2.string().nullable().optional(),
      modifier: z2.string().nullable().optional(),
      chargeAmount: z2.number().nullable().optional(),
      insuranceReimbursement: z2.number().nullable().optional(),
      patientAmountPaid: z2.number().nullable().optional(),
      patientAmountDue: z2.number().nullable().optional(),
      insuranceBilled: z2.string().nullable().optional(),
      oaClaimNumber: z2.string().nullable().optional(),
      claimSubmittedDate: z2.string().nullable().optional(),
      expireBcbsClaimNumber: z2.string().nullable().optional(),
      claimStatus: z2.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "needs_review"]).optional(),
      paymentReceived: z2.number().nullable().optional(),
      checkDate: z2.string().nullable().optional(),
      checkNumberVirtualCard: z2.string().nullable().optional(),
      dateReceived: z2.string().nullable().optional(),
      dateOfAppeal: z2.string().nullable().optional(),
      referenceNo: z2.string().nullable().optional(),
      lmn: z2.string().nullable().optional()
    })).mutation(async ({ input, ctx }) => {
      const claimId = await createClaimRecord({
        patientId: input.patientId,
        authPeriod: input.authPeriod,
        placeOfService: input.placeOfService ?? null,
        dateOfService: parseDate2(input.dateOfService),
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
        claimSubmittedDate: parseDate2(input.claimSubmittedDate),
        expireBcbsClaimNumber: input.expireBcbsClaimNumber ?? null,
        claimStatus: input.claimStatus ?? "submitted",
        paymentReceived: input.paymentReceived ?? null,
        checkDate: parseDate2(input.checkDate),
        checkNumberVirtualCard: input.checkNumberVirtualCard ?? null,
        dateReceived: parseDate2(input.dateReceived),
        dateOfAppeal: parseDate2(input.dateOfAppeal),
        referenceNo: input.referenceNo ?? null,
        lmn: input.lmn ?? null
      }, getActorContext(ctx.user));
      return { success: true, claimId };
    }),
    update: normalProtectedProcedure.input(z2.object({
      id: z2.string().uuid(),
      placeOfService: z2.string().nullable().optional(),
      dateOfService: z2.string().nullable().optional(),
      visitNumber: z2.number().nullable().optional(),
      cptCodes: z2.string().nullable().optional(),
      unitsBilled: z2.number().nullable().optional(),
      diagnosisCodes: z2.string().nullable().optional(),
      modifier: z2.string().nullable().optional(),
      chargeAmount: z2.number().nullable().optional(),
      insuranceReimbursement: z2.number().nullable().optional(),
      patientAmountPaid: z2.number().nullable().optional(),
      patientAmountDue: z2.number().nullable().optional(),
      insuranceBilled: z2.string().nullable().optional(),
      oaClaimNumber: z2.string().nullable().optional(),
      claimSubmittedDate: z2.string().nullable().optional(),
      expireBcbsClaimNumber: z2.string().nullable().optional(),
      claimStatus: z2.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "needs_review"]).optional(),
      paymentReceived: z2.number().nullable().optional(),
      checkDate: z2.string().nullable().optional(),
      checkNumberVirtualCard: z2.string().nullable().optional(),
      dateReceived: z2.string().nullable().optional(),
      dateOfAppeal: z2.string().nullable().optional(),
      referenceNo: z2.string().nullable().optional()
    })).mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const alertStatuses = ["denied", "rejected", "pended", "resubmitted"];
      const shouldResetResolved = data.claimStatus !== void 0 && alertStatuses.includes(data.claimStatus);
      if (shouldResetResolved) {
        const { supabase: supabase2 } = await Promise.resolve().then(() => (init_supabase(), supabase_exports));
        await supabase2.from("claims_records").update({ is_resolved: false }).eq("id", id);
      }
      await updateClaimRecord(id, {
        placeOfService: data.placeOfService ?? void 0,
        dateOfService: data.dateOfService !== void 0 ? parseDate2(data.dateOfService) : void 0,
        visitNumber: data.visitNumber ?? void 0,
        cptCodes: data.cptCodes ?? void 0,
        unitsBilled: data.unitsBilled ?? void 0,
        diagnosisCodes: data.diagnosisCodes ?? void 0,
        modifier: data.modifier ?? void 0,
        chargeAmount: data.chargeAmount ?? void 0,
        insuranceReimbursement: data.insuranceReimbursement ?? void 0,
        patientAmountPaid: data.patientAmountPaid ?? void 0,
        patientAmountDue: data.patientAmountDue ?? void 0,
        insuranceBilled: data.insuranceBilled ?? void 0,
        oaClaimNumber: data.oaClaimNumber ?? void 0,
        claimSubmittedDate: data.claimSubmittedDate !== void 0 ? parseDate2(data.claimSubmittedDate) : void 0,
        expireBcbsClaimNumber: data.expireBcbsClaimNumber ?? void 0,
        claimStatus: data.claimStatus,
        paymentReceived: data.paymentReceived ?? void 0,
        checkDate: data.checkDate !== void 0 ? parseDate2(data.checkDate) : void 0,
        checkNumberVirtualCard: data.checkNumberVirtualCard ?? void 0,
        dateReceived: data.dateReceived !== void 0 ? parseDate2(data.dateReceived) : void 0,
        dateOfAppeal: data.dateOfAppeal !== void 0 ? parseDate2(data.dateOfAppeal) : void 0,
        referenceNo: data.referenceNo ?? void 0
      }, getActorContext(ctx.user));
      return { success: true };
    }),
    delete: adminOrOwnerProcedure.input(z2.object({ id: z2.string().uuid(), patientId: z2.string().uuid() })).mutation(async ({ input, ctx }) => {
      const actor = getActorContext(ctx.user);
      try {
        await deleteClaimRecordWithAudit({
          claimId: input.id,
          patientId: input.patientId,
          actorId: actor.actorId,
          actorType: actor.actorType,
          actorDisplay: actor.actorDisplay
        });
      } catch (err) {
        if (err instanceof ClaimRecordNotFoundError) {
          throw new TRPCError3({ code: "NOT_FOUND", message: "Claim record not found. It may have already been deleted." });
        }
        if (err instanceof ClaimRecordPatientMismatchError) {
          throw new TRPCError3({ code: "BAD_REQUEST", message: "This claim does not belong to the selected patient." });
        }
        throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR", message: "Failed to delete claim record. No changes were made." });
      }
      return { success: true };
    }),
    upsert: normalProtectedProcedure.input(z2.object({
      patientId: z2.string().uuid(),
      authPeriod: z2.number(),
      placeOfService: z2.string().nullable().optional(),
      dateOfService: z2.string().nullable().optional(),
      visitNumber: z2.number().nullable().optional(),
      cptCodes: z2.string().nullable().optional(),
      unitsBilled: z2.number().nullable().optional(),
      diagnosisCodes: z2.string().nullable().optional(),
      modifier: z2.string().nullable().optional(),
      chargeAmount: z2.number().nullable().optional(),
      insuranceReimbursement: z2.number().nullable().optional(),
      patientAmountPaid: z2.number().nullable().optional(),
      patientAmountDue: z2.number().nullable().optional(),
      insuranceBilled: z2.string().nullable().optional(),
      oaClaimNumber: z2.string().nullable().optional(),
      claimSubmittedDate: z2.string().nullable().optional(),
      expireBcbsClaimNumber: z2.string().nullable().optional(),
      claimStatus: z2.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "needs_review"]).optional(),
      paymentReceived: z2.number().nullable().optional(),
      checkDate: z2.string().nullable().optional(),
      checkNumberVirtualCard: z2.string().nullable().optional(),
      dateReceived: z2.string().nullable().optional(),
      dateOfAppeal: z2.string().nullable().optional(),
      referenceNo: z2.string().nullable().optional(),
      lmn: z2.string().nullable().optional(),
      // P4-P14: 0-based position of this line among source lines sharing
      // its CPT code within the same save batch — see
      // computeSourceLineIndices. Omitted entirely by any caller that
      // doesn't have a notion of "repeated lines" (preserves exact prior
      // matching behavior for those callers).
      sourceLineIndex: z2.number().int().min(0).nullable().optional()
    })).mutation(async ({ input, ctx }) => {
      try {
        await upsertClaimRecord({
          patientId: input.patientId,
          authPeriod: input.authPeriod,
          placeOfService: input.placeOfService ?? null,
          dateOfService: parseDate2(input.dateOfService),
          visitNumber: input.visitNumber ?? null,
          cptCodes: input.cptCodes ?? null,
          sourceLineIndex: input.sourceLineIndex ?? null,
          unitsBilled: input.unitsBilled ?? null,
          diagnosisCodes: input.diagnosisCodes ?? null,
          modifier: input.modifier ?? null,
          chargeAmount: input.chargeAmount ?? null,
          insuranceReimbursement: input.insuranceReimbursement ?? null,
          patientAmountPaid: input.patientAmountPaid ?? null,
          patientAmountDue: input.patientAmountDue ?? null,
          insuranceBilled: input.insuranceBilled ?? null,
          oaClaimNumber: input.oaClaimNumber ?? null,
          claimSubmittedDate: parseDate2(input.claimSubmittedDate),
          expireBcbsClaimNumber: input.expireBcbsClaimNumber ?? null,
          claimStatus: input.claimStatus ?? "submitted",
          paymentReceived: input.paymentReceived ?? null,
          checkDate: parseDate2(input.checkDate),
          checkNumberVirtualCard: input.checkNumberVirtualCard ?? null,
          dateReceived: parseDate2(input.dateReceived),
          dateOfAppeal: parseDate2(input.dateOfAppeal),
          referenceNo: input.referenceNo ?? null,
          lmn: input.lmn ?? null
        }, getActorContext(ctx.user));
      } catch (err) {
        if (err instanceof ClaimLineIdentityAmbiguousError) {
          throw new TRPCError3({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
      return { success: true };
    }),
    historyForClaim: normalProtectedProcedure.input(z2.object({ id: z2.string().uuid() })).query(async ({ input }) => {
      return listHistoryForEntity("claim_record", input.id);
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
    cms1500EnrichmentPreview: normalProtectedProcedure.input(z2.object({
      patientId: z2.string().uuid(),
      lines: z2.array(z2.object({
        lineKey: z2.string(),
        dateOfService: z2.string().nullable(),
        cptCodes: z2.string().nullable()
      }))
    })).mutation(async ({ input }) => {
      const hasAnyClaims = await patientHasAnyClaimRecords(input.patientId);
      const results = await Promise.all(input.lines.map(async (line) => {
        const dos = parseDate2(line.dateOfService);
        if (!dos) {
          return { lineKey: line.lineKey, status: "invalid_date", candidates: [] };
        }
        const candidates = await findCms1500EnrichmentCandidates(input.patientId, dos, line.cptCodes ?? null);
        if (candidates.length === 0) {
          const status = hasAnyClaims ? "no_match" : "no_claims";
          return { lineKey: line.lineKey, status, candidates: [] };
        }
        if (candidates.length === 1) {
          const status = candidates[0].hasReimbursementEvidence ? "matched" : "matched_unconfirmed";
          return { lineKey: line.lineKey, status, candidates, claimRecordId: candidates[0].id };
        }
        return { lineKey: line.lineKey, status: "needs_selection", candidates };
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
    cms1500EnrichmentCommit: normalProtectedProcedure.input(z2.object({
      patientId: z2.string().uuid(),
      lines: z2.array(z2.object({
        lineKey: z2.string(),
        claimRecordId: z2.string().uuid(),
        dateOfService: z2.string().nullable(),
        cptCodes: z2.string().nullable(),
        visitNumber: z2.number().nullable().optional(),
        diagnosisCodes: z2.string().nullable().optional(),
        modifier: z2.string().nullable().optional(),
        unitsBilled: z2.number().nullable().optional()
      }))
    })).mutation(async ({ input, ctx }) => {
      const actor = getActorContext(ctx.user);
      const importBatchId = randomUUID();
      const results = [];
      for (const line of input.lines) {
        try {
          const dos = parseDate2(line.dateOfService);
          if (!dos) throw new Error("Invalid or missing date of service.");
          await applyCms1500Enrichment({
            claimRecordId: line.claimRecordId,
            patientId: input.patientId,
            dateOfService: dos,
            cptCodes: line.cptCodes ?? null,
            visitNumber: line.visitNumber ?? null,
            diagnosisCodes: line.diagnosisCodes ?? null,
            modifier: line.modifier ?? null,
            unitsBilled: line.unitsBilled ?? null,
            actor,
            importBatchId
          });
          results.push({ lineKey: line.lineKey, status: "saved" });
        } catch (err) {
          results.push({ lineKey: line.lineKey, status: "failed", error: err?.message ?? "Unknown error" });
        }
      }
      return { results };
    }),
    /**
     * Bulk import claims from a multi-patient EOB file.
     * Matches patient names (case-insensitive) against dashboard patients,
     * finds each patient's latest auth period, and saves all their claims.
     */
    bulkImportFromEOB: normalProtectedProcedure.input(z2.object({
      uploadType: z2.enum(["reimbursement", "cms1500"]).default("reimbursement"),
      patientGroups: z2.array(z2.object({
        patientName: z2.string(),
        claims: z2.array(z2.object({
          // Date-level fields (shared across all CPT lines for this date)
          placeOfService: z2.string().nullable().optional(),
          dateOfService: z2.string().nullable().optional(),
          visitNumber: z2.number().nullable().optional(),
          insuranceBilled: z2.string().nullable().optional(),
          oaClaimNumber: z2.string().nullable().optional(),
          claimSubmittedDate: z2.string().nullable().optional(),
          expireBcbsClaimNumber: z2.string().nullable().optional(),
          claimStatus: z2.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "needs_review"]).optional(),
          checkDate: z2.string().nullable().optional(),
          checkNumberVirtualCard: z2.string().nullable().optional(),
          dateReceived: z2.string().nullable().optional(),
          dateOfAppeal: z2.string().nullable().optional(),
          referenceNo: z2.string().nullable().optional(),
          lmn: z2.string().nullable().optional(),
          // CPT sub-rows (one claim record per line)
          cptLines: z2.array(z2.object({
            cptCodes: z2.string().nullable().optional(),
            chargeAmount: z2.number().nullable().optional(),
            insuranceReimbursement: z2.number().nullable().optional(),
            patientAmountPaid: z2.number().nullable().optional(),
            patientAmountDue: z2.number().nullable().optional(),
            unitsBilled: z2.number().nullable().optional(),
            modifier: z2.string().nullable().optional(),
            diagnosisCodes: z2.string().nullable().optional()
          })).optional(),
          // Fallback flat fields (when no cptLines)
          cptCodes: z2.string().nullable().optional(),
          unitsBilled: z2.number().nullable().optional(),
          diagnosisCodes: z2.string().nullable().optional(),
          modifier: z2.string().nullable().optional(),
          chargeAmount: z2.number().nullable().optional(),
          insuranceReimbursement: z2.number().nullable().optional(),
          patientAmountPaid: z2.number().nullable().optional(),
          patientAmountDue: z2.number().nullable().optional(),
          paymentReceived: z2.number().nullable().optional()
        }))
      })),
      // Staff-confirmed matches for groups whose extracted name only
      // produced an ambiguous "candidate" in the preview (see
      // shared/nameMatch.ts classifyPatientMatch) — e.g. a spelled-out
      // middle name the fuzzy matcher correctly refuses to auto-match.
      // Index into patientGroups; never used to override a name that
      // *does* safely fuzzy-match (that path is untouched below).
      confirmedMatches: z2.array(z2.object({
        groupIndex: z2.number().int().nonnegative(),
        patientId: z2.string().uuid()
      })).optional()
    })).mutation(async ({ input, ctx }) => {
      const { supabase: supabase2 } = await Promise.resolve().then(() => (init_supabase(), supabase_exports));
      const allPatients = await getAllPatients();
      const uploadType = input.uploadType ?? "reimbursement";
      const actor = getActorContext(ctx.user);
      const importBatchId = randomUUID();
      const confirmedMatches = input.confirmedMatches ?? [];
      const seenGroupIndexes = /* @__PURE__ */ new Set();
      for (const c of confirmedMatches) {
        if (c.groupIndex >= input.patientGroups.length) {
          throw new TRPCError3({
            code: "BAD_REQUEST",
            message: `confirmedMatches: groupIndex ${c.groupIndex} does not refer to any group in this import`
          });
        }
        if (seenGroupIndexes.has(c.groupIndex)) {
          throw new TRPCError3({
            code: "BAD_REQUEST",
            message: `confirmedMatches: conflicting duplicate confirmation for groupIndex ${c.groupIndex}`
          });
        }
        seenGroupIndexes.add(c.groupIndex);
      }
      const confirmedByIndex = new Map(
        confirmedMatches.map((c) => [c.groupIndex, c.patientId])
      );
      const results = [];
      for (let groupIndex = 0; groupIndex < input.patientGroups.length; groupIndex++) {
        const group = input.patientGroups[groupIndex];
        const { classifyPatientMatch: classifyPatientMatch2 } = await Promise.resolve().then(() => (init_nameMatch(), nameMatch_exports));
        const { confirmed: safeMatch, candidates } = classifyPatientMatch2(group.patientName, allPatients);
        const confirmedId = safeMatch ? null : confirmedByIndex.get(groupIndex) ?? null;
        const confirmedPatient = confirmedId ? candidates.find((p) => p.id === confirmedId) ?? null : null;
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
            ...candidates.length > 0 ? { ambiguousCandidates: candidates.length } : {}
          });
          continue;
        }
        const { data: periodRows } = await supabase2.from("visit_records").select("auth_period").eq("patient_id", matchedPatient.id);
        const maxPeriod = periodRows && periodRows.length > 0 ? Math.max(...periodRows.map((r) => r.auth_period ?? 1)) : 1;
        let claimsImported = 0;
        let skippedNoMatch = 0;
        let skippedNoReimbursementUploaded = 0;
        let skippedNeedsSelection = 0;
        let skippedUnconfirmedProvenance = 0;
        let skippedAmbiguousLineIdentity = 0;
        const skippedCms1500Lines = [];
        const skippedReimbursementLines = [];
        try {
          if (uploadType === "cms1500") {
            const hasAnyClaims = await patientHasAnyClaimRecords(matchedPatient.id);
            for (const claim of group.claims) {
              const lines = claim.cptLines && claim.cptLines.length > 0 ? claim.cptLines : [{
                cptCodes: claim.cptCodes ?? null,
                unitsBilled: claim.unitsBilled ?? null,
                modifier: claim.modifier ?? null,
                diagnosisCodes: claim.diagnosisCodes ?? null
              }];
              const dos = parseDate2(claim.dateOfService);
              for (const line of lines) {
                if (!dos) {
                  skippedNoMatch++;
                  skippedCms1500Lines.push({ dateOfService: claim.dateOfService ?? null, cptCodes: line.cptCodes ?? null, reason: "invalid_date" });
                  continue;
                }
                const candidates2 = await findCms1500EnrichmentCandidates(matchedPatient.id, dos, line.cptCodes ?? null);
                if (candidates2.length === 0) {
                  if (hasAnyClaims) {
                    skippedNoMatch++;
                    skippedCms1500Lines.push({ dateOfService: claim.dateOfService ?? null, cptCodes: line.cptCodes ?? null, reason: "no_match" });
                  } else {
                    skippedNoReimbursementUploaded++;
                    skippedCms1500Lines.push({ dateOfService: claim.dateOfService ?? null, cptCodes: line.cptCodes ?? null, reason: "no_reimbursement_uploaded" });
                  }
                  continue;
                }
                if (candidates2.length > 1) {
                  skippedNeedsSelection++;
                  skippedCms1500Lines.push({ dateOfService: claim.dateOfService ?? null, cptCodes: line.cptCodes ?? null, reason: "needs_selection" });
                  continue;
                }
                if (!candidates2[0].hasReimbursementEvidence) {
                  skippedUnconfirmedProvenance++;
                  skippedCms1500Lines.push({ dateOfService: claim.dateOfService ?? null, cptCodes: line.cptCodes ?? null, reason: "unconfirmed_provenance" });
                  continue;
                }
                await applyCms1500Enrichment({
                  claimRecordId: candidates2[0].id,
                  patientId: matchedPatient.id,
                  dateOfService: dos,
                  cptCodes: line.cptCodes ?? null,
                  visitNumber: claim.visitNumber ?? null,
                  diagnosisCodes: line.diagnosisCodes ?? null,
                  modifier: line.modifier ?? null,
                  unitsBilled: line.unitsBilled ?? null,
                  actor,
                  importBatchId
                });
                claimsImported++;
              }
            }
          } else {
            for (const claim of group.claims) {
              const lines = claim.cptLines && claim.cptLines.length > 0 ? claim.cptLines : [{
                // fallback: treat the claim itself as a single line
                cptCodes: claim.cptCodes ?? null,
                chargeAmount: claim.chargeAmount ?? null,
                insuranceReimbursement: claim.insuranceReimbursement ?? null,
                patientAmountPaid: claim.patientAmountPaid ?? null,
                patientAmountDue: claim.patientAmountDue ?? null,
                unitsBilled: claim.unitsBilled ?? null,
                modifier: claim.modifier ?? null,
                diagnosisCodes: claim.diagnosisCodes ?? null
              }];
              const lineIndices = computeSourceLineIndices(lines);
              for (let lIdx = 0; lIdx < lines.length; lIdx++) {
                const line = lines[lIdx];
                try {
                  await upsertClaimRecord({
                    patientId: matchedPatient.id,
                    authPeriod: maxPeriod,
                    dateOfService: parseDate2(claim.dateOfService),
                    cptCodes: line.cptCodes ?? null,
                    sourceLineIndex: lineIndices[lIdx],
                    claimStatus: claim.claimStatus ?? "submitted",
                    oaClaimNumber: claim.oaClaimNumber ?? null,
                    insuranceReimbursement: line.insuranceReimbursement ?? null,
                    patientAmountPaid: line.patientAmountPaid ?? null,
                    patientAmountDue: line.patientAmountDue ?? null,
                    checkDate: parseDate2(claim.checkDate),
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
                    dateReceived: parseDate2(claim.dateReceived),
                    dateOfAppeal: parseDate2(claim.dateOfAppeal),
                    lmn: claim.lmn ?? null
                  }, actor, importBatchId);
                  claimsImported++;
                } catch (lineErr) {
                  if (lineErr instanceof ClaimLineIdentityAmbiguousError) {
                    skippedAmbiguousLineIdentity++;
                    skippedReimbursementLines.push({
                      dateOfService: claim.dateOfService ?? null,
                      cptCodes: line.cptCodes ?? null,
                      reason: "needs_review"
                    });
                    continue;
                  }
                  throw lineErr;
                }
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
            ...skippedNoMatch > 0 ? { skippedNoMatch } : {},
            ...skippedNoReimbursementUploaded > 0 ? { skippedNoReimbursementUploaded } : {},
            ...skippedNeedsSelection > 0 ? { skippedNeedsSelection } : {},
            ...skippedUnconfirmedProvenance > 0 ? { skippedUnconfirmedProvenance } : {},
            ...skippedCms1500Lines.length > 0 ? { skippedCms1500Lines } : {},
            ...skippedAmbiguousLineIdentity > 0 ? { skippedAmbiguousLineIdentity } : {},
            ...skippedReimbursementLines.length > 0 ? { skippedReimbursementLines } : {}
          });
        } catch (err) {
          results.push({
            patientName: group.patientName,
            matched: true,
            patientId: matchedPatient.id,
            dashboardName: matchedPatient.name,
            authPeriod: maxPeriod,
            claimsImported,
            error: err?.message ?? "Unknown error"
          });
        }
      }
      return { results };
    }),
    markResolved: normalProtectedProcedure.input(z2.object({ id: z2.string().uuid() })).mutation(async ({ input }) => {
      const { supabase: supabase2 } = await Promise.resolve().then(() => (init_supabase(), supabase_exports));
      const { error } = await supabase2.from("claims_records").update({ is_resolved: true, claim_status: "pending" }).eq("id", input.id);
      if (error) throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return { success: true };
    }),
    getFollowUpClaims: normalProtectedProcedure.input(z2.object({ insurance: z2.string().optional() }).optional()).query(async ({ input }) => {
      const { supabase: supabase2 } = await Promise.resolve().then(() => (init_supabase(), supabase_exports));
      let query = supabase2.from("claims_records").select(`
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
          `).in("claim_status", ["denied", "rejected", "pended", "resubmitted", "pending", "submitted", "approved"]).neq("is_resolved", true);
      if (input?.insurance) {
        query = query.eq("patients.insurance", input.insurance);
      }
      const { data, error } = await query;
      if (error) throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      const classified = (data ?? []).flatMap((row) => {
        const result = classifyClaimFollowUp({
          claimStatus: row.claim_status,
          insuranceReimbursement: row.insurance_reimbursement,
          claimSubmittedDate: row.claim_submitted_date
        });
        if (!result) return [];
        return [{
          id: row.id,
          patientId: row.patient_id,
          patientName: row.patients?.name,
          insurance: row.patients?.insurance,
          authPeriod: row.auth_period,
          dateOfService: row.date_of_service,
          cptCodes: row.cpt_codes,
          chargeAmount: row.charge_amount,
          insuranceReimbursement: row.insurance_reimbursement,
          claimStatus: row.claim_status,
          claimSubmittedDate: row.claim_submitted_date,
          claimNumber: row.expire_bcbs_claim_number,
          urgency: result.urgency,
          followUpReason: result.followUpReason
        }];
      });
      return sortByFollowUpUrgency(classified);
    }),
    getStatusCounts: normalProtectedProcedure.input(z2.object({ insurance: z2.string().optional() }).optional()).query(async ({ input }) => {
      const { supabase: supabase2 } = await Promise.resolve().then(() => (init_supabase(), supabase_exports));
      let query = supabase2.from("claims_records").select("claim_status, patient_id, patients!inner(insurance)");
      if (input?.insurance) {
        query = query.eq("patients.insurance", input.insurance);
      }
      const { data, error } = await query;
      if (error) throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return aggregateClaimStatusCounts(
        (data ?? []).map((row) => ({
          claimStatus: row.claim_status,
          patientId: row.patient_id
        }))
      );
    })
  }),
  // ── Activity Log (P4-P17) ───────────────────────────────────────────────────
  // Cross-entity, paginated, filterable view over audit_logs — owner/admin
  // only, same gate as Staff Management (adminOrOwnerProcedure). Read-only:
  // there is no mutation here, and audit_logs itself has no browser-reachable
  // write path at all (service_role-only, see the P4-P17 migration's RLS).
  activityLog: router({
    list: adminOrOwnerProcedure.input(z2.object({
      actorId: z2.string().uuid().optional(),
      entityType: z2.enum(["patient", "visit_record", "claim_record", "insurer_catalog", "clinic_user"]).optional(),
      action: z2.string().optional(),
      dateFrom: z2.string().nullable().optional(),
      // ISO date string "YYYY-MM-DD"
      dateTo: z2.string().nullable().optional(),
      page: z2.number().int().min(0).default(0),
      pageSize: z2.number().int().min(1).max(200).default(50)
    })).query(async ({ input }) => {
      return listActivityLog({
        actorId: input.actorId ?? null,
        entityType: input.entityType ?? null,
        action: input.action ?? null,
        dateFrom: parseDate2(input.dateFrom),
        dateTo: parseDate2(input.dateTo),
        page: input.page,
        pageSize: input.pageSize
      });
    })
  })
});

// server/_core/context.ts
async function createContext(opts) {
  let user = null;
  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    user = null;
  }
  return {
    req: opts.req,
    res: opts.res,
    user
  };
}

// server/_core/vite.ts
import express from "express";
import fs from "fs";
import { nanoid } from "nanoid";
import path from "path";
function serveStatic(app2) {
  const distPath = process.env.NODE_ENV === "development" ? path.resolve(import.meta.dirname, "../..", "dist", "public") : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app2.use(express.static(distPath));
  app2.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

// server/vercelEntry.ts
var app = express2();
app.use(express2.json({ limit: "50mb" }));
app.use(express2.urlencoded({ limit: "50mb", extended: true }));
registerStorageProxy(app);
registerOAuthRoutes(app);
registerClaimUploadRoute(app);
app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext
  })
);
serveStatic(app);
var vercelEntry_default = app;
export {
  vercelEntry_default as default
};
