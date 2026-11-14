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
  const leftover = Math.max(0, authorized - completed);
  const expired = periodVisits.some((v) => v.periodExpiredAt != null);
  return {
    authorized,
    completed,
    remaining: expired ? 0 : leftover,
    expired,
    unusedExpired: expired ? leftover : 0
  };
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
  const activeMetrics = activePeriod != null ? getPeriodMetrics(visits, activePeriod) : { authorized: 0, completed: 0, remaining: 0, expired: false, unusedExpired: 0 };
  return { periods, activePeriod, activeMetrics };
}
function areAllAuthorizedSessionsUsed(visits) {
  if (visits.length === 0) return false;
  return determineActivePeriod(visits.map((v) => ({ ...v, periodExpiredAt: null }))) === null;
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
  const { remaining, authStatus = null, authValidUntil = null, now = /* @__PURE__ */ new Date(), periodExpired = false } = input;
  let urgency = "ok";
  if (remaining === 0) urgency = "exhausted";
  else if (remaining <= 2) urgency = "critical";
  else if (remaining <= 3) urgency = "warning";
  if (authStatus === "pending" && urgency === "ok") urgency = "pending";
  if (periodExpired) {
    urgency = authStatus === "pending" ? "pending" : "expired";
  }
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
  ClaimImportRuleError: () => ClaimImportRuleError,
  ClaimRecordNotFoundError: () => ClaimRecordNotFoundError,
  ClaimRecordPatientMismatchError: () => ClaimRecordPatientMismatchError,
  ClinicUserConflictError: () => ClinicUserConflictError,
  FOLLOW_UP_STALE_DAYS: () => FOLLOW_UP_STALE_DAYS,
  InsurerCatalogEntryNotFoundError: () => InsurerCatalogEntryNotFoundError,
  InsurerCatalogHasForeignKeysError: () => InsurerCatalogHasForeignKeysError,
  InsurerDeletedError: () => InsurerDeletedError,
  LastActiveAccountManagerError: () => LastActiveAccountManagerError,
  PENDING_EOB_LIST_LIMIT: () => PENDING_EOB_LIST_LIMIT,
  adminResetClinicUserPassword: () => adminResetClinicUserPassword,
  aggregateClaimStatusCounts: () => aggregateClaimStatusCounts,
  applyEobLine: () => applyEobLine,
  applyPendingEobLine: () => applyPendingEobLine,
  approveAndCreateNewBatch: () => approveAndCreateNewBatch,
  archiveClinicUser: () => archiveClinicUser,
  bulkCreateVisitRecords: () => bulkCreateVisitRecords,
  changeClinicUserPassword: () => changeClinicUserPassword,
  classifyClaimFollowUp: () => classifyClaimFollowUp,
  commitCms1500Line: () => commitCms1500Line,
  commitImportWithNewPatient: () => commitImportWithNewPatient,
  commitPatientCsvGroup: () => commitPatientCsvGroup,
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
  dismissPendingEobLine: () => dismissPendingEobLine,
  findClaimImportDocumentId: () => findClaimImportDocumentId,
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
  getVisitRecordById: () => getVisitRecordById,
  getVisitsByPatientId: () => getVisitsByPatientId,
  holdEobLine: () => holdEobLine,
  linkPatientExternalId: () => linkPatientExternalId,
  listActivityLog: () => listActivityLog,
  listClaimLinesForDocument: () => listClaimLinesForDocument,
  listClinicUsers: () => listClinicUsers,
  listDismissedEobLines: () => listDismissedEobLines,
  listHeldEobLineKeys: () => listHeldEobLineKeys,
  listHistoryForEntity: () => listHistoryForEntity,
  listInsurerCatalog: () => listInsurerCatalog,
  listPatientClaimLinesOnDates: () => listPatientClaimLinesOnDates,
  listPatientClaimPeriods: () => listPatientClaimPeriods,
  listPatientExternalIds: () => listPatientExternalIds,
  listPatientVisitPeriodDates: () => listPatientVisitPeriodDates,
  listPendingEobLines: () => listPendingEobLines,
  permanentlyDeleteInsurerCatalogEntry: () => permanentlyDeleteInsurerCatalogEntry,
  reactivateClinicUser: () => reactivateClinicUser,
  reactivateInsurerCatalogEntry: () => reactivateInsurerCatalogEntry,
  reopenDismissedEobLine: () => reopenDismissedEobLine,
  setAuthPeriodExpired: () => setAuthPeriodExpired,
  setPatientActive: () => setPatientActive,
  sortByFollowUpUrgency: () => sortByFollowUpUrgency,
  touchClinicUserLastLogin: () => touchClinicUserLastLogin,
  updateClaimRecord: () => updateClaimRecord,
  updateClinicUserProfile: () => updateClinicUserProfile,
  updateClinicUserRole: () => updateClinicUserRole,
  updatePatient: () => updatePatient,
  updateVisitRecord: () => updateVisitRecord,
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
    // P4-P31: period-level expiry mark (null = not expired).
    periodExpiredAt: row.period_expired_at ? new Date(row.period_expired_at) : null,
    insuranceCompany: row.insurance_company ?? null,
    totalInsuranceReimbursement: row.total_insurance_reimbursement ?? null,
    totalPatientDue: row.total_patient_due ?? null,
    totalPatientPaid: row.total_patient_paid ?? null,
    assignmentOfBenefits: row.assignment_of_benefits ?? null,
    submissionStatus: row.submission_status ?? null,
    remarks: row.remarks ?? null,
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
    mapInsurerAssignmentError(error);
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
    mapInsurerAssignmentError(error);
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
  if (filters.excludeClaims) {
    query = query.or("entity_type.is.null,entity_type.not.in.(claim_record,pending_eob_line)").not("action", "ilike", "CLAIM%").not("action", "ilike", "EOB_LINE%").not("action", "ilike", "PATIENT_EXTERNAL_ID%");
  }
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
async function getVisitRecordById(id) {
  const { data, error } = await supabase.from("visit_records").select("*").eq("id", id).maybeSingle();
  if (error) {
    console.error("[Supabase] getVisitRecordById:", error);
    throw error;
  }
  return data ? toVisitRecord(data) : void 0;
}
async function createVisitRecord(data, actor, action = "VISIT_RECORD_CREATE") {
  const payload = {
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
    total_patient_paid: data.totalPatientPaid ?? null
  };
  const { data: id, error } = await supabase.rpc("write_visit_record_with_audit", {
    p_id: null,
    p_patient_id: data.patientId,
    p_data: payload,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: action
  });
  if (error) {
    console.error("[Supabase] createVisitRecord:", error);
    throw error;
  }
  return id;
}
async function updateVisitRecord(id, data, actor, options) {
  const action = options?.action ?? "VISIT_RECORD_UPDATE";
  const payload = {};
  if (data.sessionsAuthorized !== void 0) payload.sessions_authorized = data.sessionsAuthorized;
  if (data.sessionsRemaining !== void 0) payload.sessions_remaining = data.sessionsRemaining;
  if (data.sessionNumber !== void 0) payload.session_number = data.sessionNumber;
  if (data.authPeriod !== void 0) payload.auth_period = data.authPeriod;
  if (data.dateOfService !== void 0) {
    payload.date_of_service = data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null;
  }
  if (data.newAuth !== void 0) payload.new_auth = data.newAuth;
  if (data.dateAshSubmitted !== void 0) {
    payload.date_ash_submitted = data.dateAshSubmitted ? data.dateAshSubmitted.toISOString().split("T")[0] : null;
  }
  if (data.authStatus !== void 0) payload.auth_status = data.authStatus;
  if (data.totalInsuranceReimbursement !== void 0) payload.total_insurance_reimbursement = data.totalInsuranceReimbursement;
  if (data.totalPatientDue !== void 0) payload.total_patient_due = data.totalPatientDue;
  if (data.totalPatientPaid !== void 0) payload.total_patient_paid = data.totalPatientPaid;
  if (data.assignmentOfBenefits !== void 0) payload.assignment_of_benefits = data.assignmentOfBenefits;
  if (data.submissionStatus !== void 0) payload.submission_status = data.submissionStatus;
  if (data.remarks !== void 0) payload.remarks = data.remarks;
  if (Object.keys(payload).length === 0) return;
  const { error } = await supabase.rpc("write_visit_record_with_audit", {
    p_id: id,
    p_patient_id: options?.patientId ?? null,
    p_data: payload,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: action
  });
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
        authPeriod: null,
        periodExpired: false,
        unusedExpiredSessions: 0
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
    const targetMetrics = getPeriodMetrics(pVisits, targetPeriod);
    const authValidUntil = patient.authValidUntil ?? null;
    const { urgency, authExpiryWarning } = deriveAuthorizationUrgency({
      remaining: sessionsRemaining,
      authStatus,
      authValidUntil,
      now: /* @__PURE__ */ new Date(),
      periodExpired: targetMetrics.expired
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
      authPeriod: targetPeriod,
      periodExpired: targetMetrics.expired,
      unusedExpiredSessions: targetMetrics.unusedExpired
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
      dateOfService: v.date_of_service,
      periodExpiredAt: v.period_expired_at ?? null
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
  const { data, error } = await supabase.from("visit_records").select("id, auth_period, session_number, sessions_authorized, date_of_service, period_expired_at").eq("patient_id", patientId);
  if (error) {
    console.error("[Supabase] getMarkAsRequestedTargetVisitId:", error);
    return null;
  }
  if (!data || data.length === 0) return null;
  const target = determineMarkAsRequestedTargetRow(data);
  return target?.id ?? null;
}
async function approveAndCreateNewBatch(patientId, sessionsAuthorized, authDate, newInsurance, authValidUntil, actor) {
  const { data: periodStatusRows, error: periodStatusErr } = await supabase.from("visit_records").select("auth_period, sessions_authorized, date_of_service, period_expired_at").eq("patient_id", patientId);
  if (periodStatusErr) {
    console.error("[Supabase] approveAndCreateNewBatch periodStatus:", periodStatusErr);
    throw periodStatusErr;
  }
  const statusRows = periodStatusRows ?? [];
  const statusPeriods = Array.from(new Set(statusRows.map((r) => r.auth_period ?? 1))).sort((a, b) => a - b);
  const latestStatusPeriod = statusPeriods.length > 0 ? statusPeriods[statusPeriods.length - 1] : 1;
  const targetApprovalPeriod = determineActiveAuthPeriod(statusRows) ?? latestStatusPeriod;
  const { data: newVisitIds, error } = await supabase.rpc("approve_authorization_with_audit", {
    p_patient_id: patientId,
    p_target_period: targetApprovalPeriod,
    p_sessions_authorized: sessionsAuthorized,
    p_auth_date: authDate ? authDate.toISOString().split("T")[0] : null,
    p_new_insurance: newInsurance ?? null,
    p_auth_valid_until_provided: authValidUntil !== void 0,
    p_auth_valid_until: authValidUntil ?? null,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay
  });
  if (error) {
    console.error("[Supabase] approveAndCreateNewBatch:", error);
    throw error;
  }
  return { newVisitIds: newVisitIds ?? [] };
}
async function setAuthPeriodExpired(patientId, authPeriod, expired, reason, actor) {
  const { data, error } = await supabase.rpc("set_auth_period_expired_with_audit", {
    p_patient_id: patientId,
    p_auth_period: authPeriod,
    p_expired: expired,
    p_reason: reason,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay
  });
  if (error) {
    console.error("[Supabase] setAuthPeriodExpired:", error);
    throw error;
  }
  return typeof data === "number" ? data : 0;
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
    return areAllAuthorizedSessionsUsed(pVisits);
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
  for (const key2 of [...CLAIM_STATUS_KEYS, "none"]) {
    counts[key2] = 0;
    patientIdSets[key2] = /* @__PURE__ */ new Set();
  }
  for (const row of rows) {
    const status = row.claimStatus?.trim();
    const key2 = status && CLAIM_STATUS_KEYS.includes(status) ? status : "none";
    counts[key2] += 1;
    patientIdSets[key2].add(row.patientId);
  }
  const patientIdsByStatus = Object.fromEntries(
    Object.entries(patientIdSets).map(([key2, set]) => [key2, Array.from(set)])
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
async function listPatientClaimLinesOnDates(patientId, dates) {
  const unique = Array.from(new Set(dates.filter(Boolean)));
  if (unique.length === 0) return [];
  const { data, error } = await supabase.from("claims_records").select(EXISTING_LINE_COLUMNS).eq("patient_id", patientId).in("date_of_service", unique).order("created_at", { ascending: true }).order("id", { ascending: true });
  if (error) {
    console.error("[Supabase] listPatientClaimLinesOnDates:", error);
    throw error;
  }
  return (data ?? []).map(toExistingClaimLine);
}
function toExistingClaimLine(r) {
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
    eobLineKey: r.eob_line_key ?? null
  };
}
async function listClaimLinesForDocument(documentId) {
  const { data, error } = await supabase.from("claims_records").select(`patient_id, ${EXISTING_LINE_COLUMNS}`).eq("cms1500_document_id", documentId);
  if (error) {
    console.error("[Supabase] listClaimLinesForDocument:", error);
    throw error;
  }
  return (data ?? []).map((r) => ({ ...toExistingClaimLine(r), patientId: r.patient_id }));
}
async function listPatientVisitPeriodDates(patientId) {
  const { data, error } = await supabase.from("visit_records").select("auth_period, date_of_service").eq("patient_id", patientId);
  if (error) {
    console.error("[Supabase] listPatientVisitPeriodDates:", error);
    throw error;
  }
  return (data ?? []).map((r) => ({ authPeriod: r.auth_period ?? 1, dateOfService: r.date_of_service ?? null }));
}
async function findClaimImportDocumentId(kind, sha256) {
  const { data, error } = await supabase.from("claim_import_documents").select("id").eq("document_kind", kind).eq("content_sha256", sha256).maybeSingle();
  if (error) {
    console.error("[Supabase] findClaimImportDocumentId:", error);
    throw error;
  }
  return data ? data.id : null;
}
function throwImportRpcError(fn, error) {
  const reason = error.code ? IMPORT_RPC_REASONS[error.code] : void 0;
  if (reason) throw new ClaimImportRuleError(reason, error.message ?? reason);
  console.error(`[Supabase] ${fn}:`, error);
  throw error;
}
function toWriteResult(data) {
  return { status: data.status, claimId: data.claim_id, authPeriod: data.auth_period, documentId: data.document_id };
}
async function commitCms1500Line(params) {
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
    p_import_batch_id: params.importBatchId
  });
  if (error) throwImportRpcError("commitCms1500Line", error);
  return toWriteResult(data);
}
async function applyEobLine(params) {
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
    p_import_batch_id: params.importBatchId
  });
  if (error) throwImportRpcError("applyEobLine", error);
  return toWriteResult(data);
}
async function listPatientExternalIds() {
  const { data, error } = await supabase.from("patient_external_ids").select("patient_id, source_system, external_id, birth_date");
  if (error) {
    console.error("[Supabase] listPatientExternalIds:", error);
    throw error;
  }
  return (data ?? []).map((r) => ({ patientId: r.patient_id, sourceSystem: r.source_system, externalId: r.external_id, birthDate: r.birth_date ?? null }));
}
async function linkPatientExternalId(params) {
  const { error } = await supabase.rpc("link_patient_external_id_with_audit", {
    p_patient_id: params.patientId,
    p_source_system: params.sourceSystem,
    p_external_id: params.externalId,
    p_birth_date: params.birthDate,
    p_actor_id: params.actor.actorId,
    p_actor_type: params.actor.actorType,
    p_actor_display: params.actor.actorDisplay,
    p_import_batch_id: params.importBatchId
  });
  if (error) throwImportRpcError("linkPatientExternalId", error);
}
async function commitImportWithNewPatient(params) {
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
    p_import_batch_id: params.importBatchId
  });
  if (error) throwImportRpcError("commitImportWithNewPatient", error);
  const r = data;
  if (r.status === "patient_exists") return { status: "patient_exists", patientId: r.patient_id };
  return {
    status: "created",
    patientId: r.patient_id,
    lines: (r.lines ?? []).map((l) => ({ lineKey: l.line_key, status: l.status, claimId: l.claim_id ?? null, authPeriod: l.auth_period ?? null }))
  };
}
async function commitPatientCsvGroup(params, actor) {
  const { data, error } = await supabase.rpc("import_patient_csv_group_with_audit", {
    p_patient_name: params.name,
    p_insurance: params.insurance,
    p_auth_date: params.authDate,
    // Only these keys are ever sent; the SQL function also builds each visit from an explicit list.
    p_visits: params.visits.map((v) => ({
      sessions_authorized: v.sessionsAuthorized,
      sessions_remaining: v.sessionsRemaining,
      session_number: v.sessionNumber,
      date_of_service: v.dateOfService,
      new_auth: v.newAuth,
      date_ash_submitted: v.dateAuthSubmitted
    })),
    p_file_name: params.fileName,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_import_batch_id: params.importBatchId
  });
  if (error) {
    console.error("[Supabase] commitPatientCsvGroup:", error);
    mapInsurerAssignmentError(error);
    throw error;
  }
  const r = data;
  return { status: r.status, patientId: r.patient_id, sessions: r.sessions ?? 0 };
}
async function holdEobLine(params) {
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
    p_import_batch_id: params.importBatchId
  });
  if (error) throwImportRpcError("holdEobLine", error);
  const r = data;
  return { status: r.status, pendingId: r.pending_id };
}
async function listHeldEobLineKeys(documentId) {
  const { data, error } = await supabase.from("pending_eob_lines").select("line_key").eq("document_id", documentId).eq("status", "pending");
  if (error) {
    console.error("[Supabase] listHeldEobLineKeys:", error);
    throw error;
  }
  return (data ?? []).map((r) => r.line_key);
}
async function listPendingEobLines() {
  const { data, error } = await supabase.from("pending_eob_lines").select("id, patient_id, document_id, line_key, date_of_service, cpt_codes, modifier, units_billed, data, target, created_at, patients(name), claim_import_documents(file_name)").eq("status", "pending").order("created_at", { ascending: true }).limit(PENDING_EOB_LIST_LIMIT);
  if (error) {
    console.error("[Supabase] listPendingEobLines:", error);
    throw error;
  }
  return (data ?? []).map((r) => ({
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
    createdAt: r.created_at
  }));
}
async function applyPendingEobLine(params) {
  const { data, error } = await supabase.rpc("apply_pending_eob_line_with_audit", {
    p_pending_id: params.pendingId,
    p_target_claim_id: params.targetClaimId,
    p_confirm_replace: params.confirmReplace,
    p_actor_id: params.actor.actorId,
    p_actor_type: params.actor.actorType,
    p_actor_display: params.actor.actorDisplay,
    p_import_batch_id: params.importBatchId
  });
  if (error) throwImportRpcError("applyPendingEobLine", error);
  return toWriteResult(data);
}
async function dismissPendingEobLine(pendingId, actor) {
  const { error } = await supabase.rpc("dismiss_pending_eob_line_with_audit", {
    p_pending_id: pendingId,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay
  });
  if (error) throwImportRpcError("dismissPendingEobLine", error);
}
async function listDismissedEobLines(patientId) {
  const { data, error } = await supabase.from("pending_eob_lines").select("id, document_id, line_key, date_of_service, cpt_codes, modifier, units_billed, data").eq("patient_id", patientId).eq("status", "dismissed");
  if (error) {
    console.error("[Supabase] listDismissedEobLines:", error);
    throw error;
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    documentId: r.document_id,
    lineKey: r.line_key,
    dateOfService: r.date_of_service,
    cptCodes: r.cpt_codes,
    modifier: r.modifier,
    unitsBilled: r.units_billed,
    data: r.data ?? {}
  }));
}
async function reopenDismissedEobLine(pendingId, actor, importBatchId) {
  const { error } = await supabase.rpc("reopen_dismissed_eob_line_with_audit", {
    p_pending_id: pendingId,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_import_batch_id: importBatchId
  });
  if (error) throwImportRpcError("reopenDismissedEobLine", error);
}
async function listPatientClaimPeriods(patientId) {
  const { data, error } = await supabase.from("claims_records").select("auth_period").eq("patient_id", patientId);
  if (error) {
    console.error("[Supabase] listPatientClaimPeriods:", error);
    throw error;
  }
  return Array.from(new Set((data ?? []).map((r) => r.auth_period))).sort((a, b) => a - b);
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
  const { data: id, error } = await supabase.rpc("write_insurer_catalog_with_audit", {
    p_id: null,
    p_data: { name: params.name },
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: "INSURER_CREATE"
  });
  if (error) {
    console.error("[Supabase] createInsurerCatalogEntry:", error);
    throw error;
  }
  const created = await getInsurerCatalogEntryById(id);
  if (!created) {
    throw new Error(`createInsurerCatalogEntry: row ${id} not found after insert`);
  }
  return created;
}
async function getInsurerCatalogEntryById(id) {
  const { data, error } = await supabase.from("insurer_catalog").select("*").eq("id", id).maybeSingle();
  if (error) {
    console.error("[Supabase] getInsurerCatalogEntryById:", error);
    return void 0;
  }
  return data ? toInsurerCatalogEntry(data) : void 0;
}
async function deactivateInsurerCatalogEntry(id, actor) {
  const { error } = await supabase.rpc("write_insurer_catalog_with_audit", {
    p_id: id,
    p_data: { is_active: false, deactivated_at: (/* @__PURE__ */ new Date()).toISOString(), deactivated_by: actor.actorId },
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: "INSURER_DEACTIVATE"
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
async function reactivateInsurerCatalogEntry(id, actor) {
  const { error } = await supabase.rpc("write_insurer_catalog_with_audit", {
    p_id: id,
    p_data: { is_active: true, reactivated_at: (/* @__PURE__ */ new Date()).toISOString(), reactivated_by: actor.actorId },
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay,
    p_action: "INSURER_REACTIVATE"
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
function mapInsurerAssignmentError(error) {
  if (error.code === "P0041") throw new InsurerDeletedError();
}
async function permanentlyDeleteInsurerCatalogEntry(id, actor) {
  const { data: deletedId, error } = await supabase.rpc("delete_insurer_catalog_with_audit", {
    p_id: id,
    p_actor_id: actor.actorId,
    p_actor_type: actor.actorType,
    p_actor_display: actor.actorDisplay
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
var LastActiveAccountManagerError, ClinicUserConflictError, FOLLOW_UP_STALE_DAYS, FOLLOW_UP_URGENCY_RANK, FOLLOW_UP_REASONS, CLAIM_STATUS_KEYS, dateOnly, ClaimRecordNotFoundError, ClaimRecordPatientMismatchError, EXISTING_LINE_COLUMNS, numOrNull, IMPORT_RPC_REASONS, ClaimImportRuleError, PENDING_EOB_LIST_LIMIT, InsurerCatalogEntryNotFoundError, InsurerDeletedError, InsurerCatalogHasForeignKeysError;
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
    EXISTING_LINE_COLUMNS = [
      "id",
      "auth_period",
      "date_of_service",
      "cpt_codes",
      "modifier",
      "units_billed",
      "diagnosis_codes",
      "charge_amount",
      "insurance_reimbursement",
      "patient_amount_due",
      "patient_amount_paid",
      "claim_status",
      "cms1500_document_id",
      "cms1500_line_key",
      "eob_document_id",
      "eob_line_key"
    ].join(", ");
    numOrNull = (v) => v === null || v === void 0 ? null : Number(v);
    IMPORT_RPC_REASONS = {
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
      P0033: "line_dismissed"
    };
    ClaimImportRuleError = class extends Error {
      constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = "ClaimImportRuleError";
      }
    };
    PENDING_EOB_LIST_LIMIT = 500;
    InsurerCatalogEntryNotFoundError = class extends Error {
      constructor(id) {
        super(`Insurance company ${id} not found`);
        this.name = "InsurerCatalogEntryNotFoundError";
      }
    };
    InsurerDeletedError = class extends Error {
      constructor() {
        super("This insurance company was permanently deleted. Choose a different insurance company.");
        this.name = "InsurerDeletedError";
      }
    };
    InsurerCatalogHasForeignKeysError = class extends Error {
      constructor() {
        super("Insurance companies can't be permanently deleted until a database foreign key on the catalog is reviewed.");
        this.name = "InsurerCatalogHasForeignKeysError";
      }
    };
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
var CLAIMS_ACCESS_DENIED_ERR_MSG = "Claims access is restricted to administrators (10004)";

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
function getQueryParam(req, key2) {
  const value = req.query[key2];
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

// shared/claimsAccess.ts
function hasClaimsAccess(principal) {
  if (!principal) return false;
  if (principal.kind === "clinic") return principal.role === "admin" && principal.mustChangePassword !== true;
  return principal.role === "admin";
}

// server/_core/claimsAccess.ts
function canAccessClaims(user) {
  if (!user) return false;
  if (user.clinicUser) {
    return hasClaimsAccess({ kind: "clinic", role: user.clinicUser.role, mustChangePassword: user.clinicUser.mustChangePassword });
  }
  return hasClaimsAccess({ kind: "owner", role: user.role });
}

// server/_core/requireAuth.ts
async function requireAuthenticatedUser(req, res, next) {
  try {
    await sdk.authenticateRequest(req);
    next();
  } catch {
    res.status(401).json({ error: "Authentication required" });
  }
}
async function requireClaimsAccess(req, res, next) {
  let user;
  try {
    user = await sdk.authenticateRequest(req);
  } catch {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (!canAccessClaims(user) || user.clinicUser?.mustChangePassword) {
    res.status(403).json({ error: CLAIMS_ACCESS_DENIED_ERR_MSG });
    return;
  }
  next();
}

// server/_core/storageProxy.ts
function registerStorageProxy(app2) {
  app2.get("/manus-storage/*", requireAuthenticatedUser, async (req, res) => {
    const key2 = req.params[0];
    if (!key2) {
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
      forgeUrl.searchParams.set("path", key2);
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
import Papa2 from "papaparse";
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
    const errorText2 = await response.text();
    throw new Error(`LLM invoke failed: ${response.status} ${response.statusText} \u2013 ${errorText2}`);
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
    const inline = part.image_url.url.match(/^data:(image\/[a-z+.-]+);base64,/i);
    if (inline) {
      return { type: "image", source: { type: "base64", media_type: inline[1].toLowerCase(), data: dataUriToBase64(part.image_url.url) } };
    }
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
    const errorText2 = await response.text();
    throw new Error(`LLM invoke failed: ${response.status} ${response.statusText} \u2013 ${errorText2}`);
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
    const errorText2 = await response.text();
    throw new Error(`LLM invoke failed: ${response.status} ${response.statusText} \u2013 ${errorText2}`);
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
  const clean2 = raw.trim();
  const m1 = clean2.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m1) return `${m1[3]}-${m1[1].padStart(2, "0")}-${m1[2].padStart(2, "0")}`;
  const m2 = clean2.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m2) {
    const year = parseInt(m2[3], 10);
    const fullYear = year > 50 ? 1900 + year : 2e3 + year;
    return `${fullYear}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`;
  }
  const m3 = clean2.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m3) return clean2;
  return null;
}
function parseMoney(raw) {
  if (!raw) return null;
  const clean2 = raw.replace(/[$,\s]/g, "").trim();
  const n = parseFloat(clean2);
  return isNaN(n) ? null : n;
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
  while ((cm2 = compactPattern.exec(serviceArea)) !== null) {
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
    const visitNumber = null;
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
    for (let i = 0; i < lines2.length; i++) {
      const cptMatch = lines2[i].match(cptLineRe);
      if (!cptMatch) continue;
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
      const visitNumber = null;
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
- diagnosisCodes: ONLY the ICD-10 code(s) this line's own Box 24E diagnosis pointer references (e.g. pointer "AC" \u2192 Box 21 entries A and C), comma-separated in pointer order. Never list every Box 21 code on every line. Null if the pointer is not readable.
- unitsBilled: units/days billed (from Box 24G \u2014 labeled "DAYS OR UNITS")
- modifier: modifier codes if present (from Box 24D, immediately after the CPT code)
- chargeAmount: total charge amount for this line (numeric only, from Box 24F)
- claimSubmittedDate: MM/DD/YYYY format \u2014 the physician/supplier signature date (from Box 31, usually printed after "SIGNED"/"DATE")
- insuranceBilled: the NUMERIC billing/group/payer identifier printed near Box 11 \u2014 e.g. "Group #", "Group Number", "Group No", "Group ID", "Billing ID", "Billing Number", "Payer ID", "Payer Number", or a slash-separated identifier like "16404/137040261". This is NEVER the insurance plan/payer name (do not write "Aetna", "Blue Cross", etc. here). If no such numeric identifier is visible on the form, use null.
- visitNumber: Always null. A CMS-1500 form has no visit-number box, and a Box 24 row position is not a visit number.

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
      description: "Always null \u2014 a CMS-1500 has no visit-number box and a row position is not a visit number."
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
      if (uploadType === "cms1500") claim.visitNumber = null;
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
      const key2 = claim.dateOfService;
      if (!byDate.has(key2)) byDate.set(key2, []);
      byDate.get(key2).push(claim);
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

// server/claimImportKeys.ts
import { createHash } from "node:crypto";

// shared/claimImport.ts
var CLAIM_IMPORT_KEY_RE = /^[A-Za-z0-9:_.,-]{1,160}$/;
var CLAIM_IMPORT_STATUSES = ["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "needs_review"];
var SHA256_RE = /^[0-9a-f]{64}$/;
var CLAIM_UPLOAD_MAX_BYTES = 44e5;
var CLAIM_UPLOAD_MAX_LABEL = "4.4 MB";
var CMS1500_BOX26_SOURCE_SYSTEM = "cms1500_box26";
var BIRTH_EVIDENCE_SOURCE_SYSTEM = "import_birth_evidence";
function resolveAuthPeriod(visits, dateOfService) {
  const periods = Array.from(new Set(visits.map((v) => v.authPeriod))).sort((a, b) => a - b);
  const options = periods.length > 0 ? periods : [1];
  if (!dateOfService) return { status: "uncertain", options };
  const exact = Array.from(new Set(visits.filter((v) => v.dateOfService === dateOfService).map((v) => v.authPeriod)));
  if (exact.length === 1) return { status: "resolved", authPeriod: exact[0], basis: "visit_date" };
  if (exact.length > 1) return { status: "uncertain", options: exact.sort((a, b) => a - b) };
  const inRange = periods.filter((p) => {
    const dates = visits.filter((v) => v.authPeriod === p && v.dateOfService).map((v) => v.dateOfService).sort();
    return dates.length > 0 && dates[0] <= dateOfService && dateOfService <= dates[dates.length - 1];
  });
  if (inRange.length === 1) return { status: "resolved", authPeriod: inRange[0], basis: "period_range" };
  if (inRange.length > 1) return { status: "uncertain", options: inRange };
  const anyDated = visits.some((v) => v.dateOfService);
  if (periods.length === 1 && !anyDated) return { status: "resolved", authPeriod: periods[0], basis: "single_period" };
  return { status: "uncertain", options };
}
function resolveAuthPeriodWithFilePeriod(visits, dateOfService, filePeriod) {
  const base = resolveAuthPeriod(visits, dateOfService);
  const known = Array.from(new Set(visits.map((v) => v.authPeriod))).sort((a, b) => a - b);
  const allowed = known.length > 0 ? known : [1];
  if (!allowed.includes(filePeriod)) {
    return {
      status: "uncertain",
      options: base.status === "uncertain" ? base.options : allowed,
      note: `The file says period ${filePeriod}, which is not one of this patient's authorization periods (${allowed.join(", ")}). Choose the period.`
    };
  }
  if (base.status === "resolved") {
    if (base.authPeriod === filePeriod) return base;
    return {
      status: "uncertain",
      options: [base.authPeriod, filePeriod].sort((a, b) => a - b),
      note: `The file says period ${filePeriod}, but the visit dates place this date of service in period ${base.authPeriod}. Choose the period.`
    };
  }
  if (base.options.includes(filePeriod)) return { status: "resolved", authPeriod: filePeriod, basis: "file" };
  return {
    status: "uncertain",
    options: Array.from(/* @__PURE__ */ new Set([...base.options, filePeriod])).sort((a, b) => a - b),
    note: `The file says period ${filePeriod}, but the visit dates point to period ${base.options.join(" or ")}. Choose the period.`
  };
}
function normalizeModifierSet(modifier) {
  if (!modifier) return "";
  return Array.from(new Set(modifier.toUpperCase().split(/[\s,;/|]+/).filter(Boolean))).sort().join(",");
}
function formatModifiers(modifiers) {
  const list = [];
  for (const m of modifiers) {
    const v = (m ?? "").trim().toUpperCase();
    if (v && !list.includes(v)) list.push(v);
  }
  return list.length > 0 ? list.join(", ") : null;
}
function sameDateCpt(row, dos, cpt) {
  return row.dateOfService === dos && (row.cptCodes ?? "").trim() === cpt;
}
function classifyCms1500Line(params) {
  const { line, documentId, siblingLineKeys, existing, period } = params;
  const dos = line.dateOfService;
  const cpt = (line.cptCodes ?? "").trim();
  if (!dos || !cpt || line.unreadable.includes("dateOfService") || line.unreadable.includes("cptCodes")) {
    return { status: "invalid", candidates: [], associableIds: [], period, reason: "Date of service and CPT must both be readable." };
  }
  const saved = documentId ? existing.find((r) => r.cms1500DocumentId === documentId && r.cms1500LineKey === line.sourceLineKey) : void 0;
  if (saved) return { status: "already_saved", existingClaimId: saved.id, candidates: [], associableIds: [], period };
  const siblings = new Set(siblingLineKeys);
  const conflicting = existing.filter(
    (r) => sameDateCpt(r, dos, cpt) && !(documentId && r.cms1500DocumentId === documentId && r.cms1500LineKey && siblings.has(r.cms1500LineKey))
  );
  if (conflicting.length > 0) {
    return {
      status: "needs_selection",
      candidates: conflicting,
      associableIds: conflicting.filter((r) => !r.cms1500DocumentId).map((r) => r.id),
      period,
      reason: conflicting.some((r) => !r.cms1500DocumentId) ? "An existing claim line (saved before CMS1500 tracking, or entered manually) is on this date and CPT. Associate this CMS1500 line with it, or save it as a separate line." : "Another CMS1500 line is already saved on this date and CPT. Save this one only if it is a separate service line."
    };
  }
  if (period.status === "uncertain") {
    return { status: "period_required", candidates: [], associableIds: [], period, reason: period.note ?? "Choose the authorization period for this date of service." };
  }
  return { status: "ready_new", candidates: [], associableIds: [], period };
}
var NOTHING_CHANGES = "Re-importing never changes a saved line. Correct the saved line directly, or skip this one.";
function exportLineIdentityProblem(params) {
  const { line, patientId, siblingLineKeys, savedInDocument } = params;
  if (savedInDocument.some((r) => r.patientId !== patientId)) {
    return `This invoice was already saved for a different patient. ${NOTHING_CHANGES}`;
  }
  const saved = savedInDocument.find((r) => r.cms1500LineKey === line.sourceLineKey);
  if (!saved) return null;
  const differs = (label, incoming, have) => incoming != null && String(incoming).trim() !== String(have ?? "").trim() ? `${label}: the file says ${incoming}, the saved line has ${have ?? "nothing"}` : null;
  const diffs = [
    differs("date of service", line.dateOfService, saved.dateOfService),
    differs("CPT", line.cptCodes, saved.cptCodes),
    normalizeModifierSet(line.modifier) && normalizeModifierSet(line.modifier) !== normalizeModifierSet(saved.modifier) ? differs("modifiers", line.modifier, saved.modifier) : null,
    differs("units", line.unitsBilled, saved.unitsBilled),
    differs("diagnosis codes", line.diagnosisCodes, saved.diagnosisCodes)
  ].filter(Boolean);
  if (diffs.length > 0) return `This may not be the saved line (${diffs.join("; ")}). ${NOTHING_CHANGES}`;
  const stem = line.sourceLineKey.replace(/\.\d+$/, ".");
  const savedRepeats = savedInDocument.filter((r) => r.cms1500LineKey?.startsWith(stem)).length;
  const fileRepeats = new Set(siblingLineKeys.filter((k) => k.startsWith(stem))).size;
  if (savedRepeats > fileRepeats) {
    return `${savedRepeats} identical lines are saved from this invoice, but this file lists ${fileRepeats}, so it cannot tell which one this is. ${NOTHING_CHANGES}`;
  }
  return null;
}
function classifyExportLine(params) {
  const { classification: c, line, siblingLineKeys, savedInDocument } = params;
  const problem = exportLineIdentityProblem(params);
  if (problem) return { ...c, status: "identity_review", candidates: [], associableIds: [], reason: problem };
  if (c.status === "ready_new" || c.status === "period_required") {
    const orphans = changedSavedLines(line, siblingLineKeys, savedInDocument);
    if (orphans.length > 0) {
      return { ...c, status: "needs_selection", candidates: orphans, associableIds: [], reason: "A saved line of this invoice with this CPT is no longer in the file, so this may be that line changed. Save this one only if it is a separate service line." };
    }
  }
  return c;
}
function changedSavedLines(line, siblingLineKeys, savedInDocument) {
  if (savedInDocument.some((r) => r.cms1500LineKey === line.sourceLineKey)) return [];
  const inFile = new Set(siblingLineKeys);
  const cpt = (line.cptCodes ?? "").trim();
  return savedInDocument.filter((r) => (r.cptCodes ?? "").trim() === cpt && !(r.cms1500LineKey && inFile.has(r.cms1500LineKey)));
}
var UPLOAD_CMS1500_FIRST = "Upload the matching CMS1500 first.";
var MONEY_KEYS = ["chargeAmount", "insuranceReimbursement", "patientAmountDue", "patientAmountPaid"];
function conflictingMoneyFields(row, line) {
  return MONEY_KEYS.filter((k) => {
    const have = row[k];
    const incoming = line[k];
    return have != null && incoming != null && Math.abs(Number(have) - Number(incoming)) > 4e-3;
  });
}
function classifyEobLine(params) {
  const { line, documentId, existing } = params;
  const dos = line.dateOfService;
  const cpt = (line.cptCodes ?? "").trim();
  if (!dos || !cpt) return { status: "invalid", candidates: [], reason: "Date of service and CPT must both be readable." };
  const saved = documentId ? existing.find((r) => r.eobDocumentId === documentId && r.eobLineKey === line.sourceLineKey) : void 0;
  if (saved) return { status: "already_saved", targetClaimId: saved.id, candidates: [] };
  const sameKey = existing.filter((r) => sameDateCpt(r, dos, cpt));
  const cmsBacked = sameKey.filter((r) => r.cms1500DocumentId);
  if (cmsBacked.length === 0) {
    return {
      status: "cms1500_required",
      candidates: [],
      reason: sameKey.length > 0 ? `${UPLOAD_CMS1500_FIRST} A claim line exists on this date and CPT but has no CMS1500 yet \u2014 upload its CMS1500 and associate it before applying this payment.` : UPLOAD_CMS1500_FIRST
    };
  }
  const lineMods = normalizeModifierSet(line.modifier);
  const narrowed = cmsBacked.filter((r) => {
    const rowMods = normalizeModifierSet(r.modifier);
    if (lineMods && rowMods && lineMods !== rowMods) return false;
    if (line.unitsBilled != null && r.unitsBilled != null && Number(line.unitsBilled) !== Number(r.unitsBilled)) return false;
    return true;
  });
  const pool = narrowed.length > 0 ? narrowed : cmsBacked;
  if (pool.length > 1) {
    return {
      status: "needs_selection",
      candidates: pool,
      reason: narrowed.length > 0 ? "More than one CMS1500 line matches this date and CPT. Choose the line this payment belongs to." : "Modifiers or units differ from every CMS1500 line on this date and CPT. Choose the line this payment belongs to."
    };
  }
  const target = pool[0];
  if (narrowed.length === 0) {
    return { status: "needs_selection", targetClaimId: target.id, candidates: pool, reason: "Modifiers or units differ from the CMS1500 line on this date and CPT. Confirm this is the right line." };
  }
  if (target.eobDocumentId) {
    return { status: "needs_confirmation", targetClaimId: target.id, candidates: [target], reason: "This line already has a payment from another EOB line. Applying replaces it." };
  }
  const conflicts = conflictingMoneyFields(target, line);
  if (conflicts.length > 0) {
    return { status: "needs_confirmation", targetClaimId: target.id, candidates: [target], reason: `This line already has different amounts (${conflicts.join(", ")}). Applying replaces them.` };
  }
  return { status: "matched", targetClaimId: target.id, candidates: [target] };
}
function classifyEobLineForTarget(params) {
  const { line, documentId, existing, target } = params;
  const dos = line.dateOfService;
  const cpt = (line.cptCodes ?? "").trim();
  if (!dos || !cpt) return { status: "invalid", candidates: [], reason: "Date of service and CPT must both be readable." };
  const saved = documentId ? existing.find((r) => r.eobDocumentId === documentId && r.eobLineKey === line.sourceLineKey) : void 0;
  if (saved) return { status: "already_saved", targetClaimId: saved.id, candidates: [] };
  const period = target.authPeriod ?? null;
  let pool = period != null ? existing.filter((r) => r.authPeriod === period) : existing;
  const ref = target.cms1500Ref;
  if (ref) {
    const row = ref.documentId ? existing.find((r) => r.cms1500DocumentId === ref.documentId && r.cms1500LineKey === ref.lineKey) : void 0;
    if (!row) {
      return { status: "cms1500_required", candidates: [], reason: `${UPLOAD_CMS1500_FIRST} CMS1500 line ${ref.label} is not saved for this patient on this date of service.` };
    }
    if ((row.cptCodes ?? "").trim() !== cpt) {
      return { status: "invalid", candidates: [], reason: `CMS1500 line ${ref.label} is CPT ${row.cptCodes ?? "\u2014"}, not ${cpt}. Fix the CMS1500 reference in the file.` };
    }
    if (period != null && row.authPeriod !== period) {
      return { status: "invalid", candidates: [], reason: `CMS1500 line ${ref.label} is in period ${row.authPeriod}, not period ${period}. Fix auth_period in the file.` };
    }
    pool = [row];
  }
  const result = classifyEobLine({ line, documentId, existing: pool });
  if (result.status === "cms1500_required" && period != null && pool.length !== existing.length) {
    return { ...result, reason: `${result.reason} (No CMS1500 line on this date and CPT in period ${period}.)` };
  }
  return result;
}
var EOB_LINE_DISMISSED = "A reviewer dismissed this line earlier. It stays dismissed unless you reopen it.";
var sameMoney = (a, b) => (a === null || a === void 0 ? null : Number(a)) === null ? b === null : b !== null && Math.abs(Number(a) - b) <= 4e-3;
function findDismissedEobLine(line, documentId, dismissed) {
  const sameLine = documentId ? dismissed.find((d) => d.documentId === documentId && d.lineKey === line.sourceLineKey) : void 0;
  if (sameLine) return sameLine;
  return dismissed.find(
    (d) => d.dateOfService === line.dateOfService && d.cptCodes === (line.cptCodes ?? "").trim() && normalizeModifierSet(d.modifier) === normalizeModifierSet(line.modifier) && (d.unitsBilled ?? null) === (line.unitsBilled ?? null) && sameMoney(d.data.charge_amount, line.chargeAmount) && sameMoney(d.data.insurance_reimbursement, line.insuranceReimbursement) && sameMoney(d.data.patient_amount_due, line.patientAmountDue) && sameMoney(d.data.patient_amount_paid, line.patientAmountPaid)
  ) ?? null;
}
function allowedEobTargets(c) {
  if (c.status === "invalid" || c.status === "cms1500_required") return [];
  return Array.from(/* @__PURE__ */ new Set([...c.targetClaimId ? [c.targetClaimId] : [], ...c.candidates.map((x) => x.id)]));
}

// server/claimImportKeys.ts
function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
function sanitizeKeyPart(value) {
  if (value === null || value === void 0 || value === "") return "x";
  return String(value).replace(/[^A-Za-z0-9.,-]/g, "").slice(0, 24) || "x";
}
function groupKeyFor(identity) {
  return "g" + createHash("sha256").update(identity.trim().toUpperCase()).digest("hex").slice(0, 12);
}
function finalizeKey(groupKey2, lineId) {
  const key2 = `${groupKey2}:${lineId}`.slice(0, 160);
  if (!CLAIM_IMPORT_KEY_RE.test(key2)) throw new Error(`Generated source line key is invalid: ${key2}`);
  return key2;
}
function assignCms1500LineKeys(groupKey2, lines) {
  const positional = lines.every((l) => l.page != null && l.slot != null) && new Set(lines.map((l) => `${l.page}:${l.slot}`)).size === lines.length;
  const seen = /* @__PURE__ */ new Map();
  for (const line of lines) {
    let id;
    if (positional) {
      id = `p${line.page}r${line.slot}`;
    } else {
      const content = [line.dateOfService, line.cptCodes, normalizeModifierSet(line.modifier), line.unitsBilled].map(sanitizeKeyPart).join("_");
      const n = seen.get(content) ?? 0;
      seen.set(content, n + 1);
      id = `${content}_${n}`;
    }
    line.sourceLineKey = finalizeKey(groupKey2, id);
  }
  return lines;
}
function assignEobLineKeys(groupKey2, lines) {
  const seen = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const content = [
      line.dateOfService,
      line.cptCodes,
      normalizeModifierSet(line.modifier),
      line.unitsBilled,
      line.chargeAmount,
      line.insuranceReimbursement
    ].map(sanitizeKeyPart).join("_");
    const n = seen.get(content) ?? 0;
    seen.set(content, n + 1);
    line.sourceLineKey = finalizeKey(groupKey2, `${content}_${n}`);
  }
  return lines;
}
function num(v) {
  if (v === null || v === void 0 || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function str(v) {
  if (v === null || v === void 0) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function toIsoDate(v) {
  const s = str(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}
function groupIdentities(kind, groups) {
  const names = groups.map((g) => (g.patientName ?? "unknown").trim().toUpperCase());
  return names.map((n, i) => names.indexOf(n) === names.lastIndexOf(n) ? `${kind}:${n}` : `${kind}:${n}:${i}`);
}
function flattenLines(claim) {
  const lines = Array.isArray(claim.cptLines) && claim.cptLines.length > 0 ? claim.cptLines : [claim];
  return lines.map((l) => ({ ...claim, ...l, cptLines: void 0 }));
}
function cms1500GroupsFromClaims(groups) {
  const identities = groupIdentities("cms1500", groups);
  return groups.map((g, gi) => {
    const groupKey2 = groupKeyFor(identities[gi]);
    const lines = g.claims.flatMap(flattenLines).map((l) => {
      const rawUnits = num(l.unitsBilled);
      const unitsBilled = rawUnits != null && Number.isInteger(rawUnits) && rawUnits >= 1 && rawUnits <= 999 ? rawUnits : null;
      return {
        page: null,
        slot: null,
        dateOfService: toIsoDate(l.dateOfService),
        placeOfService: str(l.placeOfService),
        cptCodes: str(l.cptCodes),
        modifier: str(l.modifier),
        unitsBilled,
        diagnosisPointer: str(l.diagnosisPointer),
        diagnosisCodes: str(l.diagnosisCodes),
        claimSubmittedDate: toIsoDate(l.claimSubmittedDate),
        insuranceBilled: str(l.insuranceBilled),
        lineChargeForValidation: num(l.chargeAmount),
        unreadable: rawUnits != null && unitsBilled == null ? ["unitsBilled"] : [],
        notes: str(l.notes)
      };
    });
    return {
      groupKey: groupKey2,
      patientName: str(g.patientName) && g.patientName !== "UNKNOWN" ? str(g.patientName) : null,
      pages: null,
      claimIdentifier: null,
      lines: assignCms1500LineKeys(groupKey2, lines),
      warnings: [],
      unresolvedClaimTotals: []
    };
  });
}
function eobGroupsFromClaims(groups) {
  const identities = groupIdentities("eob", groups);
  return groups.map((g, gi) => {
    const groupKey2 = groupKeyFor(identities[gi]);
    const unresolvedClaimTotals = [];
    for (const c of g.claims) {
      if (c.unresolvedClaimTotal) {
        unresolvedClaimTotals.push({
          dateOfService: toIsoDate(c.dateOfService),
          cptCodes: str(c.cptCodes),
          planPaid: Number(c.unresolvedClaimTotal.planPaid),
          patientResponsibility: num(c.unresolvedClaimTotal.patientResponsibility),
          cptCount: Number(c.unresolvedClaimTotal.cptCount)
        });
      }
    }
    const lines = g.claims.flatMap(flattenLines).map((l) => ({
      page: null,
      dateOfService: toIsoDate(l.dateOfService),
      cptCodes: str(l.cptCodes),
      modifier: formatModifiers(String(l.modifier ?? "").split(/[\s,]+/)),
      unitsBilled: num(l.unitsBilled),
      chargeAmount: num(l.chargeAmount),
      insuranceReimbursement: num(l.insuranceReimbursement),
      patientAmountDue: num(l.patientAmountDue),
      patientAmountPaid: num(l.patientAmountPaid),
      claimStatus: str(l.claimStatus),
      oaClaimNumber: str(l.oaClaimNumber),
      checkDate: toIsoDate(l.checkDate),
      checkNumberVirtualCard: str(l.checkNumberVirtualCard),
      notes: str(l.notes)
    }));
    return {
      groupKey: groupKey2,
      patientName: str(g.patientName),
      pages: null,
      claimIdentifier: null,
      lines: assignEobLineKeys(groupKey2, lines),
      warnings: unresolvedClaimTotals.length > 0 ? [`${unresolvedClaimTotals.length} claim block(s) report one combined plan payment for several lines. Those amounts are not saved to any line \u2014 review them manually.`] : [],
      unresolvedClaimTotals
    };
  });
}

// server/cms1500Vision.ts
import { createRequire } from "node:module";
import path from "node:path";

// server/pdfjs.ts
var PdfReaderUnavailableError = class extends Error {
  constructor(stage, cause) {
    super(`PDF reader unavailable (${stage}): ${errorText(cause)}`);
    this.name = "PdfReaderUnavailableError";
  }
};
var loading = null;
function loadPdfjs() {
  if (!loading) {
    loading = load();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
async function load() {
  const g = globalThis;
  if (!g.DOMMatrix || !g.ImageData || !g.Path2D) {
    let canvas;
    try {
      canvas = await import("@napi-rs/canvas");
    } catch (err) {
      throw new PdfReaderUnavailableError("canvas", err);
    }
    g.DOMMatrix ??= canvas.DOMMatrix;
    g.ImageData ??= canvas.ImageData;
    g.Path2D ??= canvas.Path2D;
  }
  if (!g.pdfjsWorker) {
    try {
      g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    } catch (err) {
      throw new PdfReaderUnavailableError("worker", err);
    }
  }
  try {
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (err) {
    throw new PdfReaderUnavailableError("library", err);
  }
}
async function openPdf(buffer) {
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch (err) {
    return { ok: false, failure: { kind: "reader_unavailable", detail: errorText(err) } };
  }
  try {
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
    const pageCount = (await task.promise).numPages;
    await task.destroy().catch(() => {
    });
    return { ok: true, pageCount };
  } catch (err) {
    return { ok: false, failure: classifyPdfError(err) };
  }
}
function classifyPdfError(err) {
  const detail = errorText(err);
  const name = err instanceof Error ? err.name : "";
  if (err instanceof PdfReaderUnavailableError || /fake worker|Cannot find module|is not defined|ERR_MODULE_NOT_FOUND/i.test(detail)) {
    return { kind: "reader_unavailable", detail };
  }
  if (name === "PasswordException") return { kind: "password", detail };
  if (name === "InvalidPDFException" || name === "FormatError" || /Invalid PDF structure|No password given|PDF header/i.test(detail)) {
    return { kind: "invalid", detail };
  }
  return { kind: "unreadable", detail };
}
function pdfOpenFailureResponse(failure) {
  switch (failure.kind) {
    case "reader_unavailable":
      return { status: 503, error: "The server's PDF reader did not start, so this file was not read. This is a server problem, not a problem with the file. Nothing was saved. Try again later." };
    case "password":
      return { status: 422, error: "This PDF is password-protected. Remove the password, then upload it again. Nothing was saved." };
    case "invalid":
      return { status: 422, error: "This file is damaged or is not a PDF, so it could not be opened. Re-save or re-scan it and try again. Nothing was saved." };
    default:
      return { status: 422, error: `This PDF could not be read (${failure.detail.slice(0, 120)}). Nothing was saved.` };
  }
}
function errorText(err) {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw.replace(/(?:[A-Za-z]:)?[\\/][^\s"'`]*[\\/][^\s"'`]*/g, "<path>").replace(/\s+/g, " ").slice(0, 300);
}

// server/cms1500Vision.ts
init_env();

// shared/nameMatch.ts
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
var NAME_SUFFIXES = /* @__PURE__ */ new Set([
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

// server/cms1500Vision.ts
var nullableString = { type: ["string", "null"] };
var nullableNumber = { type: ["number", "null"] };
var PAGE_SCHEMA = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pageNumber: { type: "integer" },
          continuationLabel: nullableString,
          patientName: nullableString,
          patientDob: nullableString,
          insuredId: nullableString,
          patientAccountNumber: nullableString,
          claimNumber: nullableString,
          billingNpi: nullableString,
          insuredGroupNumber: nullableString,
          signatureDate: nullableString,
          totalCharge: nullableNumber,
          diagnoses: {
            type: "array",
            items: {
              type: "object",
              properties: { letter: { type: "string" }, code: nullableString },
              required: ["letter", "code"],
              additionalProperties: false
            }
          },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                row: { type: ["integer", "null"] },
                dateFrom: nullableString,
                dateTo: nullableString,
                placeOfService: nullableString,
                cpt: nullableString,
                modifiers: { type: "array", items: { type: "string" } },
                diagnosisPointer: nullableString,
                charge: nullableNumber,
                units: nullableNumber,
                unreadableFields: { type: "array", items: { type: "string" } }
              },
              required: ["row", "dateFrom", "dateTo", "placeOfService", "cpt", "modifiers", "diagnosisPointer", "charge", "units", "unreadableFields"],
              additionalProperties: false
            }
          }
        },
        required: [
          "pageNumber",
          "continuationLabel",
          "patientName",
          "patientDob",
          "insuredId",
          "patientAccountNumber",
          "claimNumber",
          "billingNpi",
          "insuredGroupNumber",
          "signatureDate",
          "totalCharge",
          "diagnoses",
          "lines"
        ],
        additionalProperties: false
      }
    }
  },
  required: ["pages"],
  additionalProperties: false
};
var SYSTEM_PROMPT = `You transcribe scanned CMS-1500 (NUCC 02/12) health insurance claim forms. The document may be a black-and-white scan with no text layer, may contain several pages, and may contain several different patients' claims. Transcribe exactly what is printed \u2014 you do not interpret, total, or fill in anything.

Return exactly one entry in "pages" for EVERY page of the PDF, in order, with pageNumber 1, 2, 3, ... \u2014 including pages with no service lines.

For each page:
- continuationLabel: any page footer/header such as "continued - page 2 of 3", verbatim; null if none.
- patientName (Box 2), patientDob (Box 3), insuredId (Box 1a), patientAccountNumber (Box 26), claimNumber (any claim/CIC number printed at the very top of the form), billingNpi (Box 33a), insuredGroupNumber (Box 11), signatureDate (Box 31): verbatim as printed on THIS page; null if blank or unreadable. Never copy a value from another page.
- totalCharge: Box 28 on THIS page as a number; null when Box 28 is blank on this page (continued claims often print it only on the last page).
- diagnoses: every Box 21 entry printed on this page, as { letter, code }, letter A-L exactly as labeled. Use code null for an entry you cannot read. Do not add codes that are not printed.
- lines: every Box 24 service line on this page, top to bottom:
  - row: the printed line number 1-6.
  - dateFrom / dateTo: Box 24A from/to dates exactly as printed (e.g. "06 10 26").
  - placeOfService: Box 24B. cpt: Box 24D procedure code only.
  - modifiers: every Box 24D modifier on that line, in printed order (e.g. ["59", "GP"]). Never drop the second modifier.
  - diagnosisPointer: Box 24E exactly as printed for THAT line (e.g. "ABCD", "ABED", "CEDF"). Never substitute the Box 21 list.
  - charge: Box 24F as a number. units: Box 24G as a number.
  - unreadableFields: list any of date, placeOfService, cpt, modifiers, diagnosisPointer, charge, units you could not read with confidence. Put null (or [] for modifiers) for those values \u2014 never guess a value.
- Do not invent lines. Shaded supplemental-information rows above a line are not separate lines.

Return ONLY valid JSON.`;
var MAX_CONCURRENT_VISION_CALLS = 4;
var MAX_SCANNED_PAGES = 15;
var activeVisionCalls = 0;
var visionQueue = [];
async function withVisionSlot(fn) {
  if (activeVisionCalls >= MAX_CONCURRENT_VISION_CALLS) {
    await new Promise((resolve) => visionQueue.push(resolve));
  }
  activeVisionCalls++;
  try {
    return await fn();
  } finally {
    activeVisionCalls--;
    visionQueue.shift()?.();
  }
}
function parseVisionPages(content) {
  if (typeof content !== "string") throw new Error("No response from AI provider");
  const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
  return Array.isArray(parsed?.pages) ? parsed.pages : [];
}
var RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "cms1500_pages", strict: true, schema: PAGE_SCHEMA }
};
async function requestPages(buffer, filename, pageCount, onlyPages) {
  const instruction = onlyPages ? `This PDF has ${pageCount} page(s). Transcribe ONLY page(s) ${onlyPages.join(", ")}, returning one entry per requested page with its real pageNumber.` : `This PDF has ${pageCount} page(s). Transcribe every page, returning exactly ${pageCount} entries in "pages".`;
  const response = await withVisionSlot(() => invokeLLM({
    model: ENV.aiModel,
    max_tokens: 8192,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: instruction },
          { type: "file", file: { filename, file_data: `data:application/pdf;base64,${buffer.toString("base64")}` } }
        ]
      }
    ],
    response_format: RESPONSE_FORMAT
  }));
  return parseVisionPages(response.choices[0]?.message?.content);
}
async function requestRenderedPage(bands, pageNumber, pageCount) {
  const response = await withVisionSlot(() => invokeLLM({
    model: ENV.aiModel,
    max_tokens: 4096,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `These ${bands.length} images are overlapping horizontal strips of page ${pageNumber} of ${pageCount} of a scanned CMS-1500, in order from the top of the page to the bottom. Together they are one page: content in an overlap appears in two strips but is printed once \u2014 never transcribe it twice. Return exactly one entry in "pages" for this page, with pageNumber ${pageNumber}.`
          },
          ...bands.map((png) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}`, detail: "high" } }))
        ]
      }
    ],
    response_format: RESPONSE_FORMAT
  }));
  const [page] = parseVisionPages(response.choices[0]?.message?.content);
  return page ? { ...page, pageNumber } : null;
}
function standardFontDataUrl() {
  try {
    const lib = createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.mjs");
    return `${path.join(path.dirname(lib), "..", "..", "standard_fonts").replace(/\\/g, "/")}/`;
  } catch {
    console.warn("[CMS1500 Vision] pdfjs standard font data not found; printed text may be missing from rendered pages");
    return void 0;
  }
}
var RENDER_SCALE = 3;
var BANDS = [[0, 0.4], [0.33, 0.73], [0.6, 1]];
var sameText = (a, b) => (a ?? "").trim().toUpperCase().replace(/\s+/g, " ") === (b ?? "").trim().toUpperCase().replace(/\s+/g, " ");
var sameNumber = (a, b) => a == null && b == null || a != null && b != null && Math.abs(a - b) < 5e-3;
function reconcilePageReads(a, b) {
  const pickText = (x, y) => sameText(x, y) ? x : null;
  const letters = Array.from(new Set([...a.diagnoses, ...b.diagnoses].map((d) => d.letter.trim().toUpperCase()))).sort();
  const diagnoses = letters.map((letter) => {
    const da = a.diagnoses.find((d) => d.letter.trim().toUpperCase() === letter);
    const db = b.diagnoses.find((d) => d.letter.trim().toUpperCase() === letter);
    const code = da && db && da.code && sameText(da.code.replace(/\s/g, ""), (db.code ?? "").replace(/\s/g, "")) ? da.code : null;
    return { letter, code };
  });
  const rowsA = new Map(a.lines.map((l, i) => [l.row ?? -(i + 1), l]));
  const rowsB = new Map(b.lines.map((l, i) => [l.row ?? -(i + 1), l]));
  const rows = Array.from(new Set(Array.from(rowsA.keys()).concat(Array.from(rowsB.keys())))).sort((x, y) => Math.abs(x) - Math.abs(y));
  const lines = rows.map((row) => {
    const la = rowsA.get(row), lb = rowsB.get(row);
    if (!la || !lb) {
      const only = la ?? lb;
      return { ...only, unreadableFields: Array.from(/* @__PURE__ */ new Set([...only.unreadableFields, "date", "cpt"])) };
    }
    const flags = /* @__PURE__ */ new Set([...la.unreadableFields, ...lb.unreadableFields]);
    if (!sameText(la.dateFrom, lb.dateFrom) || !sameText(la.dateTo, lb.dateTo)) flags.add("date");
    if (!sameText(la.placeOfService, lb.placeOfService)) flags.add("placeOfService");
    if (!sameText(la.cpt, lb.cpt)) flags.add("cpt");
    if (!sameText([...la.modifiers].map((m) => m.trim().toUpperCase()).sort().join(","), [...lb.modifiers].map((m) => m.trim().toUpperCase()).sort().join(","))) flags.add("modifiers");
    if (!sameText(la.diagnosisPointer?.replace(/[\s,]/g, ""), lb.diagnosisPointer?.replace(/[\s,]/g, ""))) flags.add("diagnosisPointer");
    if (!sameNumber(la.charge, lb.charge)) flags.add("charge");
    if (!sameNumber(la.units, lb.units)) flags.add("units");
    return { ...la, unreadableFields: Array.from(flags) };
  });
  return {
    pageNumber: a.pageNumber,
    continuationLabel: pickText(a.continuationLabel, b.continuationLabel),
    // Two spellings of one name (e.g. a dropped middle initial) are the same
    // person by the app's own safe name rule; anything else is unreadable.
    patientName: a.patientName && b.patientName && fuzzyNameMatch(a.patientName, b.patientName) ? a.patientName : null,
    patientDob: pickText(a.patientDob, b.patientDob),
    insuredId: pickText(a.insuredId, b.insuredId),
    patientAccountNumber: pickText(a.patientAccountNumber, b.patientAccountNumber),
    claimNumber: pickText(a.claimNumber, b.claimNumber),
    billingNpi: pickText(a.billingNpi, b.billingNpi),
    insuredGroupNumber: pickText(a.insuredGroupNumber, b.insuredGroupNumber),
    signatureDate: pickText(a.signatureDate, b.signatureDate),
    totalCharge: sameNumber(a.totalCharge, b.totalCharge) ? a.totalCharge : null,
    diagnoses,
    lines
  };
}
async function readRenderedPage(bands, pageNumber, pageCount) {
  const [first, second] = await Promise.all([
    requestRenderedPage(bands, pageNumber, pageCount),
    requestRenderedPage(bands, pageNumber, pageCount)
  ]);
  if (!first || !second) return null;
  return reconcilePageReads(first, second);
}
async function renderPdfPages(buffer) {
  try {
    const pdfjsLib = await loadPdfjs();
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), standardFontDataUrl: standardFontDataUrl() }).promise;
    const factory = doc.canvasFactory;
    if (!factory) return null;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
      const full = factory.create(width, height);
      await page.render({ canvasContext: full.context, viewport, canvas: full.canvas }).promise;
      out.push(BANDS.map(([from, to]) => {
        const y = Math.floor(height * from), h = Math.ceil(height * (to - from));
        const band = factory.create(width, h);
        band.context.drawImage(full.canvas, 0, y, width, h, 0, 0, width, h);
        return band.canvas.toBuffer("image/png");
      }));
    }
    return out;
  } catch (err) {
    console.warn("[CMS1500 Vision] Page rendering unavailable, using whole-PDF input:", err instanceof Error ? err.message : err);
    return null;
  }
}
async function extractCms1500PagesWithVision(buffer, filename, pageCount, onlyPages = range(pageCount)) {
  const byPage = /* @__PURE__ */ new Map();
  const rendered = await renderPdfPages(buffer);
  if (rendered && rendered.length === pageCount) {
    const results = await Promise.allSettled(onlyPages.map((n) => readRenderedPage(rendered[n - 1], n, pageCount)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value) byPage.set(onlyPages[i], r.value);
      else if (r.status === "rejected") console.warn(`[CMS1500 Vision] Page ${onlyPages[i]} failed:`, r.reason instanceof Error ? r.reason.message : r.reason);
    });
    if (byPage.size === 0) throw new Error("No page of the scan could be read");
    for (const n of onlyPages.filter((p) => !byPage.has(p))) {
      try {
        const page = await readRenderedPage(rendered[n - 1], n, pageCount);
        if (page) byPage.set(n, page);
      } catch (err) {
        console.warn(`[CMS1500 Vision] Page ${n} retry failed:`, err instanceof Error ? err.message : err);
      }
    }
    const missingPages = onlyPages.filter((n) => !byPage.has(n));
    return { pages: Array.from(byPage.values()).sort((a, b) => a.pageNumber - b.pageNumber), missingPages, method: "rendered_pages" };
  }
  const accept = (pages) => {
    for (const p of pages) {
      if (Number.isInteger(p.pageNumber) && onlyPages.includes(p.pageNumber) && !byPage.has(p.pageNumber)) {
        byPage.set(p.pageNumber, p);
      }
    }
  };
  accept(await requestPages(buffer, filename, pageCount, onlyPages.length === pageCount ? null : onlyPages));
  let missing = onlyPages.filter((n) => !byPage.has(n));
  if (missing.length > 0) {
    console.warn(`[CMS1500 Vision] First pass returned ${byPage.size}/${pageCount} pages; re-requesting page(s) ${missing.join(", ")}`);
    accept(await requestPages(buffer, filename, pageCount, missing));
    missing = onlyPages.filter((n) => !byPage.has(n));
  }
  return { pages: Array.from(byPage.values()).sort((a, b) => a.pageNumber - b.pageNumber), missingPages: missing, method: "whole_pdf" };
}
function range(n) {
  return Array.from({ length: n }, (_, i) => i + 1);
}
var clean = (v) => {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
};
var ident = (v) => {
  const s = clean(v);
  return s ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") || null : null;
};
var nameKey = (v) => {
  const s = clean(v);
  return s ? s.toUpperCase().replace(/[^A-Z]+/g, " ").trim() || null : null;
};
function parseFormDate(raw) {
  const s = clean(raw);
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, " ").trim().split(/\s+/);
  let mm, dd, yy;
  if (digits.length === 3) [mm, dd, yy] = digits;
  else if (digits.length === 1 && (digits[0].length === 6 || digits[0].length === 8)) {
    mm = digits[0].slice(0, 2);
    dd = digits[0].slice(2, 4);
    yy = digits[0].slice(4);
  } else return null;
  const m = parseInt(mm, 10), d = parseInt(dd, 10);
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const year = yy.length === 2 ? 2e3 + parseInt(yy, 10) : yy.length === 4 ? parseInt(yy, 10) : NaN;
  if (!Number.isFinite(year)) return null;
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function pointerLetters(raw) {
  const s = clean(raw);
  if (!s) return null;
  const letters = [];
  for (const t2 of s.toUpperCase().replace(/[\s,]+/g, "")) {
    if (/^[A-L]$/.test(t2)) letters.push(t2);
    else if (/^[1-9]$/.test(t2)) letters.push(String.fromCharCode(64 + parseInt(t2, 10)));
    else return null;
  }
  return letters.length > 0 && letters.length <= 4 ? letters : null;
}
function pageIdentity(p) {
  return {
    name: nameKey(p.patientName),
    insuredId: ident(p.insuredId),
    account: ident(p.patientAccountNumber),
    claim: ident(p.claimNumber),
    dob: parseFormDate(p.patientDob)
  };
}
function samePatientClaim(a, b) {
  if (!a.name || !b.name || !fuzzyNameMatch(a.name, b.name)) return false;
  let sharedStrong = 0;
  for (const k of ["insuredId", "account", "claim", "dob"]) {
    if (a[k] && b[k]) {
      if (a[k] !== b[k]) return false;
      sharedStrong++;
    }
  }
  return sharedStrong > 0;
}
function parseFormBirthDate(raw) {
  const iso = parseFormDate(raw);
  if (!iso) return null;
  const digits = (clean(raw) ?? "").replace(/[^0-9]/g, " ").trim().split(/\s+/);
  const year = digits.length === 3 ? digits[2] : digits[0].slice(4);
  if (year.length !== 4) return null;
  return iso > (/* @__PURE__ */ new Date()).toISOString().slice(0, 10) ? null : iso;
}
function patientIdentityFor(pages) {
  const externalId = pages.map((p) => clean(p.patientAccountNumber)).find(Boolean) ?? null;
  const birthDate = pages.map((p) => parseFormBirthDate(p.patientDob)).find(Boolean) ?? null;
  if (!externalId && !birthDate) return null;
  return { sourceSystem: CMS1500_BOX26_SOURCE_SYSTEM, externalId, strength: "account", birthDate };
}
function assembleCms1500Pages(pages, pageCount, missingPages = []) {
  const warnings = [];
  if (missingPages.length > 0) {
    warnings.push(`Page(s) ${missingPages.join(", ")} of ${pageCount} could not be read. Lines on those pages are not included \u2014 re-upload or enter them manually.`);
  }
  const building = [];
  for (const page of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    const id = pageIdentity(page);
    const prev = building[building.length - 1];
    if (prev && prev.identity.name && samePatientClaim(prev.identity, id)) {
      prev.pages.push(page);
      for (const k of ["insuredId", "account", "claim", "dob"]) prev.identity[k] = prev.identity[k] ?? id[k];
    } else {
      building.push({ pages: [page], identity: id });
    }
  }
  const groups = building.map((b, gi) => {
    const groupWarnings = [];
    const pageNums = b.pages.map((p) => p.pageNumber);
    const patientName = b.identity.name ? clean(b.pages.find((p) => clean(p.patientName))?.patientName) : null;
    if (!patientName) {
      groupWarnings.push(`Page(s) ${pageNums.join(", ")}: the patient could not be identified, so these pages were not merged with any other page. Confirm the patient before saving.`);
    } else if (!b.identity.insuredId && !b.identity.account && !b.identity.claim && !b.identity.dob) {
      groupWarnings.push(`Page(s) ${pageNums.join(", ")}: no insured ID, account number, claim number, or date of birth was readable, so these pages were kept separate from neighboring pages.`);
    }
    const dx = /* @__PURE__ */ new Map();
    for (const p of b.pages) {
      for (const d of p.diagnoses ?? []) {
        const letter = (d.letter ?? "").trim().toUpperCase();
        if (!/^[A-L]$/.test(letter)) continue;
        const code = clean(d.code)?.toUpperCase().replace(/\s+/g, "") ?? null;
        if (!dx.has(letter)) dx.set(letter, code);
        else if (dx.get(letter) !== code) {
          dx.set(letter, null);
          groupWarnings.push(`Box 21 ${letter} reads differently on different pages \u2014 treated as unreadable.`);
        }
      }
    }
    const signature = b.pages.map((p) => parseFormDate(p.signatureDate)).find(Boolean) ?? null;
    const groupNumber = b.pages.map((p) => clean(p.insuredGroupNumber)).find(Boolean) ?? null;
    const lines = [];
    for (const p of b.pages) {
      for (const l of p.lines ?? []) {
        const unreadable = new Set((l.unreadableFields ?? []).map((f) => String(f)));
        const notes = [];
        const dateOfService = unreadable.has("date") ? null : parseFormDate(l.dateFrom);
        const dateTo = unreadable.has("date") ? null : parseFormDate(l.dateTo);
        const flagged = [];
        if (!dateOfService) flagged.push("dateOfService");
        if (dateTo && dateOfService && dateTo !== dateOfService) notes.push(`Box 24A spans ${dateOfService} to ${dateTo}.`);
        const cpt = unreadable.has("cpt") ? null : clean(l.cpt)?.toUpperCase() ?? null;
        if (!cpt || !/^[A-Z0-9]{5}$/.test(cpt)) flagged.push("cptCodes");
        const modifiers = unreadable.has("modifiers") ? null : formatModifiers(l.modifiers ?? []);
        if (unreadable.has("modifiers")) flagged.push("modifier");
        let units = unreadable.has("units") ? null : l.units;
        if (units != null && !(Number.isInteger(units) && units > 0 && units < 1e3)) units = null;
        if (units == null) flagged.push("unitsBilled");
        const letters = unreadable.has("diagnosisPointer") ? null : pointerLetters(l.diagnosisPointer);
        let diagnosisCodes = null;
        if (!letters) {
          flagged.push("diagnosisCodes");
          if (clean(l.diagnosisPointer)) notes.push(`Diagnosis pointer "${clean(l.diagnosisPointer)}" could not be read.`);
        } else {
          const codes = [];
          const unresolved = [];
          for (const letter of letters) {
            const code = dx.get(letter);
            if (code) {
              if (!codes.includes(code)) codes.push(code);
            } else unresolved.push(letter);
          }
          if (unresolved.length > 0) {
            flagged.push("diagnosisCodes");
            notes.push(`Pointer ${letters.join("")}: Box 21 ${unresolved.join(", ")} is missing or unreadable.`);
          } else {
            diagnosisCodes = codes.join(", ");
          }
        }
        const pos = unreadable.has("placeOfService") ? null : clean(l.placeOfService);
        if (unreadable.has("placeOfService")) flagged.push("placeOfService");
        const charge = unreadable.has("charge") ? null : typeof l.charge === "number" && Number.isFinite(l.charge) ? l.charge : null;
        lines.push({
          page: p.pageNumber,
          slot: Number.isInteger(l.row) && l.row >= 1 && l.row <= 6 ? l.row : null,
          dateOfService,
          placeOfService: pos,
          cptCodes: flagged.includes("cptCodes") ? null : cpt,
          modifier: modifiers,
          unitsBilled: units,
          diagnosisPointer: letters ? letters.join("") : clean(l.diagnosisPointer),
          diagnosisCodes,
          claimSubmittedDate: signature,
          insuranceBilled: groupNumber,
          lineChargeForValidation: charge,
          unreadable: Array.from(new Set(flagged)),
          notes: notes.length > 0 ? notes.join(" ") : null
        });
      }
    }
    const total = [...b.pages].reverse().map((p) => p.totalCharge).find((t2) => typeof t2 === "number" && Number.isFinite(t2)) ?? null;
    if (total != null) {
      if (lines.some((l) => l.lineChargeForValidation == null)) {
        groupWarnings.push(`Box 28 total $${total.toFixed(2)} could not be verified: at least one line charge is unreadable.`);
      } else {
        const sum = lines.reduce((s, l) => s + (l.lineChargeForValidation ?? 0), 0);
        if (Math.abs(sum - total) > 4e-3) {
          groupWarnings.push(`Line charges add up to $${sum.toFixed(2)} but Box 28 shows $${total.toFixed(2)} \u2014 a line may be missing or misread. Review before saving.`);
        }
      }
    } else if (lines.length > 0) {
      groupWarnings.push("Box 28 total charge was not readable on any page, so the line count could not be cross-checked.");
    }
    const flaggedCount = lines.filter((l) => l.unreadable.length > 0).length;
    if (flaggedCount > 0) groupWarnings.push(`${flaggedCount} line(s) have unreadable values left blank \u2014 review the flagged cells.`);
    const groupKey2 = groupKeyFor(
      `cms1500-scan:${b.identity.name ?? "unidentified"}:${b.identity.insuredId ?? ""}:${b.identity.account ?? ""}:${b.identity.claim ?? ""}:${patientName ? "" : `p${pageNums[0]}`}:${gi}`
    );
    return {
      groupKey: groupKey2,
      patientName,
      pages: pageNums,
      claimIdentifier: b.pages.map((p) => clean(p.patientAccountNumber) ?? clean(p.claimNumber)).find(Boolean) ?? null,
      lines: assignCms1500LineKeys(groupKey2, lines),
      warnings: groupWarnings,
      unresolvedClaimTotals: [],
      patientIdentity: patientIdentityFor(b.pages)
    };
  });
  return { groups, warnings };
}

// server/cms1500FormFields.ts
var ROWS = [1, 2, 3, 4, 5, 6];
function collectTextFields(annotations) {
  const fields = /* @__PURE__ */ new Map();
  for (const a of annotations) {
    if (a.fieldType !== "Tx" || !a.fieldName || typeof a.fieldValue !== "string") continue;
    const value = a.fieldValue.trim();
    if (value && !fields.has(a.fieldName)) fields.set(a.fieldName, value);
  }
  return fields;
}
function moneyOf(raw) {
  if (!raw) return null;
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function datePart(fields, mm, dd, yy) {
  const parts = [fields.get(mm), fields.get(dd), fields.get(yy)];
  return parts.every(Boolean) ? parts.join(" ") : null;
}
function formFieldsToPage(fields, pageNumber) {
  const lines = [];
  for (const n of ROWS) {
    const dateFrom = datePart(fields, `sv${n}_mm_from`, `sv${n}_dd_from`, `sv${n}_yy_from`);
    const cpt = fields.get(`cpt${n}`) ?? null;
    if (!cpt && !dateFrom) continue;
    const rawUnits = fields.get(`day${n}`);
    const units = rawUnits && /^\d+(\.0+)?$/.test(rawUnits) ? Number(rawUnits) : null;
    lines.push({
      row: n,
      dateFrom,
      dateTo: datePart(fields, `sv${n}_mm_end`, `sv${n}_dd_end`, `sv${n}_yy_end`),
      placeOfService: fields.get(`place${n}`) ?? null,
      cpt,
      modifiers: [`mod${n}`, `mod${n}a`, `mod${n}b`, `mod${n}c`].map((k) => fields.get(k)).filter((m) => !!m),
      diagnosisPointer: fields.get(`diag${n}`) ?? null,
      charge: moneyOf(fields.get(`ch${n}`)),
      units,
      unreadableFields: []
    });
  }
  const patientName = fields.get("pt_name") ?? null;
  if (lines.length === 0 && !patientName) return null;
  const diagnoses = Array.from({ length: 12 }, (_, i) => ({ letter: String.fromCharCode(65 + i), code: fields.get(`diagnosis${i + 1}`) ?? null })).filter((d) => d.code);
  return {
    pageNumber,
    continuationLabel: null,
    patientName,
    patientDob: datePart(fields, "birth_mm", "birth_dd", "birth_yy"),
    insuredId: fields.get("insurance_id") ?? null,
    patientAccountNumber: fields.get("pt_account") ?? null,
    claimNumber: null,
    billingNpi: fields.get("pin") ?? null,
    insuredGroupNumber: fields.get("ins_policy") ?? null,
    signatureDate: fields.get("physician_date") ?? null,
    totalCharge: moneyOf(fields.get("t_charge")),
    diagnoses,
    lines
  };
}
async function readCms1500FormPages(buffer) {
  try {
    const pdfjsLib = await loadPdfjs();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const annotations = await (await pdf.getPage(i)).getAnnotations();
      const page = formFieldsToPage(collectTextFields(annotations), i);
      if (page) pages.push(page);
    }
    return pages;
  } catch (err) {
    console.warn("[CMS1500 Form] Could not read form fields:", err instanceof Error ? err.message : err);
    return [];
  }
}

// shared/claimCsvTemplates.ts
import Papa from "papaparse";
var CMS1500_EXPORT_HEADERS = [
  "invoice date(s)",
  "service date(s)",
  "patient_guid",
  "patient",
  "staff member",
  "invoice #",
  "claim",
  "adjuster",
  "adjuster phone",
  "adjuster email",
  "description",
  "personal health number",
  "birth date",
  "date of injury",
  "employer",
  "total",
  "balance"
];
var CMS1500_EXPORT_REQUIRED = ["service date(s)", "patient", "invoice #", "description"];
var CMS1500_EXPORT_MAPPING = [
  { column: "Invoice #", usedAs: "Import identity (kept as text)" },
  { column: "Service Date(s)", usedAs: "Date of service" },
  { column: "Description", usedAs: "CPT code, units, and that service's diagnosis codes" },
  { column: "Patient", usedAs: "Patient name" },
  { column: "patient_guid", usedAs: "Billing system's patient ID (not a dashboard ID)" },
  { column: "Birth Date", usedAs: "Identity check only, not added to the patient record" },
  { column: "Total, Balance", usedAs: "Not imported. Never treated as a payment or reimbursement" },
  { column: "Invoice Date(s), Staff Member, Claim, Adjuster (3 columns), Personal Health Number, Date of Injury, Employer", usedAs: "Not imported" }
];
var CLAIM_CSV_STATUS_VALUES = ["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "needs_review"];
var CSV_DATE_FORMATS = "YYYY-MM-DD or MM/DD/YYYY";
var F = (header, required, type, help, maxLength) => ({ header, required, type, help, ...maxLength ? { maxLength } : {} });
var PATIENT_FIELDS = [
  F("patient_name", true, "patient_name", "Patient name as it appears on the dashboard, e.g. DOE, JANE."),
  F("patient_id", false, "uuid", "Dashboard patient ID, only if you copied it from the dashboard. Never make one up \u2014 leave blank to match by name.")
];
var SERVICE_FIELDS = [
  F("date_of_service", true, "date", `Date of service (${CSV_DATE_FORMATS}).`)
];
var CMS1500_CSV_FIELDS = [
  F("cms1500_claim_id", true, "claim_id", "Your stable ID for this CMS1500 claim form (e.g. the patient account no. in Box 26). Same value on every line of the form and on every re-import. One patient per ID."),
  F("cms1500_line_id", true, "line_id", "Stable ID of this service line within the claim, e.g. 1, 2, 3. Keep it the same on re-import. Two identical CPT lines need two different IDs."),
  ...PATIENT_FIELDS,
  F("auth_period", false, "period", "Authorization period number (1, 2, \u2026). Blank = decided from the patient's visit dates; a mismatch asks you to choose."),
  ...SERVICE_FIELDS,
  F("place_of_service", false, "pos", "Box 24B place-of-service code, 2 digits (e.g. 11, 02)."),
  F("cpt_code", true, "cpt", "One CPT/HCPCS code (Box 24D), e.g. 97110."),
  F("modifiers", false, "modifiers", 'Up to 4 modifiers in ONE quoted cell, comma-separated, e.g. "GP, 59".'),
  F("units", false, "units", "Units (Box 24G), whole number 1\u2013999."),
  F("diagnosis_codes", false, "diagnosis", 'ICD-10 codes for this line in pointer order, in ONE quoted cell, comma-separated, e.g. "M54.50, M25.561".'),
  F("visit_number", false, "visit_number", "Visit number, only if known from your records. Never calculated."),
  F("claim_submitted_date", false, "date", `Date the claim was submitted / Box 31 date (${CSV_DATE_FORMATS}).`),
  F("insurance_billed", false, "text", "Value for the Insurance Billed column, e.g. the Box 11 insured group number.", 60)
];
var EOB_CSV_FIELDS = [
  F("reimbursement_id", true, "claim_id", "Your stable ID for this adjudicated claim on the EOB / remittance (e.g. the payer claim number). Same value on every line of that claim and on every re-import. One patient per ID."),
  F("reimbursement_line_id", true, "line_id", "Stable ID of this payment line within the claim, e.g. 1, 2, 3. Keep it the same on re-import."),
  F("cms1500_claim_id", false, "claim_id", "Recommended: the cms1500_claim_id of the CMS1500 CSV row this payment belongs to. Fill both CMS1500 columns or neither."),
  F("cms1500_line_id", false, "line_id", "Recommended: the cms1500_line_id of that CMS1500 row. With both, the payment is applied to exactly that line."),
  ...PATIENT_FIELDS,
  F("auth_period", false, "period", "Authorization period number. When filled, only CMS1500 lines in that period are considered."),
  ...SERVICE_FIELDS,
  F("cpt_code", true, "cpt", "CPT/HCPCS code of the adjudicated line, e.g. 97110."),
  F("modifiers", false, "modifiers", 'Modifiers in ONE quoted cell, comma-separated, e.g. "GP, 59".'),
  F("units", false, "units", "Units, whole number 1\u2013999."),
  F("billed_charge", false, "money", "Billed charge for this line."),
  F("insurance_paid", false, "money", "Amount the insurance plan paid for THIS line. Never put a claim total here."),
  F("patient_responsibility", false, "money", "What the EOB says the patient owes for this line (deductible, copay, coinsurance). This is not a payment."),
  F("patient_paid", false, "money", "What the patient has actually paid for this line. Leave blank if unknown \u2014 it is never calculated from other amounts."),
  F("claim_status", false, "status", `Adjudication status: ${CLAIM_CSV_STATUS_VALUES.join(", ")}.`),
  F("payment_date", false, "date", `Check / payment date (${CSV_DATE_FORMATS}).`),
  F("payer_claim_number", false, "text", "Payer's claim number (OA claim #).", 80),
  F("check_or_eft_number", false, "text", "Check, EFT or virtual card number. Leading zeros are kept.", 80),
  F("claim_total_paid", false, "money", "Only when the EOB prints one plan payment for the whole claim: that total, same value on every row of the claim. It is NOT saved to any line \u2014 it is shown for manual review."),
  F("claim_total_patient_responsibility", false, "money", "Only when the EOB prints one patient-responsibility total for the whole claim. Not saved to any line; shown for review.")
];
var EXAMPLE_ID_PREFIX = "EXAMPLE";
var SAMPLE_PATIENT = "SAMPLE, PATIENT";
var CLAIM_CSV_TEMPLATES = {
  cms1500: {
    kind: "cms1500",
    fileName: "cms1500-import-template.csv",
    title: "CMS1500",
    claimIdHeader: "cms1500_claim_id",
    lineIdHeader: "cms1500_line_id",
    fields: CMS1500_CSV_FIELDS,
    sampleRows: [
      { cms1500_claim_id: "EXAMPLE-CMS-1001", cms1500_line_id: "1", patient_name: SAMPLE_PATIENT, auth_period: "1", date_of_service: "2026-01-05", place_of_service: "11", cpt_code: "97110", modifiers: "GP", units: "2", diagnosis_codes: "M54.50, M25.561", claim_submitted_date: "2026-01-10", insurance_billed: "SYN-GRP-0042" },
      { cms1500_claim_id: "EXAMPLE-CMS-1001", cms1500_line_id: "2", patient_name: SAMPLE_PATIENT, auth_period: "1", date_of_service: "2026-01-05", place_of_service: "11", cpt_code: "97110", modifiers: "GP", units: "2", diagnosis_codes: "M54.50, M25.561", claim_submitted_date: "2026-01-10", insurance_billed: "SYN-GRP-0042" },
      { cms1500_claim_id: "EXAMPLE-CMS-1001", cms1500_line_id: "3", patient_name: SAMPLE_PATIENT, date_of_service: "01/05/2026", place_of_service: "02", cpt_code: "97140", modifiers: "GP, 59", units: "1", diagnosis_codes: "M54.50", visit_number: "4", claim_submitted_date: "01/10/2026" }
    ],
    notes: [
      "CMS1500 import template. One row per CMS1500 service line (Box 24). Import this BEFORE the Insurance Reimbursement CSV.",
      "Amounts are not part of this template: billed and paid amounts come from the Insurance Reimbursement CSV.",
      "Repeated identical CPT lines are kept as separate lines - give each its own cms1500_line_id.",
      `Dates: ${CSV_DATE_FORMATS}. Put several modifiers or diagnosis codes in ONE quoted cell separated by commas.`,
      "Delete the EXAMPLE rows before importing - they are refused. Lines starting with # above the header are ignored."
    ]
  },
  eob: {
    kind: "eob",
    fileName: "insurance-reimbursement-import-template.csv",
    title: "Insurance Reimbursement",
    claimIdHeader: "reimbursement_id",
    lineIdHeader: "reimbursement_line_id",
    fields: EOB_CSV_FIELDS,
    sampleRows: [
      { reimbursement_id: "EXAMPLE-ERA-5001", reimbursement_line_id: "1", cms1500_claim_id: "EXAMPLE-CMS-1001", cms1500_line_id: "1", patient_name: SAMPLE_PATIENT, date_of_service: "2026-01-05", cpt_code: "97110", modifiers: "GP", units: "2", billed_charge: "150.00", insurance_paid: "80.00", patient_responsibility: "20.00", claim_status: "approved", payment_date: "2026-02-01", payer_claim_number: "SYN-PAYER-0001", check_or_eft_number: "000123" },
      { reimbursement_id: "EXAMPLE-ERA-5001", reimbursement_line_id: "2", cms1500_claim_id: "EXAMPLE-CMS-1001", cms1500_line_id: "2", patient_name: SAMPLE_PATIENT, date_of_service: "2026-01-05", cpt_code: "97110", modifiers: "GP", units: "2", billed_charge: "150.00", insurance_paid: "80.00", patient_responsibility: "20.00", patient_paid: "0", claim_status: "approved", payment_date: "2026-02-01", payer_claim_number: "SYN-PAYER-0001", check_or_eft_number: "000123" },
      { reimbursement_id: "EXAMPLE-ERA-5001", reimbursement_line_id: "3", cms1500_claim_id: "EXAMPLE-CMS-1001", cms1500_line_id: "3", patient_name: SAMPLE_PATIENT, date_of_service: "01/05/2026", cpt_code: "97140", modifiers: "GP, 59", units: "1", billed_charge: "95.00", insurance_paid: "0", claim_status: "denied", payment_date: "02/01/2026", payer_claim_number: "SYN-PAYER-0001", check_or_eft_number: "000123" }
    ],
    notes: [
      "Insurance Reimbursement import template. One row per adjudicated service line. Import the matching CMS1500 CSV FIRST.",
      "Each row is applied only to an existing CMS1500 line. Fill cms1500_claim_id + cms1500_line_id to point at the exact line.",
      "patient_responsibility (what the patient owes) and patient_paid (what the patient actually paid) are different - neither is calculated.",
      "Blank amount = unknown / leave unchanged. 0 = zero. Claim totals go only in claim_total_* columns and are never saved to a line.",
      `Dates: ${CSV_DATE_FORMATS}. claim_status: ${CLAIM_CSV_STATUS_VALUES.join(" / ")}.`,
      "Delete the EXAMPLE rows before importing - they are refused. Lines starting with # above the header are ignored."
    ]
  }
};
var CLAIM_CSV_MAX_ROWS = 1e3;
var CLAIM_CSV_MAX_BYTES = 2e6;
function stripLeadingCommentLines(text) {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  let i = 0;
  while (i < lines.length && (/^\s*"?#/.test(lines[i]) || lines[i].trim() === "" || /^[,\s]*$/.test(lines[i]))) i++;
  return { body: lines.slice(i).join("\n"), skippedLines: i };
}
function normalizeHeader(h) {
  return h.replace(/^﻿/, "").trim().toLowerCase();
}
function readCsvHeaders(text) {
  const { body } = stripLeadingCommentLines(text);
  const firstLine = Papa.parse(body, { preview: 1, skipEmptyLines: true });
  return (firstLine.data[0] ?? []).map(normalizeHeader).filter(Boolean);
}
function detectCsvTemplate(headers) {
  const h = new Set(headers.map(normalizeHeader));
  if (h.has("reimbursement_id") || h.has("reimbursement_line_id")) return "eob";
  if (h.has("cms1500_claim_id") || h.has("cms1500_line_id")) return "cms1500";
  if (h.has("description") && (h.has("invoice #") || h.has("patient_guid") || h.has("service date(s)"))) return "cms1500_export";
  if (h.has("patient name") || h.has("authorized sessions")) return "patient";
  return "unknown";
}
function detectCsvTemplateFromText(text) {
  return detectCsvTemplate(readCsvHeaders(text));
}
function wrongTemplateMessage(expected, detected) {
  if (detected === expected) return null;
  if (detected === "cms1500_export") {
    return expected === "cms1500" ? null : "This is a CMS1500 invoice export, not an Insurance Reimbursement CSV. Nothing was imported. Upload it under Bulk Upload \u2192 CMS1500.";
  }
  const expectedName = CLAIM_CSV_TEMPLATES[expected].title;
  if (detected === "unknown") {
    return `This file is not a ${expectedName} CSV this app can read. Download ${CLAIM_CSV_TEMPLATES[expected].fileName} and use its header row${expected === "cms1500" ? ", or upload the billing system's invoice export" : ""}.`;
  }
  if (detected === "patient") {
    return `This looks like a patient list, not a ${expectedName} CSV. Nothing was imported. Upload patient lists under Patient Records \u2192 Bulk Upload Patients.`;
  }
  return `This is the ${CLAIM_CSV_TEMPLATES[detected].title} CSV template, not ${expectedName}. Nothing was imported. Upload it under Bulk Upload \u2192 ${CLAIM_CSV_TEMPLATES[detected].title}.`;
}
var ok = (value) => ({ ok: true, value });
var bad = (error) => ({ ok: false, error });
function cleanCell(raw) {
  if (raw == null) return "";
  let v = String(raw).trim();
  const literal = v.match(/^="(.*)"$/);
  if (literal) v = literal[1].trim();
  return v;
}
function parseCsvDate(v) {
  if (!v) return ok(null);
  let y, m, d;
  let match = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    y = +match[1];
    m = +match[2];
    d = +match[3];
  } else if (match = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)) {
    m = +match[1];
    d = +match[2];
    y = +match[3];
  } else return bad(`"${v}" is not a date in ${CSV_DATE_FORMATS} format.`);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1900 || y > 2100) {
    return bad(`"${v}" is not a real calendar date.`);
  }
  return ok(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}
function parseCsvMoney(v) {
  if (!v) return ok(null);
  const s = v.replace(/^\$/, "").trim();
  if (/^-/.test(s) || /^\(.*\)$/.test(s)) return bad(`"${v}": negative amounts are not accepted. Leave blank if unknown.`);
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) return bad(`"${v}" is not an amount (use e.g. 125.50).`);
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n) || n > 1e7) return bad(`"${v}" is out of range.`);
  return ok(Math.round(n * 100) / 100);
}
function parseInteger(v, min, max, label) {
  if (!v) return ok(null);
  if (!/^\d+$/.test(v)) return bad(`${label} "${v}" must be a whole number.`);
  const n = Number(v);
  if (n < min || n > max) return bad(`${label} "${v}" must be between ${min} and ${max}.`);
  return ok(n);
}
function splitCodes(v) {
  return v.toUpperCase().split(/[\s,;]+/).filter(Boolean);
}
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var ICD10_RE = /^[A-Z][0-9][0-9A-Z](\.?[0-9A-Z]{1,4})?$/;
function parseCsvCell(field, raw) {
  const v = cleanCell(raw);
  if (!v) return field.required ? bad(`${field.header} is required.`) : ok(null);
  switch (field.type) {
    case "claim_id": {
      const id = v.replace(/\s+/g, " ").toUpperCase();
      if (id.length > 80) return bad(`${field.header} is longer than 80 characters.`);
      if (/^[#=+@]/.test(id)) return bad(`${field.header} "${v}" cannot start with #, =, + or @.`);
      return ok(id);
    }
    case "line_id": {
      const id = v.toUpperCase();
      if (!/^[A-Z0-9._-]{1,40}$/.test(id)) return bad(`${field.header} "${v}" may only contain letters, digits, ".", "_" and "-" (max 40).`);
      return ok(id);
    }
    case "patient_name":
      return v.length > 200 ? bad("patient_name is longer than 200 characters.") : ok(v.replace(/\s+/g, " "));
    case "uuid":
      return UUID_RE.test(v) ? ok(v.toLowerCase()) : bad(`${field.header} "${v}" is not a dashboard patient ID. Leave it blank to match by name.`);
    case "period":
      return parseInteger(v, 1, 1e3, field.header);
    case "date":
      return parseCsvDate(v);
    case "pos":
      if (/^\d$/.test(v)) return bad(`place_of_service "${v}" must be 2 digits (e.g. 0${v}) \u2014 the spreadsheet may have dropped a leading zero.`);
      return /^\d{2}$/.test(v) ? ok(v) : bad(`place_of_service "${v}" must be a 2-digit code.`);
    case "cpt": {
      const c = v.toUpperCase();
      return /^[A-Z0-9]{5}$/.test(c) ? ok(c) : bad(`cpt_code "${v}" must be one 5-character CPT/HCPCS code (one code per row).`);
    }
    case "modifiers": {
      const mods = splitCodes(v);
      if (mods.length > 4) return bad(`modifiers "${v}": at most 4 modifiers.`);
      const badMod = mods.find((m) => !/^[A-Z0-9]{2}$/.test(m));
      if (badMod) return bad(`modifiers "${v}": "${badMod}" is not a 2-character modifier.`);
      return ok(Array.from(new Set(mods)).join(", "));
    }
    case "units":
      return parseInteger(v, 1, 999, field.header);
    case "visit_number":
      return parseInteger(v, 1, 1e4, field.header);
    case "diagnosis": {
      const codes = splitCodes(v);
      if (codes.length > 12) return bad("diagnosis_codes: at most 12 codes.");
      const badCode = codes.find((c) => !ICD10_RE.test(c));
      if (badCode) return bad(`diagnosis_codes "${v}": "${badCode}" is not an ICD-10 code.`);
      return ok(codes.join(", "));
    }
    case "money":
      return parseCsvMoney(v);
    case "status": {
      const s = v.toLowerCase().replace(/\s+/g, "_");
      return CLAIM_CSV_STATUS_VALUES.includes(s) ? ok(s) : bad(`claim_status "${v}" must be one of: ${CLAIM_CSV_STATUS_VALUES.join(", ")}.`);
    }
    case "text":
      return v.length > (field.maxLength ?? 200) ? bad(`${field.header} is longer than ${field.maxLength ?? 200} characters.`) : ok(v);
  }
}

// server/claimUpload.ts
var CMS1500_CLAIM_FIELDS_TO_BACKFILL = [
  "placeOfService",
  "claimSubmittedDate"
];
var CMS1500_LINE_FIELDS_TO_BACKFILL = [
  "cptCodes",
  // Read for the Box 28 cross-check only; CMS1500 never persists a charge.
  "chargeAmount",
  "unitsBilled",
  "modifier"
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
  // P4-P28: the deployed function refuses larger request bodies before this
  // code runs, so a higher limit here would only hide that failure.
  limits: { fileSize: CLAIM_UPLOAD_MAX_BYTES },
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
  const pdfjsLib = await loadPdfjs();
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
  const pdfjsLib = await loadPdfjs();
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
  return pageTexts.join("\f");
}
function parseCms1500TextPages(text) {
  const pages = text.split("\f").filter((p) => p.trim());
  if (pages.length <= 1) return parseCMS1500(text);
  const groups = [];
  for (const page of pages) {
    for (const g of parseCMS1500(page)) {
      const same = g.patientName !== "UNKNOWN" ? groups.find((x) => x.patientName !== "UNKNOWN" && fuzzyNameMatch(x.patientName, g.patientName)) : void 0;
      if (same) same.claims.push(...g.claims);
      else groups.push({ ...g, claims: [...g.claims] });
    }
  }
  return groups;
}
async function getPdfPageCount(buffer) {
  try {
    const pdfjsLib = await loadPdfjs();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}
function hasTextLayer(text) {
  return text.replace(/\s+/g, "").length >= 40;
}
function groupFlatClaimsByPatient(claims) {
  const byName = /* @__PURE__ */ new Map();
  for (const c of claims) {
    const patientName = c.patientName?.trim() || null;
    const k = patientName ? patientName.toUpperCase() : "";
    if (!byName.has(k)) byName.set(k, { patientName, claims: [] });
    byName.get(k).claims.push(c);
  }
  return Array.from(byName.values());
}
function buildImportDocument(params) {
  return {
    kind: params.kind,
    sha256: params.sha256,
    fileName: params.fileName.slice(0, 255),
    pageCount: params.pageCount,
    extractionMethod: params.extractionMethod,
    groups: params.groups,
    warnings: params.warnings ?? [],
    extractionFallback: params.extractionFallback ?? null
  };
}
async function getPdfPagesWithoutText(buffer) {
  try {
    const pdfjsLib = await loadPdfjs();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    const missing = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str : "").join("");
      if (text.replace(/\s+/g, "").length < 20) missing.push(i);
    }
    return missing;
  } catch {
    return null;
  }
}
function isMixedTextAndScanned(textless, pageCount) {
  return !!textless && !!pageCount && textless.length > 0 && textless.length < pageCount;
}
var LEGACY_TEXT_LIMIT = 2e4;
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
  const result = Papa2.parse(csvString, { header: true, skipEmptyLines: true });
  if (result.errors.length > 0 && result.data.length === 0) {
    throw new Error("Could not parse CSV file.");
  }
  return JSON.stringify(result.data, null, 2);
}
async function mapToClaimColumns(extractedText) {
  const trimmedText = extractedText.slice(0, LEGACY_TEXT_LIMIT);
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
    requireClaimsAccess,
    (req, res, next) => {
      upload.single("file")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({ error: `This file is larger than ${CLAIM_UPLOAD_MAX_LABEL}, the upload limit. Nothing was read or saved. Split it into smaller PDFs and upload them together.` });
            return;
          }
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
        const sha256 = sha256Hex(buffer);
        console.log(`[ClaimUpload] Stage 1/7 \u2014 File uploaded: ${sha256.slice(0, 12)} (${(buffer.length / 1024).toFixed(1)} KB, ${mimetype})`);
        const isXlsx = name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".xlsm") || mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mimetype === "application/vnd.ms-excel.sheet.macroEnabled.12";
        const isCsv = !isXlsx && (mimetype === "text/csv" || name.endsWith(".csv"));
        if (isXlsx) {
          extractedText = extractXlsxText(buffer);
        } else if (isCsv) {
          const template = detectCsvTemplateFromText(buffer.toString("utf-8"));
          if (template === "cms1500" || template === "eob") {
            res.status(422).json({ error: `This is the ${CLAIM_CSV_TEMPLATES[template].title} CSV template. Nothing was imported. Upload it under Bulk Upload \u2192 ${CLAIM_CSV_TEMPLATES[template].title}.` });
            return;
          }
          if (template === "cms1500_export") {
            res.status(422).json({ error: "This is a CMS1500 invoice export. Nothing was imported. Upload it under Bulk Upload \u2192 CMS1500 \u2192 Import CSV." });
            return;
          }
          extractedText = extractCsvText(buffer);
        } else {
          const opened = await openPdf(buffer);
          if (!opened.ok) {
            console.error(`[ClaimUpload] PDF open failed (${opened.failure.kind}) for file ${sha256.slice(0, 12)}: ${opened.failure.detail}`);
            if (opened.failure.kind === "invalid" || opened.failure.kind === "unreadable") {
              try {
                extractedText = extractPdfTextLayout(buffer);
              } catch {
                extractedText = "";
              }
            }
            if (!hasTextLayer(extractedText)) {
              const { status, error } = pdfOpenFailureResponse(opened.failure);
              res.status(status).json({ error, code: `pdf_${opened.failure.kind}` });
              return;
            }
            console.warn("[ClaimUpload] pdfjs could not open the file; continuing with pdftotext text");
          }
          if (!extractedText) try {
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
          const isPdf = !isXlsx && !isCsv;
          const pageCount = isPdf ? await getPdfPageCount(buffer) : null;
          const formPages = isPdf ? await readCms1500FormPages(buffer) : [];
          if (formPages.length > 0 && pageCount) {
            const formPageNumbers = new Set(formPages.map((p) => p.pageNumber));
            const otherPages = Array.from({ length: pageCount }, (_, i) => i + 1).filter((n) => !formPageNumbers.has(n));
            if (otherPages.length > MAX_SCANNED_PAGES) {
              res.status(422).json({ error: `This file has ${otherPages.length} scanned pages. Split it into files of at most ${MAX_SCANNED_PAGES} scanned pages and upload them together.` });
              return;
            }
            let pages = formPages;
            let missing = [];
            let otherMethod = "";
            if (otherPages.length > 0) {
              try {
                console.log(`[ClaimUpload] Stage 5/7 \u2014 CMS1500 page vision for ${otherPages.length} page(s) without form values`);
                const read2 = await extractCms1500PagesWithVision(buffer, originalname, pageCount, otherPages);
                pages = [...formPages, ...read2.pages];
                missing = read2.missingPages;
                otherMethod = `, page vision for ${read2.pages.length}/${otherPages.length} other page(s)`;
              } catch (visionError) {
                console.error("[ClaimUpload] CMS1500 page vision failed for pages without form values:", visionError instanceof Error ? visionError.message : visionError);
                missing = otherPages;
              }
            }
            const assembled = assembleCms1500Pages(pages, pageCount, missing);
            const lineCount = assembled.groups.reduce((n, g) => n + g.lines.length, 0);
            if (lineCount === 0) {
              res.status(422).json({ error: "This fillable CMS1500 has no service lines filled in (Box 24 is empty). Nothing was saved." });
              return;
            }
            console.log(`[ClaimUpload] Stage 7/7 \u2014 Review pending: ${lineCount} CMS1500 line(s) from form fields on ${formPages.length}/${pageCount} page(s)`);
            res.json({
              claims: [],
              patientGroups: null,
              extractedLength: extractedText.length,
              templateUsed: "CMS1500 (fillable form fields)",
              uploadType: "cms1500",
              importDocument: buildImportDocument({
                kind: "cms1500",
                sha256,
                fileName: originalname,
                pageCount,
                extractionMethod: `CMS1500 form fields (${formPages.length}/${pageCount} pages)${otherMethod}`,
                groups: assembled.groups,
                warnings: assembled.warnings
              })
            });
            return;
          }
          let cms1500Text = extractedText;
          let cms1500TextFallback = false;
          if (isPdf) {
            try {
              cms1500Text = extractPdfTextLayout(buffer);
            } catch (pdftotextError) {
              console.warn("[ClaimUpload] pdftotext -layout unavailable for CMS1500 (expected on serverless):", pdftotextError instanceof Error ? pdftotextError.message : pdftotextError);
              try {
                cms1500Text = await extractPdfTextLayoutJS(buffer);
              } catch (jsLayoutError) {
                console.error("[ClaimUpload] JS layout extraction also failed for CMS1500, falling back to flat text:", jsLayoutError);
                cms1500TextFallback = true;
              }
            }
          }
          const textlessPages = isPdf ? await getPdfPagesWithoutText(buffer) : null;
          const mixedPages = isMixedTextAndScanned(textlessPages, pageCount);
          if (!mixedPages && hasTextLayer(cms1500Text || extractedText)) {
            console.log("[ClaimUpload] Stage 4/7 \u2014 Regex template parsing (CMS1500)...");
            const patientGroups = parseCms1500TextPages(cms1500Text);
            const flatClaims = patientGroups.flatMap((g) => g.claims);
            if (flatClaims.some((c) => c.cptLines.length > 0)) {
              if (hasMissingFields(flatClaims, CMS1500_CLAIM_FIELDS_TO_BACKFILL, CMS1500_LINE_FIELDS_TO_BACKFILL)) {
                try {
                  console.log("[ClaimUpload] Stage 4b/7 \u2014 CMS1500 regex parser left fields blank, running AI to backfill place of service / units / modifier...");
                  const backfillResult = await extractClaimsWithAI({ kind: "text", text: cms1500Text || extractedText }, "cms1500");
                  if (backfillResult.claims.length > 0) {
                    backfillMissingFields(flatClaims, backfillResult.claims, CMS1500_CLAIM_FIELDS_TO_BACKFILL, CMS1500_LINE_FIELDS_TO_BACKFILL);
                  }
                } catch (backfillError) {
                  console.error("[ClaimUpload] CMS1500 AI backfill failed (continuing with regex-only result):", backfillError);
                }
              }
              enforceFieldBoundary(flatClaims, "cms1500");
              const groups = cms1500GroupsFromClaims(patientGroups);
              for (const g of groups) {
                const missingDx = g.lines.filter((l) => !l.diagnosisCodes).length;
                if (missingDx > 0) g.warnings.push(`${missingDx} line(s) have no diagnosis codes: the Box 24E pointer could not be resolved against Box 21. Enter them manually if needed.`);
              }
              console.log(`[ClaimUpload] Stage 7/7 \u2014 Review pending: ${groups.reduce((n, g) => n + g.lines.length, 0)} CMS1500 line(s) via template parser`);
              res.json({
                claims: flatClaims,
                patientGroups: patientGroups.length > 0 ? patientGroups : null,
                extractedLength: extractedText.length,
                templateUsed: "CMS1500",
                uploadType: "cms1500",
                importDocument: buildImportDocument({
                  kind: "cms1500",
                  sha256,
                  fileName: originalname,
                  pageCount,
                  extractionMethod: "CMS1500 template (text layer)",
                  groups,
                  extractionFallback: cms1500TextFallback ? "The form layout could not be read, so plain page text was used (fallback). Columns can shift \u2014 check dates, CPT codes, modifiers and units against the form." : null
                })
              });
              return;
            }
          }
          if (!isPdf) {
            res.status(422).json({ error: "CMS1500 uploads must be PDF files." });
            return;
          }
          if (!pageCount) {
            res.status(500).json({ error: "The PDF opened but its pages could not be counted. Nothing was saved. Try again." });
            return;
          }
          if (pageCount > MAX_SCANNED_PAGES) {
            res.status(422).json({ error: `This scan has ${pageCount} pages. Split it into files of at most ${MAX_SCANNED_PAGES} pages and upload them together under Bulk Upload \u2192 CMS1500 \u2192 Upload CMS1500 PDFs.` });
            return;
          }
          try {
            console.log(`[ClaimUpload] Stage 5/7 \u2014 CMS1500 page vision: ${pageCount} page(s), no usable text layer`);
            const { pages, missingPages, method } = await extractCms1500PagesWithVision(buffer, originalname, pageCount);
            const assembled = assembleCms1500Pages(pages, pageCount, missingPages);
            const lineCount = assembled.groups.reduce((n, g) => n + g.lines.length, 0);
            console.log(`[ClaimUpload] Stage 7/7 \u2014 Review pending: ${lineCount} CMS1500 line(s) from ${pages.length}/${pageCount} page(s) in ${assembled.groups.length} group(s)`);
            if (lineCount === 0) {
              res.status(422).json({ error: "No CMS1500 service lines could be read from this file." });
              return;
            }
            const warnings = [...assembled.warnings];
            if (mixedPages) {
              warnings.unshift(`Page(s) ${textlessPages.join(", ")} of ${pageCount} are scanned images inside a text PDF, so every page was read with document OCR instead of the text template.`);
            }
            res.json({
              claims: [],
              patientGroups: null,
              extractedLength: extractedText.length,
              templateUsed: "CMS1500 (scanned, page vision)",
              uploadType: "cms1500",
              importDocument: buildImportDocument({
                kind: "cms1500",
                sha256,
                fileName: originalname,
                pageCount,
                extractionMethod: `CMS1500 page vision, ${method === "rendered_pages" ? "each page read twice" : "whole-PDF fallback"} (${pages.length}/${pageCount} pages read)`,
                groups: assembled.groups,
                warnings,
                extractionFallback: method === "whole_pdf" ? "The pages could not be rendered as images, so the whole PDF was sent to the document reader at once (fallback). Check every line against the form before saving." : null
              })
            });
          } catch (visionError) {
            console.error("[ClaimUpload] CMS1500 page vision failed:", visionError instanceof Error ? visionError.message : visionError);
            res.status(502).json({ error: "The scanned CMS1500 could not be read by the document reader. Nothing was saved \u2014 try again." });
          }
          return;
        }
        const eobPageCount = !isXlsx && !isCsv ? await getPdfPageCount(buffer) : null;
        const eobTextless = !isXlsx && !isCsv ? await getPdfPagesWithoutText(buffer) : null;
        const eobMixed = isMixedTextAndScanned(eobTextless, eobPageCount);
        const eobMixedWarning = eobMixed ? [`Page(s) ${eobTextless.join(", ")} of ${eobPageCount} are scanned images inside a text PDF, so the whole file was read with AI document vision instead of a text template.`] : [];
        const eobDocument = (groups, extractionMethod, extra = {}) => buildImportDocument({ kind: "eob", sha256, fileName: originalname, pageCount: eobPageCount, extractionMethod, groups: eobGroupsFromClaims(groups), ...extra });
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
          templateResult = eobMixed ? null : tryTemplateExtraction(reimbursementText, originalname);
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
            reimbursementReviewNeeded: reimbursementReviewNeeded.length > 0 ? reimbursementReviewNeeded : void 0,
            importDocument: eobDocument(
              templateResult.patientGroups && templateResult.patientGroups.length > 0 ? templateResult.patientGroups : groupFlatClaimsByPatient(templateResult.claims),
              templateResult.templateName
            )
          });
          return;
        }
        try {
          const reimbursementSource = reimbursementText.trim() && !eobMixed ? { kind: "text", text: reimbursementText } : { kind: "pdf", buffer, filename: originalname };
          const aiExtra = {
            warnings: eobMixedWarning,
            extractionFallback: reimbursementSource.kind === "pdf" ? "No text layer could be used, so the whole PDF was read by AI document vision (fallback) instead of a known EOB template. Check every amount, and that every page's lines appear below, before saving." : "No known EOB template matched this file, so its lines were read by AI (fallback). Check every amount before saving."
          };
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
              extractionNotes: aiResult.extractionNotes,
              importDocument: eobDocument(groupFlatClaimsByPatient(aiResult.claims), `AI (${aiResult.detectedInsurer || "Unknown"})`, aiExtra)
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
            extractionNotes: aiResult.extractionNotes ?? "No service line data was found for this patient in the document.",
            importDocument: eobDocument([], `AI (${aiResult.detectedInsurer || "Unknown"})`, aiExtra)
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
        res.json({
          claims,
          extractedLength: extractedText.length,
          templateUsed: "AI Extraction (Legacy)",
          uploadType: "reimbursement",
          // The legacy extractor has no per-claim patient attribution, so its
          // lines form one group with no name: a reviewer must confirm the
          // patient explicitly before anything from it can be saved.
          importDocument: eobDocument([{ patientName: null, claims }], "AI Extraction (Legacy)", {
            warnings: [
              ...eobMixed ? [`Page(s) ${eobTextless.join(", ")} of ${eobPageCount} are scanned images and were NOT read by this fallback. Upload the file again when the document reader is available, or enter those lines manually.`] : [],
              ...extractedText.length > LEGACY_TEXT_LIMIT ? [`This file is long: only the first ${LEGACY_TEXT_LIMIT.toLocaleString("en-US")} of ${extractedText.length.toLocaleString("en-US")} characters were read by this fallback. Lines further into the file may be missing \u2014 split the file and upload the parts.`] : []
            ],
            extractionFallback: "The AI document reader failed, so a basic legacy extractor was used (fallback). It cannot tell patients apart \u2014 confirm the patient and check every line and amount before saving."
          })
        });
      } catch (err) {
        console.error("[ClaimUpload] Error:", err);
        res.status(500).json({ error: err.message ?? "Failed to process file." });
      }
    }
  );
  app2.use(router2);
}

// server/routers.ts
import { z as z7 } from "zod";
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
var claimsAccessProcedure = normalProtectedProcedure.use(async (opts) => {
  const { ctx, next } = opts;
  if (!canAccessClaims(ctx.user)) {
    throw new TRPCError2({ code: "FORBIDDEN", message: CLAIMS_ACCESS_DENIED_ERR_MSG });
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

// server/_core/superAdmin.ts
function isSuperAdmin(user) {
  return !!user && !user.clinicUser && user.role === "admin";
}

// server/claimsRedaction.ts
var VISIT_FINANCIAL_FIELDS = ["totalInsuranceReimbursement", "totalPatientDue", "totalPatientPaid"];
var RESTRICTED_AUDIT_KEYS = /* @__PURE__ */ new Set([
  // P4-P28: which claim file created a patient.
  "source_kind",
  "source_file",
  "claims_status",
  "total_insurance_reimbursement",
  "total_patient_due",
  "total_patient_paid"
]);
function redactVisitRecord(visit, claimsAllowed) {
  if (claimsAllowed) return visit;
  const { totalInsuranceReimbursement: _r, totalPatientDue: _d, totalPatientPaid: _p, ...rest } = visit;
  return rest;
}
function redactPatient(patient, claimsAllowed) {
  if (claimsAllowed) return patient;
  const { claimsStatus: _c, ...rest } = patient;
  return rest;
}
var CLAIM_AUDIT_ENTITY_TYPES = ["claim_record", "pending_eob_line"];
var CLAIM_AUDIT_ACTION_PREFIXES = ["CLAIM", "EOB_LINE", "PATIENT_EXTERNAL_ID"];
function isClaimAuditRow(row) {
  return CLAIM_AUDIT_ENTITY_TYPES.includes(row.entityType) || CLAIM_AUDIT_ACTION_PREFIXES.some((p) => row.action.toUpperCase().startsWith(p));
}
function stripRestrictedKeys(data) {
  if (!data) return data;
  const out = {};
  for (const [key2, value] of Object.entries(data)) {
    if (RESTRICTED_AUDIT_KEYS.has(key2)) continue;
    if (key2 === "retained_references" && value && typeof value === "object") {
      const { claims: _claims, ...counts } = value;
      out[key2] = counts;
      continue;
    }
    out[key2] = value;
  }
  return out;
}
function redactAuditRows(rows, claimsAllowed) {
  if (claimsAllowed) return rows;
  const out = [];
  for (const row of rows) {
    if (isClaimAuditRow(row)) continue;
    const beforeData = stripRestrictedKeys(row.beforeData);
    const afterData = stripRestrictedKeys(row.afterData);
    const hadData = row.beforeData !== null || row.afterData !== null;
    const isEmpty = (beforeData === null || Object.keys(beforeData).length === 0) && (afterData === null || Object.keys(afterData).length === 0);
    if (hadData && isEmpty) continue;
    out.push({ ...row, beforeData, afterData });
  }
  return out;
}

// shared/sessionWorkflowFields.ts
import { z as z2 } from "zod";
var ASSIGNMENT_OF_BENEFITS_VALUES = ["yes", "no"];
var SUBMISSION_STATUS_VALUES = ["ready_to_file", "hold", "do_not_file"];
var SESSION_REMARKS_MAX_LENGTH = 2e3;
var sessionWorkflowFieldsInput = z2.object({
  assignmentOfBenefits: z2.enum(ASSIGNMENT_OF_BENEFITS_VALUES).nullable().optional(),
  submissionStatus: z2.enum(SUBMISSION_STATUS_VALUES).nullable().optional(),
  // Whitespace-only remarks are stored as NULL (cleared) rather than as an
  // invisible non-empty value.
  remarks: z2.string().max(SESSION_REMARKS_MAX_LENGTH, `Remarks must be ${SESSION_REMARKS_MAX_LENGTH} characters or fewer`).transform((v) => v.trim() === "" ? null : v).nullable().optional()
});

// server/routers.ts
init_db();

// server/claimImport.ts
import { z as z3 } from "zod";
import { randomUUID } from "crypto";
init_db();
var isoDate = z3.string().regex(/^\d{4}-\d{2}-\d{2}$/);
var key = z3.string().regex(CLAIM_IMPORT_KEY_RE);
var money = z3.number().finite().min(-1e7).max(1e7).nullable();
var shortText = (max) => z3.string().trim().max(max).nullable();
var documentInput = z3.object({
  sha256: z3.string().regex(SHA256_RE),
  fileName: z3.string().max(255),
  pageCount: z3.number().int().min(1).max(500).nullable()
});
var lineIdentity = {
  sourceLineKey: key,
  dateOfService: isoDate.nullable(),
  cptCodes: shortText(20),
  modifier: shortText(40),
  unitsBilled: z3.number().int().min(1).max(999).nullable()
};
var cms1500LineInput = z3.object({
  ...lineIdentity,
  placeOfService: shortText(10),
  diagnosisCodes: shortText(200),
  claimSubmittedDate: isoDate.nullable(),
  insuranceBilled: shortText(60),
  visitNumber: z3.number().int().min(1).max(1e4).nullable().optional(),
  unreadable: z3.array(z3.string().max(40)).max(20)
});
var CLAIM_STATUSES = CLAIM_IMPORT_STATUSES;
var eobLineInput = z3.object({
  ...lineIdentity,
  chargeAmount: money,
  insuranceReimbursement: money,
  patientAmountDue: money,
  patientAmountPaid: money,
  claimStatus: z3.enum(CLAIM_STATUSES).nullable(),
  oaClaimNumber: shortText(80),
  checkDate: isoDate.nullable(),
  checkNumberVirtualCard: shortText(80)
});
var patientIdentityInput = z3.object({
  sourceSystem: z3.literal(CMS1500_BOX26_SOURCE_SYSTEM),
  externalId: z3.string().trim().min(1).max(200).nullable(),
  // A client request can only ever carry the weak kind; a CSV export's id is re-read from the file.
  strength: z3.literal("account"),
  birthDate: isoDate.nullable()
});
var createPatientRequest = z3.object({
  name: z3.string().trim().min(1).max(200),
  /** The reviewer saw a same-name or conflicting record and says this is someone else. */
  distinctConfirmed: z3.boolean().optional()
});
var groupBase = {
  groupKey: key,
  patientName: shortText(200),
  /** Reviewer's patient choice; re-validated against the allowed set. */
  patientId: z3.string().uuid().nullable().optional(),
  patientIdentity: patientIdentityInput.nullable().optional(),
  createPatient: createPatientRequest.nullable().optional()
};
var MAX_GROUPS = 100;
var MAX_LINES = 500;
var importPreviewInput = z3.discriminatedUnion("kind", [
  z3.object({
    kind: z3.literal("cms1500"),
    document: documentInput,
    contextPatientId: z3.string().uuid().nullable().optional(),
    groups: z3.array(z3.object({ ...groupBase, lines: z3.array(cms1500LineInput).max(MAX_LINES) })).min(1).max(MAX_GROUPS)
  }),
  z3.object({
    kind: z3.literal("eob"),
    document: documentInput,
    contextPatientId: z3.string().uuid().nullable().optional(),
    groups: z3.array(z3.object({ ...groupBase, lines: z3.array(eobLineInput).max(MAX_LINES) })).min(1).max(MAX_GROUPS)
  })
]);
var cms1500Decision = z3.object({
  action: z3.enum(["create", "create_distinct", "associate", "skip"]),
  claimRecordId: z3.string().uuid().nullable().optional(),
  authPeriod: z3.number().int().min(1).max(1e3).nullable().optional(),
  periodSource: z3.enum(["resolved", "selected", "context"]).nullable().optional(),
  acknowledgeFlags: z3.boolean().optional()
});
var eobDecision = z3.object({
  /** hold (P4-P28): keep this reviewed line pending until its CMS1500 line exists. */
  action: z3.enum(["apply", "skip", "hold"]),
  claimRecordId: z3.string().uuid().nullable().optional(),
  confirmReplace: z3.boolean().optional(),
  /** P4-P28: the reviewer knows this line was dismissed earlier and is bringing it back. */
  reopenDismissed: z3.boolean().optional()
});
var importCommitInput = z3.discriminatedUnion("kind", [
  z3.object({
    kind: z3.literal("cms1500"),
    document: documentInput,
    contextPatientId: z3.string().uuid().nullable().optional(),
    contextAuthPeriod: z3.number().int().min(1).max(1e3).nullable().optional(),
    groups: z3.array(z3.object({
      ...groupBase,
      patientConfirmed: z3.boolean().optional(),
      /** Every line key this group was extracted with (not just the ones being retried). */
      allLineKeys: z3.array(key).max(MAX_LINES),
      lines: z3.array(cms1500LineInput.extend({ decision: cms1500Decision })).max(MAX_LINES)
    })).min(1).max(MAX_GROUPS)
  }),
  z3.object({
    kind: z3.literal("eob"),
    document: documentInput,
    contextPatientId: z3.string().uuid().nullable().optional(),
    contextAuthPeriod: z3.number().int().min(1).max(1e3).nullable().optional(),
    groups: z3.array(z3.object({
      ...groupBase,
      patientConfirmed: z3.boolean().optional(),
      allLineKeys: z3.array(key).max(MAX_LINES),
      lines: z3.array(eobLineInput.extend({ decision: eobDecision })).max(MAX_LINES)
    })).min(1).max(MAX_GROUPS)
  })
]);
function linePeriod(visits, key2, dateOfService, hints) {
  const fp = hints.filePeriods?.[key2];
  return fp != null ? resolveAuthPeriodWithFilePeriod(visits, dateOfService, fp) : resolveAuthPeriod(visits, dateOfService);
}
function classifyEob(line, documentId, existing, hints) {
  const target = hints.eobTargets?.[line.sourceLineKey];
  return target ? classifyEobLineForTarget({ line, documentId, existing, target }) : classifyEobLine({ line, documentId, existing });
}
function resolveGroupPatient(params) {
  const { patientName, requestedPatientId, contextPatient, allPatients } = params;
  const pick = (allowed) => requestedPatientId && allowed.includes(requestedPatientId) ? requestedPatientId : null;
  const nameOf = (id) => id ? allPatients.find((p) => p.id === id)?.name ?? contextPatient?.name ?? null : null;
  if (contextPatient) {
    const allowed = [contextPatient.id];
    if (!patientName) {
      const id = pick(allowed);
      return { status: "unreadable", patientId: id, patientName: nameOf(id), candidates: [contextPatient], allowedIds: allowed, requiresConfirmation: true };
    }
    if (fuzzyNameMatch(patientName, contextPatient.name)) {
      return { status: "matched", patientId: contextPatient.id, patientName: contextPatient.name, candidates: [], allowedIds: allowed, requiresConfirmation: false };
    }
    const { candidates: candidates2 } = classifyPatientMatch(patientName, [contextPatient]);
    if (candidates2.length > 0) {
      const id = pick(allowed);
      return { status: "candidates", patientId: id, patientName: nameOf(id), candidates: [contextPatient], allowedIds: allowed, requiresConfirmation: true };
    }
    return { status: "other_patient", patientId: null, patientName: null, candidates: [], allowedIds: [], requiresConfirmation: false };
  }
  if (!patientName) {
    const allowed = allPatients.map((p) => p.id);
    const id = pick(allowed);
    return { status: "unreadable", patientId: id, patientName: nameOf(id), candidates: [], allowedIds: allowed, requiresConfirmation: true };
  }
  const { confirmed, candidates } = classifyPatientMatch(patientName, allPatients);
  if (confirmed) {
    return { status: "matched", patientId: confirmed.id, patientName: confirmed.name, candidates: [], allowedIds: [confirmed.id], requiresConfirmation: false };
  }
  if (candidates.length > 0) {
    const allowed = candidates.map((c) => c.id);
    const id = pick(allowed);
    return {
      status: "candidates",
      patientId: id,
      patientName: nameOf(id),
      candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
      allowedIds: allowed,
      requiresConfirmation: true
    };
  }
  return { status: "unmatched", patientId: null, patientName: null, candidates: [], allowedIds: [], requiresConfirmation: false };
}
function nameClusterKey(name) {
  return (name ?? "").toUpperCase().replace(/['’]/g, "").split(/[^A-Z0-9]+/).filter(Boolean).sort().join(" ");
}
function resolveImportPatient(params) {
  return { ...resolvePatientFromEvidence(params), fileBirthDate: params.identity?.birthDate ?? null };
}
function resolvePatientFromEvidence(params) {
  const { patientName, requestedPatientId, createRequest, allPatients, externalIds } = params;
  let identity = params.identity ?? null;
  const pick = (allowed) => requestedPatientId && allowed.includes(requestedPatientId) ? requestedPatientId : null;
  const nameOf = (id) => id ? allPatients.find((p) => p.id === id)?.name ?? null : null;
  const reasons = identity?.conflict ? [identity.conflict] : [];
  const birthConflict = (patientId) => !!identity?.birthDate && externalIds.some((e) => e.patientId === patientId && e.birthDate && e.birthDate !== identity.birthDate);
  const BIRTH_REASON = "The birth date in this file differs from the one recorded for this patient by an earlier import.";
  const noBirthBaseline = (patient) => !!identity?.birthDate && !externalIds.some((e) => e.patientId === patient.id && e.birthDate);
  const noBaselineReason = (patient) => `${patient.name} has no birth date on record yet. Confirm that ${identity.birthDate} is this patient's; later imports are checked against it.`;
  const mapped = identity?.externalId ? externalIds.find((e) => e.sourceSystem === identity.sourceSystem && e.externalId === identity.externalId) : void 0;
  const mappedPatient = mapped ? allPatients.find((p) => p.id === mapped.patientId) : void 0;
  if (mapped && mappedPatient && identity.strength === "account" && patientName && !fuzzyNameMatch(patientName, mappedPatient.name)) {
    identity = { ...identity, externalId: null };
  } else if (mappedPatient) {
    const clusterKey2 = `id:${identity.sourceSystem}:${identity.externalId}`;
    if (birthConflict(mappedPatient.id)) reasons.push(BIRTH_REASON);
    else if (identity.strength === "account" && noBirthBaseline(mappedPatient)) reasons.push(noBaselineReason(mappedPatient));
    if (patientName && !fuzzyNameMatch(patientName, mappedPatient.name)) reasons.push(`This file's patient ID belongs to ${mappedPatient.name}, but the file says ${patientName}.`);
    if (reasons.length === 0) {
      return { status: "matched", patientId: mappedPatient.id, patientName: mappedPatient.name, candidates: [], allowedIds: [mappedPatient.id], requiresConfirmation: false, identityStatus: "existing", identityReasons: [], canCreate: false, creatingName: null, linkExternalId: null, clusterKey: clusterKey2 };
    }
    const id = pick([mappedPatient.id]);
    return { status: "candidates", patientId: id, patientName: nameOf(id), candidates: [{ id: mappedPatient.id, name: mappedPatient.name }], allowedIds: [mappedPatient.id], requiresConfirmation: true, identityStatus: "needs_confirmation", identityReasons: reasons, canCreate: false, creatingName: null, linkExternalId: null, clusterKey: clusterKey2 };
  }
  const clusterKey = identity?.externalId ? `id:${identity.sourceSystem}:${identity.externalId}` : `name:${nameClusterKey(patientName)}`;
  const link = (patientId) => patientId && identity?.externalId ? { sourceSystem: identity.sourceSystem, externalId: identity.externalId, birthDate: identity.birthDate } : null;
  const creatingIdentity = identity ? { sourceSystem: identity.sourceSystem, externalId: identity.externalId, birthDate: identity.birthDate } : null;
  const creating = (status) => {
    if (!createRequest) return null;
    return { status, patientId: null, patientName: null, candidates: [], allowedIds: [], requiresConfirmation: false, identityStatus: "new", identityReasons: [], canCreate: true, creatingName: createRequest.name, creatingIdentity, linkExternalId: null, clusterKey };
  };
  if (!patientName) {
    const allowed = allPatients.map((p) => p.id);
    const id = pick(allowed);
    if (!id) {
      const c = creating("unreadable");
      if (c) return c;
    }
    if (id && birthConflict(id)) reasons.push(BIRTH_REASON);
    return { status: "unreadable", patientId: id, patientName: nameOf(id), candidates: [], allowedIds: allowed, requiresConfirmation: true, identityStatus: "needs_confirmation", identityReasons: [...reasons, "The patient's name could not be read from the file."], canCreate: true, creatingName: null, linkExternalId: link(id), clusterKey };
  }
  const classified = classifyPatientMatch(patientName, allPatients);
  const sameTokens = allPatients.filter((p) => nameClusterKey(p.name) === nameClusterKey(patientName));
  const confirmed = sameTokens.length > 1 ? null : classified.confirmed;
  const candidates = sameTokens.length > 1 ? sameTokens : classified.candidates;
  if (confirmed) {
    const strongId = identity?.strength === "patient" && identity.externalId;
    if (birthConflict(confirmed.id)) reasons.push(BIRTH_REASON);
    else if (!strongId && noBirthBaseline(confirmed)) reasons.push(noBaselineReason(confirmed));
    if (strongId) {
      const other = externalIds.find((e) => e.patientId === confirmed.id && e.sourceSystem === identity.sourceSystem);
      reasons.push(other ? `${confirmed.name} already has a different patient ID from this system, so this may be a different person with the same name.` : `${confirmed.name} is matched by name only. Confirm this is the same person; later imports with this patient ID then match automatically.`);
    }
    if (reasons.length === 0) {
      return { status: "matched", patientId: confirmed.id, patientName: confirmed.name, candidates: [], allowedIds: [confirmed.id], requiresConfirmation: false, identityStatus: "existing", identityReasons: [], canCreate: false, creatingName: null, linkExternalId: link(confirmed.id), clusterKey };
    }
    if (createRequest?.distinctConfirmed) {
      const c = creating("candidates");
      if (c) return c;
    }
    const id = pick([confirmed.id]);
    return { status: "candidates", patientId: id, patientName: nameOf(id), candidates: [{ id: confirmed.id, name: confirmed.name }], allowedIds: [confirmed.id], requiresConfirmation: true, identityStatus: "needs_confirmation", identityReasons: reasons, canCreate: true, creatingName: null, linkExternalId: link(id), clusterKey };
  }
  if (candidates.length > 0) {
    if (createRequest?.distinctConfirmed) {
      const c = creating("candidates");
      if (c) return c;
    }
    const differing = candidates.filter((c) => birthConflict(c.id));
    if (differing.length > 0) reasons.push(`The birth date in this file differs from the one recorded for ${differing.map((c) => c.name).join(", ")}.`);
    const allowed = candidates.map((c) => c.id);
    const id = pick(allowed);
    return {
      status: "candidates",
      patientId: id,
      patientName: nameOf(id),
      candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
      allowedIds: allowed,
      requiresConfirmation: true,
      identityStatus: "needs_confirmation",
      identityReasons: [...reasons, candidates.length > 1 ? "More than one patient has a matching name." : "A patient with a similar name exists."],
      canCreate: true,
      creatingName: null,
      linkExternalId: link(id),
      clusterKey
    };
  }
  if (reasons.length > 0 && !createRequest?.distinctConfirmed) {
    return { status: "unmatched", patientId: null, patientName: null, candidates: [], allowedIds: [], requiresConfirmation: true, identityStatus: "needs_confirmation", identityReasons: reasons, canCreate: true, creatingName: null, linkExternalId: null, clusterKey };
  }
  return creating("unmatched") ?? { status: "unmatched", patientId: null, patientName: null, candidates: [], allowedIds: [], requiresConfirmation: false, identityStatus: "new", identityReasons: [], canCreate: true, creatingName: patientName, creatingIdentity, linkExternalId: null, clusterKey };
}
async function loadPatients(contextPatientId, roster) {
  const allPatients = roster ?? (await getAllPatients()).map((p) => ({ id: p.id, name: p.name }));
  const contextPatient = contextPatientId ? allPatients.find((p) => p.id === contextPatientId) ?? null : null;
  if (contextPatientId && !contextPatient) throw new ClaimImportRuleError("not_found", "The selected patient no longer exists.");
  return { allPatients, contextPatient };
}
function patientFor(group, contextPatient, allPatients, hints, externalIds) {
  if (contextPatient) {
    const base = resolveGroupPatient({ patientName: group.patientName, requestedPatientId: group.patientId, contextPatient, allPatients });
    return { ...base, identityStatus: base.status === "matched" ? "existing" : base.status === "other_patient" ? null : "needs_confirmation", identityReasons: [], canCreate: false, creatingName: null, linkExternalId: null, clusterKey: `name:${nameClusterKey(group.patientName)}` };
  }
  return resolveImportPatient({
    patientName: group.patientName,
    identity: hints.fileIdentity ?? group.patientIdentity,
    requestedPatientId: group.patientId,
    createRequest: group.createPatient,
    allPatients,
    externalIds
  });
}
async function previewClaimImport(input, hints = {}) {
  const { allPatients, contextPatient } = await loadPatients(input.contextPatientId, hints.roster);
  const documentId = await findClaimImportDocumentId(input.kind, input.document.sha256);
  const externalIds = contextPatient ? [] : hints.externalIds ?? await listPatientExternalIds();
  const heldKeys = input.kind === "eob" && documentId ? new Set(await listHeldEobLineKeys(documentId)) : /* @__PURE__ */ new Set();
  const savedInDocument = hints.strictLineIdentity && documentId ? await listClaimLinesForDocument(documentId) : [];
  const groups = [];
  for (const group of input.groups) {
    const patient = patientFor(group, contextPatient, allPatients, hints, externalIds);
    if (patient.creatingName) {
      let lines2;
      if (input.kind === "cms1500") {
        const g = group;
        const siblings = g.lines.map((l) => l.sourceLineKey);
        lines2 = g.lines.map((l) => {
          const c = classifyCms1500Line({ line: l, documentId, siblingLineKeys: siblings, existing: [], period: linePeriod([], l.sourceLineKey, l.dateOfService, hints) });
          return { sourceLineKey: l.sourceLineKey, kind: "cms1500", ...hints.strictLineIdentity ? classifyExportLine({ classification: c, line: l, patientId: null, siblingLineKeys: siblings, savedInDocument }) : c };
        });
      } else {
        lines2 = group.lines.map((l) => ({ sourceLineKey: l.sourceLineKey, kind: "eob", ...classifyEob(l, documentId, [], hints) }));
      }
      groups.push({ groupKey: group.groupKey, patient, lines: lines2, periodOptions: periodOptionsFor([]) });
      continue;
    }
    if (!patient.patientId) {
      groups.push({
        groupKey: group.groupKey,
        patient,
        periodOptions: [],
        lines: group.lines.map((l) => ({
          sourceLineKey: l.sourceLineKey,
          kind: input.kind,
          status: "patient_required",
          candidates: [],
          reason: patient.status === "other_patient" ? "This part of the file names a different patient. Upload it from that patient's page or with the bulk upload." : patient.status === "unmatched" ? "No dashboard patient matches this name." : "Confirm which patient this belongs to."
        }))
      });
      continue;
    }
    const existing = await listPatientClaimLinesOnDates(patient.patientId, group.lines.map((l) => l.dateOfService ?? ""));
    let periodOptions = [];
    let lines;
    if (input.kind === "cms1500") {
      const visits = await listPatientVisitPeriodDates(patient.patientId);
      periodOptions = periodOptionsFor(visits);
      const g = group;
      const siblings = g.lines.map((l) => l.sourceLineKey);
      lines = g.lines.map((l) => {
        const c = classifyCms1500Line({ line: l, documentId, siblingLineKeys: siblings, existing, period: linePeriod(visits, l.sourceLineKey, l.dateOfService, hints) });
        return {
          sourceLineKey: l.sourceLineKey,
          kind: "cms1500",
          ...hints.strictLineIdentity ? classifyExportLine({ classification: c, line: l, patientId: patient.patientId, siblingLineKeys: siblings, savedInDocument }) : c
        };
      });
    } else {
      const dismissed = await listDismissedEobLines(patient.patientId);
      lines = group.lines.map((l) => {
        const c = classifyEob(l, documentId, existing, hints);
        const dismissedLine = c.status !== "already_saved" && findDismissedEobLine(l, documentId, dismissed);
        return {
          sourceLineKey: l.sourceLineKey,
          kind: "eob",
          ...c,
          // Saved as pending by an earlier upload of this file and still waiting.
          ...c.status === "cms1500_required" && heldKeys.has(l.sourceLineKey) ? { held: true } : {},
          ...dismissedLine ? { dismissed: true, reason: c.reason ? `${EOB_LINE_DISMISSED} ${c.reason}` : EOB_LINE_DISMISSED } : {}
        };
      });
    }
    groups.push({ groupKey: group.groupKey, patient, lines, periodOptions });
  }
  return { documentId, groups };
}
function periodOptionsFor(visits) {
  const set = Array.from(new Set(visits.map((v) => v.authPeriod))).sort((a, b) => a - b);
  return set.length > 0 ? set : [1];
}
var REVIEW_MESSAGES = {
  needs_selection: "An existing claim line already sits on this date and CPT. Choose to associate with it or save as a separate line.",
  cms1500_required: UPLOAD_CMS1500_FIRST,
  already_reconciled: "This claim line already has a payment from another EOB line. Confirm replacing it.",
  source_line_already_saved: "This source line is already saved to a different claim line.",
  already_has_cms1500: "That claim line already has a CMS1500 line associated.",
  incompatible: "The chosen claim line has a different date of service or CPT.",
  existing_financials: "The chosen claim line already has different amounts. Confirm replacing them.",
  patient_mismatch: "The chosen claim line belongs to a different patient.",
  not_found: "The chosen claim line no longer exists.",
  invalid_input: "This line is missing required values.",
  period_required: "Choose the authorization period for this date of service.",
  patient_changed: "A patient with this name was added after this review opened. Check the patient and save again.",
  external_id_taken: "This file's patient ID is already linked to a different patient. Check the patient and save again.",
  pending_not_needed: "This line no longer needs to wait: a saved claim line already carries it.",
  line_dismissed: EOB_LINE_DISMISSED
};
function reviewResult(sourceLineKey, reason, message) {
  return { sourceLineKey, status: "review_required", reason, message: message ?? REVIEW_MESSAGES[reason] ?? reason };
}
async function writeLine(sourceLineKey, write) {
  try {
    const r = await write();
    if (r.status === "unchanged") return { sourceLineKey, status: "unchanged", claimId: r.claimId, authPeriod: r.authPeriod };
    return { sourceLineKey, status: "saved", outcome: r.status, claimId: r.claimId, authPeriod: r.authPeriod };
  } catch (err) {
    if (err instanceof ClaimImportRuleError) return reviewResult(sourceLineKey, err.reason);
    console.error("[ClaimImport] line write failed:", err);
    return { sourceLineKey, status: "failed", reason: "error", message: "Could not save this line. Nothing was changed for it \u2014 retry." };
  }
}
function decideAuthPeriod(params) {
  const { resolution, allowedPeriods, requested, source } = params;
  if (resolution.status === "resolved") {
    if (requested == null || requested === resolution.authPeriod) return { ok: true, authPeriod: resolution.authPeriod };
    if (source === "selected" && allowedPeriods.includes(requested)) return { ok: true, authPeriod: requested };
    return { ok: false, reason: "period_mismatch" };
  }
  if (requested != null && (source === "selected" || source === "context") && allowedPeriods.includes(requested)) {
    return { ok: true, authPeriod: requested };
  }
  return { ok: false, reason: "period_required" };
}
function holdPayload(line) {
  return {
    match: { date_of_service: line.dateOfService, cpt_codes: line.cptCodes, modifier: line.modifier, units_billed: line.unitsBilled },
    data: eobFinancials(line)
  };
}
function eobFinancials(line) {
  return {
    charge_amount: line.chargeAmount,
    insurance_reimbursement: line.insuranceReimbursement,
    payment_received: line.insuranceReimbursement,
    patient_amount_due: line.patientAmountDue,
    patient_amount_paid: line.patientAmountPaid,
    claim_status: line.claimStatus,
    oa_claim_number: line.oaClaimNumber,
    check_date: line.checkDate,
    check_number_virtual_card: line.checkNumberVirtualCard
  };
}
function holdTarget(sourceLineKey, hints) {
  const t2 = hints.eobTargets?.[sourceLineKey];
  if (!t2) return null;
  return { cms1500_sha256: t2.cms1500Ref?.sha256 ?? null, line_key: t2.cms1500Ref?.lineKey ?? null, label: t2.cms1500Ref?.label ?? null, auth_period: t2.authPeriod ?? null };
}
async function commitNewPatientGroup(params) {
  const { input, group, patient, actor, importBatchId, source, hints, allPatients, externalIds } = params;
  const identity = patient.creatingIdentity ?? null;
  const results = [];
  const rpcLines = [];
  if (input.kind === "cms1500") {
    const g = group;
    const documentId = hints.strictLineIdentity ? await findClaimImportDocumentId("cms1500", input.document.sha256) : null;
    const foreign = documentId ? (await listClaimLinesForDocument(documentId)).filter((r) => allPatients.some((p) => p.id === r.patientId)) : [];
    for (const line of g.lines) {
      const d = line.decision;
      if (d.action === "skip") {
        results.push({ sourceLineKey: line.sourceLineKey, status: "skipped" });
        continue;
      }
      const problem = exportLineIdentityProblem({ line, patientId: null, siblingLineKeys: g.allLineKeys, savedInDocument: foreign });
      if (problem) {
        results.push(reviewResult(line.sourceLineKey, "line_identity_review", problem));
        continue;
      }
      if (!line.dateOfService || !line.cptCodes) {
        results.push(reviewResult(line.sourceLineKey, "invalid_input"));
        continue;
      }
      if (line.unreadable.length > 0 && !d.acknowledgeFlags) {
        results.push(reviewResult(line.sourceLineKey, "flags_unacknowledged", "This line has unreadable values left blank. Review and acknowledge them before saving."));
        continue;
      }
      const decided = decideAuthPeriod({ resolution: linePeriod([], line.sourceLineKey, line.dateOfService, hints), allowedPeriods: periodOptionsFor([]), requested: d.authPeriod, source: d.periodSource });
      if (!decided.ok) {
        results.push(reviewResult(line.sourceLineKey, "period_required", "A new patient has no authorization periods yet. Choose the period for this line."));
        continue;
      }
      rpcLines.push({
        line_key: line.sourceLineKey,
        auth_period: decided.authPeriod,
        data: {
          date_of_service: line.dateOfService,
          cpt_codes: line.cptCodes,
          place_of_service: line.placeOfService,
          modifier: line.modifier,
          units_billed: line.unitsBilled,
          diagnosis_codes: line.diagnosisCodes,
          claim_submitted_date: line.claimSubmittedDate,
          insurance_billed: line.insuranceBilled,
          visit_number: line.visitNumber ?? null
        }
      });
    }
  } else {
    const g = group;
    for (const line of g.lines) {
      const d = line.decision;
      if (d.action === "skip") {
        results.push({ sourceLineKey: line.sourceLineKey, status: "skipped" });
        continue;
      }
      if (!line.dateOfService || !line.cptCodes) {
        results.push(reviewResult(line.sourceLineKey, "invalid_input"));
        continue;
      }
      if (d.action !== "hold") {
        results.push(reviewResult(line.sourceLineKey, "cms1500_required"));
        continue;
      }
      rpcLines.push({ line_key: line.sourceLineKey, ...holdPayload(line), target: holdTarget(line.sourceLineKey, hints) });
    }
  }
  if (rpcLines.length === 0) {
    return { result: { groupKey: group.groupKey, patientId: null, patientOutcome: null, lines: results } };
  }
  const siblings = Array.from(/* @__PURE__ */ new Set([...group.allLineKeys, ...rpcLines.map((l) => String(l.line_key))]));
  let created;
  try {
    created = await commitImportWithNewPatient({
      kind: input.kind,
      patientName: patient.creatingName,
      sourceSystem: identity?.externalId ? identity.sourceSystem : null,
      externalId: identity?.externalId ?? null,
      birthDate: identity?.birthDate ?? null,
      creationKey: `${input.kind}:${input.document.sha256}:${group.groupKey}`,
      allowSameName: group.createPatient?.distinctConfirmed === true,
      source,
      siblingLineKeys: siblings,
      lines: rpcLines,
      actor,
      importBatchId
    });
  } catch (err) {
    const message = err instanceof ClaimImportRuleError ? null : "Could not save. Nothing was created for this patient; retry.";
    if (!(err instanceof ClaimImportRuleError)) console.error("[ClaimImport] new patient commit failed:", err);
    return {
      result: {
        groupKey: group.groupKey,
        patientId: null,
        patientOutcome: null,
        lines: [...results, ...rpcLines.map((l) => err instanceof ClaimImportRuleError ? reviewResult(String(l.line_key), err.reason) : { sourceLineKey: String(l.line_key), status: "failed", reason: "error", message })]
      }
    };
  }
  if (created.status === "patient_exists") return { existingPatientId: created.patientId };
  if (!allPatients.some((p) => p.id === created.patientId)) allPatients.push({ id: created.patientId, name: patient.creatingName });
  if (identity?.externalId) externalIds.push({ patientId: created.patientId, sourceSystem: identity.sourceSystem, externalId: identity.externalId, birthDate: identity.birthDate });
  return {
    result: {
      groupKey: group.groupKey,
      patientId: created.patientId,
      patientOutcome: "created",
      lines: [...results, ...created.lines.map((l) => input.kind === "cms1500" ? { sourceLineKey: l.lineKey, status: l.status === "unchanged" ? "unchanged" : "saved", outcome: "created", claimId: l.claimId ?? void 0, authPeriod: l.authPeriod ?? void 0 } : { sourceLineKey: l.lineKey, status: "held", message: UPLOAD_CMS1500_FIRST })]
    }
  };
}
async function commitClaimImport(input, actor, hints = {}) {
  const { allPatients, contextPatient } = await loadPatients(input.contextPatientId, hints.roster);
  const externalIds = contextPatient ? [] : hints.externalIds ?? await listPatientExternalIds();
  const importBatchId = hints.importBatchId ?? randomUUID();
  const source = { sha256: input.document.sha256, fileName: input.document.fileName, pageCount: input.document.pageCount };
  const results = [];
  for (const group of input.groups) {
    let patient = patientFor(group, contextPatient, allPatients, hints, externalIds);
    let patientOutcome = "existing";
    if (patient.creatingName && group.createPatient) {
      const outcome = await commitNewPatientGroup({ input, group, patient, actor, importBatchId, source, hints, allPatients, externalIds });
      if ("result" in outcome) {
        results.push(outcome.result);
        continue;
      }
      if (!allPatients.some((p) => p.id === outcome.existingPatientId)) {
        const fresh = await getAllPatients();
        allPatients.splice(0, allPatients.length, ...fresh.map((p) => ({ id: p.id, name: p.name })));
      }
      const name = allPatients.find((p) => p.id === outcome.existingPatientId)?.name ?? null;
      patient = { status: "matched", patientId: outcome.existingPatientId, patientName: name, candidates: [], allowedIds: [outcome.existingPatientId], requiresConfirmation: false, identityStatus: "existing", identityReasons: [], canCreate: false, creatingName: null, linkExternalId: null, clusterKey: patient.clusterKey };
    }
    const confirmed = patient.patientId && (!patient.requiresConfirmation || group.patientConfirmed === true);
    if (!confirmed) {
      results.push({
        groupKey: group.groupKey,
        patientId: null,
        patientOutcome: null,
        lines: group.lines.map((l) => reviewResult(
          l.sourceLineKey,
          "patient_unconfirmed",
          patient.status === "other_patient" ? "This part of the file names a different patient." : patient.creatingName ? "Save this group again to create the new patient." : "Confirm which patient this belongs to before saving."
        ))
      });
      continue;
    }
    const patientId = patient.patientId;
    const lineResults = [];
    if (group.lines.some((l) => l.decision.action !== "skip")) {
      try {
        if (patient.linkExternalId) {
          await linkPatientExternalId({ patientId, ...patient.linkExternalId, actor, importBatchId });
          externalIds.push({ patientId, ...patient.linkExternalId });
        }
        if (patient.fileBirthDate && !externalIds.some((e) => e.patientId === patientId && e.birthDate)) {
          const evidence = { sourceSystem: BIRTH_EVIDENCE_SOURCE_SYSTEM, externalId: patientId, birthDate: patient.fileBirthDate };
          await linkPatientExternalId({ patientId, ...evidence, actor, importBatchId });
          externalIds.push({ patientId, ...evidence });
        }
      } catch (err) {
        results.push({
          groupKey: group.groupKey,
          patientId: null,
          patientOutcome: null,
          lines: group.lines.map((l) => err instanceof ClaimImportRuleError ? reviewResult(l.sourceLineKey, err.reason) : { sourceLineKey: l.sourceLineKey, status: "failed", reason: "error", message: "Could not save this line. Nothing was changed for it \u2014 retry." })
        });
        continue;
      }
    }
    if (input.kind === "cms1500") {
      const visits = await listPatientVisitPeriodDates(patientId);
      const allowedPeriods = periodOptionsFor(visits);
      const g = group;
      const siblings = Array.from(/* @__PURE__ */ new Set([...g.allLineKeys, ...g.lines.map((l) => l.sourceLineKey)]));
      let savedInDocument = [];
      if (hints.strictLineIdentity) {
        const documentId = await findClaimImportDocumentId("cms1500", input.document.sha256);
        if (documentId) savedInDocument = await listClaimLinesForDocument(documentId);
      }
      for (const line of g.lines) {
        const d = line.decision;
        if (d.action === "skip") {
          lineResults.push({ sourceLineKey: line.sourceLineKey, status: "skipped" });
          continue;
        }
        if (hints.strictLineIdentity) {
          const problem = exportLineIdentityProblem({ line, patientId, siblingLineKeys: siblings, savedInDocument });
          if (problem) {
            lineResults.push(reviewResult(line.sourceLineKey, "line_identity_review", problem));
            continue;
          }
          if (d.action === "create" && changedSavedLines(line, siblings, savedInDocument).length > 0) {
            lineResults.push(reviewResult(line.sourceLineKey, "needs_selection", "A saved line of this invoice with this CPT is no longer in the file, so this may be that line changed. Save this one only if it is a separate service line."));
            continue;
          }
        }
        if (!line.dateOfService || !line.cptCodes) {
          lineResults.push(reviewResult(line.sourceLineKey, "invalid_input"));
          continue;
        }
        if (line.unreadable.length > 0 && !d.acknowledgeFlags) {
          lineResults.push(reviewResult(line.sourceLineKey, "flags_unacknowledged", "This line has unreadable values left blank. Review and acknowledge them before saving."));
          continue;
        }
        if (d.action === "associate" && !d.claimRecordId) {
          lineResults.push(reviewResult(line.sourceLineKey, "needs_selection"));
          continue;
        }
        let authPeriod = null;
        if (d.action !== "associate") {
          const requested = d.authPeriod ?? (d.periodSource === "context" ? input.contextAuthPeriod ?? null : null);
          const resolution = linePeriod(visits, line.sourceLineKey, line.dateOfService, hints);
          if (requested == null) {
            authPeriod = resolution.status === "resolved" ? resolution.authPeriod : null;
          } else {
            const decided = decideAuthPeriod({ resolution, allowedPeriods, requested, source: d.periodSource });
            if (!decided.ok) {
              lineResults.push(reviewResult(line.sourceLineKey, decided.reason, decided.reason === "period_required" ? REVIEW_MESSAGES.period_required : "The chosen period does not match the period this date of service belongs to. Select it explicitly to override."));
              continue;
            }
            authPeriod = decided.authPeriod;
          }
        }
        lineResults.push(await writeLine(line.sourceLineKey, () => commitCms1500Line({
          patientId,
          authPeriod,
          source,
          lineKey: line.sourceLineKey,
          siblingLineKeys: siblings,
          targetClaimId: d.action === "associate" ? d.claimRecordId : null,
          allowNewDistinct: d.action === "create_distinct",
          data: {
            date_of_service: line.dateOfService,
            cpt_codes: line.cptCodes,
            place_of_service: line.placeOfService,
            modifier: line.modifier,
            units_billed: line.unitsBilled,
            diagnosis_codes: line.diagnosisCodes,
            claim_submitted_date: line.claimSubmittedDate,
            insurance_billed: line.insuranceBilled,
            visit_number: line.visitNumber ?? null
          },
          actor,
          importBatchId
        })));
      }
    } else {
      const g = group;
      const hinted = g.lines.some((l) => hints.eobTargets?.[l.sourceLineKey]);
      const holding = g.lines.some((l) => l.decision.action === "hold");
      const existing = hinted || holding ? await listPatientClaimLinesOnDates(patientId, g.lines.map((l) => l.dateOfService ?? "")) : [];
      const documentId = await findClaimImportDocumentId("eob", input.document.sha256);
      const dismissed = await listDismissedEobLines(patientId);
      const dismissedLineFor = (line) => findDismissedEobLine(line, documentId, dismissed);
      const reopen = async (line) => {
        const hit = dismissedLineFor(line);
        if (hit && hit.documentId === documentId && hit.lineKey === line.sourceLineKey) await reopenDismissedEobLine(hit.id, actor, importBatchId);
      };
      for (const line of g.lines) {
        const d = line.decision;
        if (d.action === "skip") {
          lineResults.push({ sourceLineKey: line.sourceLineKey, status: "skipped" });
          continue;
        }
        if (!line.dateOfService || !line.cptCodes) {
          lineResults.push(reviewResult(line.sourceLineKey, "invalid_input"));
          continue;
        }
        if (dismissedLineFor(line) && !d.reopenDismissed) {
          lineResults.push(reviewResult(line.sourceLineKey, "line_dismissed"));
          continue;
        }
        if (d.action === "hold") {
          const c = classifyEob(line, documentId, existing, hints);
          if (c.status !== "cms1500_required") {
            lineResults.push(reviewResult(line.sourceLineKey, "cms1500_available", "A matching CMS1500 line now exists. Re-check this line and apply it."));
            continue;
          }
          try {
            await reopen(line);
            const held = await holdEobLine({ patientId, source, lineKey: line.sourceLineKey, ...holdPayload(line), target: holdTarget(line.sourceLineKey, hints), actor, importBatchId });
            lineResults.push({ sourceLineKey: line.sourceLineKey, status: "held", message: UPLOAD_CMS1500_FIRST, reason: held.status });
          } catch (err) {
            if (err instanceof ClaimImportRuleError) lineResults.push(reviewResult(line.sourceLineKey, err.reason));
            else {
              console.error("[ClaimImport] pending EOB line write failed:", err);
              lineResults.push({ sourceLineKey: line.sourceLineKey, status: "failed", reason: "error", message: "Could not keep this line pending. Nothing was changed for it \u2014 retry." });
            }
          }
          continue;
        }
        if (!d.claimRecordId) {
          lineResults.push(reviewResult(line.sourceLineKey, "cms1500_required"));
          continue;
        }
        if (hints.eobTargets?.[line.sourceLineKey]) {
          const c = classifyEob(line, documentId, existing, hints);
          if (!allowedEobTargets(c).includes(d.claimRecordId)) {
            lineResults.push(c.status === "cms1500_required" || c.status === "invalid" ? reviewResult(line.sourceLineKey, c.status === "invalid" ? "invalid_input" : "cms1500_required", c.reason) : reviewResult(line.sourceLineKey, "target_not_allowed", "The chosen claim line is not one this file row can be applied to. Re-check the file and choose again."));
            continue;
          }
        }
        lineResults.push(await writeLine(line.sourceLineKey, async () => {
          await reopen(line);
          return applyEobLine({
            patientId,
            source,
            lineKey: line.sourceLineKey,
            targetClaimId: d.claimRecordId,
            match: { date_of_service: line.dateOfService, cpt_codes: line.cptCodes },
            confirmReplace: d.confirmReplace === true,
            data: eobFinancials(line),
            actor,
            importBatchId
          });
        }));
      }
    }
    results.push({ groupKey: group.groupKey, patientId, patientOutcome, lines: lineResults });
  }
  return { importBatchId, groups: results };
}

// server/claimCsvImport.ts
import Papa4 from "papaparse";
import { z as z4 } from "zod";
import { randomUUID as randomUUID2 } from "crypto";

// server/cms1500ExportCsv.ts
import { createHash as createHash2 } from "node:crypto";
import Papa3 from "papaparse";
var BILLING_EXPORT_SOURCE_SYSTEM = "billing_invoice_export";
var CPT_RE = /^(?:\d{5}|\d{4}[A-Z]|[A-Z]\d{4})$/;
var ICD10_TOKEN_RE = /^[A-Z]\d[0-9A-Z](?:\.[0-9A-Z]{1,4})?$/;
var AMOUNT_LINE_RE = /^[A-Za-z][A-Za-z /-]*:\s*-?\$?[\d,]+(?:\.\d{1,2})?\s*$/;
var PRICE_SUFFIX_RE = /\s*\(\s*-?\$?[\d,]+(?:\.\d{1,2})?\s*\)\s*$/;
function parseBlockHead(raw) {
  const line = raw.trim();
  const qty = line.match(/^(\d+)\s*[xX×]\s+(.+)$/);
  const body = (qty ? qty[2] : line).trim();
  const coded = body.match(/^([A-Za-z0-9]{5})((?:[\s:-]+[A-Z0-9]{2})*)(?:\s*[-–:]\s+(.*))?$/);
  const code = coded?.[1].toUpperCase();
  if (coded && code && CPT_RE.test(code)) {
    const mods = (coded[2] ?? "").split(/[\s:-]+/).filter(Boolean);
    const units2 = qty ? Number(qty[1]) : null;
    const usable2 = units2 != null && units2 >= 1 && units2 <= 999;
    return {
      units: usable2 ? units2 : null,
      unitsUnreadable: !usable2,
      cpt: code,
      modifiers: mods.length > 0 ? mods.join(", ") : null,
      text: (coded[3] ?? "").replace(PRICE_SUFFIX_RE, "").trim()
    };
  }
  if (!qty && !PRICE_SUFFIX_RE.test(line)) return null;
  const units = qty ? Number(qty[1]) : null;
  const usable = units != null && units >= 1 && units <= 999;
  return { units: usable ? units : null, unitsUnreadable: !usable, cpt: null, modifiers: null, text: body.replace(PRICE_SUFFIX_RE, "").trim() };
}
function diagnosisTokens(raw) {
  const tokens = raw.toUpperCase().split(/[\s,;]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const good = tokens.filter((t2) => ICD10_TOKEN_RE.test(t2));
  return good.length * 2 > tokens.length ? tokens : null;
}
function parseExportDescription(description) {
  const lines = description.split(/\r\n|\n|\r/).map((l) => l.trim()).filter(Boolean);
  const warnings = [];
  let payerLabel = null;
  const blocks = [];
  const open = (head, rawText) => blocks.push({ ...head, dx: [], dxBad: [], extra: [], rawText });
  lines.forEach((line, i) => {
    if (AMOUNT_LINE_RE.test(line)) return;
    const head = parseBlockHead(line);
    if (head) {
      open(head, line);
      return;
    }
    const dx = diagnosisTokens(line);
    if (dx) {
      const block = blocks[blocks.length - 1];
      if (!block) {
        warnings.push("Diagnosis codes appear before any service in the description and were not used.");
        return;
      }
      for (const t2 of dx) {
        if (!ICD10_TOKEN_RE.test(t2)) block.dxBad.push(t2);
        else if (!block.dx.includes(t2)) block.dx.push(t2);
      }
      return;
    }
    if (i === 0) {
      payerLabel = line;
      return;
    }
    open({ units: null, unitsUnreadable: true, cpt: null, modifiers: null, text: line }, line);
  });
  const seen = /* @__PURE__ */ new Map();
  const services = blocks.map((b) => {
    const content = [b.cpt ?? b.rawText.toUpperCase(), b.modifiers, b.units, b.dx.join(","), b.dxBad.join(",")].join("|");
    const stem = `${b.cpt ?? "X"}.${createHash2("sha256").update(content).digest("hex").slice(0, 10)}`;
    const n = seen.get(stem) ?? 0;
    seen.set(stem, n + 1);
    const unreadable = [];
    const notes = [];
    if (!b.cpt) {
      unreadable.push("cptCodes");
      notes.push(`No CPT code is printed for "${b.text.slice(0, 120)}". Enter the code from your records, or skip this line.`);
    }
    if (b.unitsUnreadable) {
      unreadable.push("unitsBilled");
      notes.push("Units are not stated for this service.");
    }
    if (b.dx.length === 0 || b.dxBad.length > 0) {
      unreadable.push("diagnosisCodes");
      notes.push(b.dxBad.length > 0 ? `Diagnosis value(s) ${b.dxBad.join(", ")} are not ICD-10 codes.` : "No diagnosis codes are listed under this service.");
    }
    return {
      lineId: `${stem}.${n}`,
      cptCode: b.cpt,
      modifiers: b.modifiers,
      units: b.units,
      diagnosisCodes: b.dxBad.length > 0 || b.dx.length === 0 ? null : b.dx.join(", "),
      unreadable,
      notes: notes.length > 0 ? notes.join(" ") : null
    };
  });
  return { payerLabel, services, warnings };
}
function parseServiceDates(raw) {
  const parts = raw.split(/[,;\n]|\s+to\s+/i).map((s) => s.trim()).filter(Boolean);
  const dates = [];
  const bad2 = [];
  for (const p of parts) {
    const r = parseCsvDate(p);
    if (r.ok && r.value) {
      if (!dates.includes(r.value)) dates.push(r.value);
    } else bad2.push(p);
  }
  return { dates, bad: bad2 };
}
function parseCms1500Export(body, skippedLines, maxRows) {
  const base = { rowErrors: [], invoices: [], blockedInvoiceIds: [], dataRowCount: 0, unknownColumns: [] };
  const parsed = Papa3.parse(body, { skipEmptyLines: false });
  const table = parsed.data;
  const headers = (table[0] ?? []).map(normalizeHeader);
  const missing = CMS1500_EXPORT_REQUIRED.filter((h) => !headers.includes(h));
  if (missing.length > 0) {
    return { ...base, templateError: `This invoice export is missing required column(s): ${missing.join(", ")}. Nothing was imported. Export it again with those columns, or use the CMS1500 CSV template.` };
  }
  const col = (h) => headers.indexOf(h);
  const known = new Set(CMS1500_EXPORT_HEADERS);
  const unknownColumns = headers.filter((h) => h && !known.has(h));
  const quoteErrorRows = new Set(parsed.errors.filter((e) => e.row != null).map((e) => e.row));
  const rowErrors = [];
  const rows = [];
  let dataRowCount = 0;
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    if (cells.every((c) => !c.trim())) continue;
    dataRowCount++;
    const row = skippedLines + i + 1;
    const invoiceId = cleanCell(cells[col("invoice #")]).replace(/\s+/g, " ").toUpperCase();
    const errs = [];
    if (quoteErrorRows.has(i)) errs.push("Unbalanced quotes in this row.");
    if (cells.length !== headers.length) errs.push(`This row has ${cells.length} cells, but the header has ${headers.length} columns. Export the file again without editing it.`);
    if (!invoiceId) errs.push("Invoice # is empty. Each invoice needs its number so that re-importing it cannot create duplicates.");
    else if (invoiceId.length > 80) errs.push("Invoice # is longer than 80 characters.");
    else if (/^[#=+@]/.test(invoiceId)) errs.push(`Invoice # "${invoiceId}" cannot start with #, =, + or @.`);
    if (errs.length > 0) {
      for (const message of errs) rowErrors.push({ row, claimId: invoiceId || null, message });
      if (invoiceId && invoiceId.length <= 80) base.blockedInvoiceIds.push(invoiceId);
      continue;
    }
    rows.push({ row, invoiceId, cells });
  }
  if (dataRowCount === 0) return { ...base, templateError: "The file has a header row but no data rows." };
  if (dataRowCount > maxRows) return { ...base, templateError: `The file has ${dataRowCount} rows; the limit is ${maxRows}. Split it into smaller files.` };
  const fingerprint = (cells) => cells.map((c) => c.trim()).join("\0");
  const byInvoice = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const first = byInvoice.get(r.invoiceId);
    if (!first) {
      byInvoice.set(r.invoiceId, r);
      continue;
    }
    if (fingerprint(first.cells) !== fingerprint(r.cells)) {
      rowErrors.push({ row: r.row, claimId: r.invoiceId, message: `Invoice # ${r.invoiceId} is also on row ${first.row} with different values. Correct the file so each invoice number appears once.` });
      base.blockedInvoiceIds.push(r.invoiceId);
    }
  }
  const invoices = [];
  for (const [invoiceId, r] of Array.from(byInvoice.entries())) {
    if (base.blockedInvoiceIds.includes(invoiceId)) continue;
    const cell = (h) => col(h) >= 0 ? cleanCell(r.cells[col(h)]) : "";
    const { payerLabel, services, warnings } = parseExportDescription(r.cells[col("description")] ?? "");
    if (services.length === 0) {
      rowErrors.push({ row: r.row, claimId: invoiceId, message: "No service lines were found in Description." });
      base.blockedInvoiceIds.push(invoiceId);
      continue;
    }
    const { dates, bad: bad2 } = parseServiceDates(cell("service date(s)"));
    if (dates.length === 0) warnings.push(bad2.length > 0 ? `Service Date(s) "${bad2.join(", ")}" could not be read. Enter each line's date of service.` : "Service Date(s) is empty. Enter each line's date of service.");
    else if (dates.length > 1) warnings.push(`This invoice lists ${dates.length} service dates and does not say which service was on which date. Choose the date for each line.`);
    if (dates.length > 0 && bad2.length > 0) warnings.push(`Part of Service Date(s) could not be read: ${bad2.join(", ")}.`);
    const dobCell = cell("birth date");
    const dob = dobCell ? parseCsvDate(dobCell) : null;
    if (dob && !dob.ok) warnings.push("Birth Date could not be read, so it was not used to check the patient's identity.");
    const name = cell("patient").replace(/\s+/g, " ");
    const guid = cell("patient_guid");
    invoices.push({
      invoiceId,
      row: r.row,
      patientName: name && name.length <= 200 ? name : null,
      externalPatientId: guid && guid.length <= 120 ? guid : null,
      birthDate: dob && dob.ok ? dob.value : null,
      serviceDates: dates,
      dateOfService: dates.length === 1 ? dates[0] : null,
      payerLabel,
      services,
      warnings
    });
  }
  rowErrors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
  return { templateError: null, rowErrors, invoices, blockedInvoiceIds: Array.from(new Set(base.blockedInvoiceIds)), dataRowCount, unknownColumns };
}
function exportIdentityConflicts(invoices) {
  const norm = (s) => s.toUpperCase().replace(/[^A-Z ]+/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
  const byGuid = /* @__PURE__ */ new Map();
  const byName = /* @__PURE__ */ new Map();
  for (const inv of invoices) {
    if (inv.externalPatientId) byGuid.set(inv.externalPatientId, [...byGuid.get(inv.externalPatientId) ?? [], inv]);
    if (inv.patientName) byName.set(norm(inv.patientName), [...byName.get(norm(inv.patientName)) ?? [], inv]);
  }
  const conflicts = /* @__PURE__ */ new Map();
  const flag = (list, message) => {
    for (const inv of list) conflicts.set(inv.invoiceId, message);
  };
  for (const list of Array.from(byGuid.values())) {
    if (new Set(list.map((i) => i.birthDate).filter(Boolean)).size > 1) flag(list, "One patient_guid in this file has more than one Birth Date.");
    else if (new Set(list.map((i) => i.patientName ? norm(i.patientName) : null).filter(Boolean)).size > 1) flag(list, "One patient_guid in this file has more than one patient name.");
  }
  for (const list of Array.from(byName.values())) {
    const guids = new Set(list.map((i) => i.externalPatientId).filter(Boolean));
    const dobs = new Set(list.map((i) => i.birthDate).filter(Boolean));
    if (guids.size > 1) flag(list, "This patient name appears with more than one patient_guid in this file, so these may be different people.");
    else if (dobs.size > 1) flag(list, "This patient name appears with more than one Birth Date in this file, so these may be different people.");
  }
  return conflicts;
}

// server/claimCsvImport.ts
init_db();
function csvDocumentSha256(kind, claimId) {
  return sha256Hex(Buffer.from(`claims-csv:v1:${kind}:${claimId}`, "utf8"));
}
function csvGroupKey(kind, claimId) {
  return groupKeyFor(`claims-csv:${kind}:${claimId}`);
}
function csvLineKey(kind, claimId, lineId) {
  const key2 = `${csvGroupKey(kind, claimId)}:csv.${lineId}`;
  if (!CLAIM_IMPORT_KEY_RE.test(key2)) throw new Error(`Generated CSV line key is invalid: ${key2}`);
  return key2;
}
var refused = (kind, templateError) => ({ kind, templateError, rowErrors: [], claims: [], blockedClaimIds: [], dataRowCount: 0 });
var normName = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
function parseExportFile(body, skippedLines) {
  const e = parseCms1500Export(body, skippedLines, CLAIM_CSV_MAX_ROWS);
  if (e.templateError) return refused("cms1500", e.templateError);
  const conflicts = exportIdentityConflicts(e.invoices);
  const claims = e.invoices.map((inv) => {
    const claimId = `EXPORT:${inv.invoiceId}`;
    const groupKey2 = csvGroupKey("cms1500", claimId);
    const lineDateOptions = {};
    const lines = inv.services.map((s) => {
      const sourceLineKey = csvLineKey("cms1500", claimId, s.lineId);
      if (inv.dateOfService == null) lineDateOptions[sourceLineKey] = inv.serviceDates;
      return {
        sourceLineKey,
        page: null,
        slot: null,
        dateOfService: inv.dateOfService,
        placeOfService: null,
        cptCodes: s.cptCode,
        modifier: s.modifiers,
        unitsBilled: s.units,
        diagnosisPointer: null,
        diagnosisCodes: s.diagnosisCodes,
        claimSubmittedDate: null,
        insuranceBilled: null,
        visitNumber: null,
        lineChargeForValidation: null,
        unreadable: [...inv.dateOfService == null ? ["dateOfService"] : [], ...s.unreadable],
        notes: s.notes,
        sourceRow: inv.row
      };
    });
    return {
      kind: "cms1500",
      claimId: inv.invoiceId,
      sha256: csvDocumentSha256("cms1500", claimId),
      groupKey: groupKey2,
      patientName: inv.patientName ?? "",
      patientId: null,
      rows: [inv.row],
      lines,
      periods: {},
      refs: {},
      warnings: inv.warnings,
      unresolvedClaimTotals: [],
      identity: inv.externalPatientId || inv.birthDate || conflicts.has(inv.invoiceId) ? { sourceSystem: BILLING_EXPORT_SOURCE_SYSTEM, externalId: inv.externalPatientId, strength: "patient", birthDate: inv.birthDate, conflict: conflicts.get(inv.invoiceId) ?? null } : null,
      payerLabel: inv.payerLabel,
      lineDateOptions
    };
  });
  return {
    kind: "cms1500",
    templateError: null,
    rowErrors: e.rowErrors,
    claims,
    blockedClaimIds: e.blockedInvoiceIds.map((id) => `EXPORT:${id}`),
    dataRowCount: e.dataRowCount,
    isExport: true,
    fileWarnings: [
      "This export has no modifiers or place of service, so those stay blank on every line. Amounts are not imported from it.",
      ...e.unknownColumns.length > 0 ? [`Columns not read: ${e.unknownColumns.join(", ")}.`] : []
    ]
  };
}
function parseClaimCsv(kind, text) {
  const template = CLAIM_CSV_TEMPLATES[kind];
  if (Buffer.byteLength(text, "utf8") > CLAIM_CSV_MAX_BYTES) return refused(kind, `The file is larger than ${CLAIM_CSV_MAX_BYTES / 1e6} MB. Split it into smaller files.`);
  const { body, skippedLines } = stripLeadingCommentLines(text);
  const parsed = Papa4.parse(body, { skipEmptyLines: false });
  const table = parsed.data;
  if (table.length === 0 || table[0].every((c) => !c.trim())) return refused(kind, `The file is empty. Download ${template.fileName} and add one row per line.`);
  const headers = table[0].map(normalizeHeader);
  const detected = detectCsvTemplate(headers);
  const wrong = wrongTemplateMessage(kind, detected);
  if (wrong) return refused(kind, wrong);
  if (detected === "cms1500_export") return parseExportFile(body, skippedLines);
  const known = new Map(template.fields.map((f) => [f.header, f]));
  const named = headers.filter(Boolean);
  const dupes = named.filter((h, i) => named.indexOf(h) !== i);
  if (dupes.length) return refused(kind, `Column ${Array.from(new Set(dupes)).join(", ")} appears more than once.`);
  const unknown = named.filter((h) => !known.has(h));
  if (unknown.length) return refused(kind, `Unknown column(s): ${unknown.join(", ")}. Use the header row from ${template.fileName}.`);
  const missing = template.fields.filter((f) => f.required && !headers.includes(f.header)).map((f) => f.header);
  if (missing.length) return refused(kind, `Missing required column(s): ${missing.join(", ")}.`);
  const rowErrors = [];
  const quoteErrorRows = new Set(parsed.errors.filter((e) => e.row != null).map((e) => e.row));
  const rows = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    if (cells.every((c) => !c.trim())) continue;
    const row = skippedLines + i + 1;
    const errs = [];
    if (quoteErrorRows.has(i)) errs.push("Unbalanced quotes in this row.");
    if (cells.length > headers.length || cells.some((c, j) => !headers[j] && c.trim())) {
      errs.push("More cells than columns \u2014 a cell with several codes (modifiers, diagnosis codes) is probably missing its surrounding quotes.");
    }
    const values = {};
    for (const field of template.fields) {
      const j = headers.indexOf(field.header);
      const r = parseCsvCell(field, j >= 0 ? cells[j] : "");
      if (r.ok) values[field.header] = r.value;
      else errs.push(r.error);
    }
    const claimId = values[template.claimIdHeader];
    if (claimId && claimId.startsWith(EXAMPLE_ID_PREFIX)) errs.push("This is an example row from the template. Delete it before importing.");
    if (kind === "eob" && values.cms1500_claim_id == null !== (values.cms1500_line_id == null)) {
      errs.push("Fill both cms1500_claim_id and cms1500_line_id, or leave both blank.");
    }
    for (const message of errs) rowErrors.push({ row, claimId, message });
    rows.push({ row, values: errs.length ? { ...values, __invalid: 1 } : values });
  }
  if (rows.length === 0) return refused(kind, "The file has a header row but no data rows.");
  if (rows.length > CLAIM_CSV_MAX_ROWS) return refused(kind, `The file has ${rows.length} rows; the limit is ${CLAIM_CSV_MAX_ROWS}. Split it into smaller files.`);
  const byClaim = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const id = r.values[template.claimIdHeader];
    if (!id) continue;
    byClaim.set(id, [...byClaim.get(id) ?? [], r]);
  }
  const claims = [];
  const blockedClaimIds = [];
  for (const [claimId, claimRows] of Array.from(byClaim.entries())) {
    const errs = [];
    const first = claimRows[0].values;
    const name = String(first.patient_name ?? "");
    for (const r of claimRows) {
      if (r.values.patient_name != null && normName(String(r.values.patient_name)) !== normName(name)) {
        errs.push({ row: r.row, claimId, message: `patient_name differs from row ${claimRows[0].row} of the same claim. One claim belongs to one patient.` });
      }
      if ((r.values.patient_id ?? null) !== (first.patient_id ?? null)) {
        errs.push({ row: r.row, claimId, message: `patient_id differs from row ${claimRows[0].row} of the same claim.` });
      }
    }
    const lineIds = claimRows.map((r) => r.values[template.lineIdHeader]);
    claimRows.forEach((r, i) => {
      const id = lineIds[i];
      if (id && lineIds.indexOf(id) !== i) {
        errs.push({ row: r.row, claimId, message: `${template.lineIdHeader} "${id}" is used twice in this claim (also row ${claimRows[lineIds.indexOf(id)].row}). Give each line its own ID \u2014 identical CPT lines included.` });
      }
    });
    const groupKey2 = csvGroupKey(kind, claimId);
    const periods = {};
    const refs = {};
    const lines = claimRows.map(({ row, values: v }) => {
      const lineId = v[template.lineIdHeader];
      const sourceLineKey = lineId ? csvLineKey(kind, claimId, lineId) : `${groupKey2}:invalid.${row}`;
      if (v.auth_period != null) periods[sourceLineKey] = v.auth_period;
      if (kind === "cms1500") {
        const line2 = {
          sourceLineKey,
          page: null,
          slot: null,
          dateOfService: v.date_of_service,
          placeOfService: v.place_of_service,
          cptCodes: v.cpt_code,
          modifier: v.modifiers,
          unitsBilled: v.units,
          diagnosisPointer: null,
          diagnosisCodes: v.diagnosis_codes,
          claimSubmittedDate: v.claim_submitted_date,
          insuranceBilled: v.insurance_billed,
          visitNumber: v.visit_number,
          lineChargeForValidation: null,
          unreadable: [],
          notes: null,
          sourceRow: row
        };
        return line2;
      }
      if (v.cms1500_claim_id != null && v.cms1500_line_id != null) refs[sourceLineKey] = { claimId: v.cms1500_claim_id, lineId: v.cms1500_line_id };
      const line = {
        sourceLineKey,
        page: null,
        dateOfService: v.date_of_service,
        cptCodes: v.cpt_code,
        modifier: v.modifiers,
        unitsBilled: v.units,
        chargeAmount: v.billed_charge,
        insuranceReimbursement: v.insurance_paid,
        patientAmountDue: v.patient_responsibility,
        patientAmountPaid: v.patient_paid,
        claimStatus: v.claim_status,
        oaClaimNumber: v.payer_claim_number,
        checkDate: v.payment_date,
        checkNumberVirtualCard: v.check_or_eft_number,
        notes: null,
        sourceRow: row
      };
      return line;
    });
    const warnings = [];
    const unresolvedClaimTotals = [];
    if (kind === "eob") {
      const total = (col) => {
        const vals = Array.from(new Set(claimRows.map((r) => r.values[col]).filter((x) => x != null)));
        if (vals.length > 1) errs.push({ row: null, claimId, message: `${col} has different values on rows of the same claim (${vals.join(", ")}). Give the claim total once, the same on every row.` });
        return vals.length === 1 ? vals[0] : null;
      };
      const paid = total("claim_total_paid");
      const resp = total("claim_total_patient_responsibility");
      if (paid != null || resp != null) {
        const eobLines = lines;
        const dates = Array.from(new Set(eobLines.map((l) => l.dateOfService)));
        unresolvedClaimTotals.push({
          dateOfService: dates.length === 1 ? dates[0] : null,
          cptCodes: Array.from(new Set(eobLines.map((l) => l.cptCodes).filter(Boolean))).join(", "),
          planPaid: paid,
          patientResponsibility: resp,
          cptCount: eobLines.length
        });
        const linePaid = eobLines.map((l) => l.insuranceReimbursement);
        if (paid != null && paid > 0 && eobLines.length > 1 && linePaid.every((p) => p === paid)) {
          errs.push({ row: null, claimId, message: `insurance_paid repeats the claim total (${paid.toFixed(2)}) on every line. Enter each line's own payment, or leave insurance_paid blank and keep the total only in claim_total_paid.` });
        } else if (paid != null && linePaid.every((p) => p != null)) {
          const sum = Math.round(linePaid.reduce((a, b) => a + b, 0) * 100) / 100;
          if (Math.abs(sum - paid) > 4e-3) warnings.push(`Line payments add up to $${sum.toFixed(2)}, but claim_total_paid is $${paid.toFixed(2)}. Review the remittance.`);
        }
        warnings.push("The claim total is shown for review only. It is not saved to, divided between or copied onto any line.");
      }
    }
    if (errs.length > 0 || claimRows.some((r) => r.values.__invalid)) {
      rowErrors.push(...errs);
      blockedClaimIds.push(claimId);
      continue;
    }
    claims.push({
      kind,
      claimId,
      sha256: csvDocumentSha256(kind, claimId),
      groupKey: groupKey2,
      patientName: name,
      patientId: first.patient_id ?? null,
      rows: claimRows.map((r) => r.row),
      lines,
      periods,
      refs,
      warnings,
      unresolvedClaimTotals
    });
  }
  rowErrors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
  return { kind, templateError: null, rowErrors, claims, blockedClaimIds, dataRowCount: rows.length };
}
var claimName = (claim) => claim.patientName || null;
function checkFilePatient(claim, roster) {
  if (!claim.patientId) return null;
  const p = roster.find((r) => r.id === claim.patientId);
  if (!p) return `patient_id ${claim.patientId} is not a patient on the dashboard. Leave it blank to match by name.`;
  if (!fuzzyNameMatch(claim.patientName, p.name)) return `patient_id ${claim.patientId} belongs to ${p.name}, not ${claim.patientName}.`;
  const resolved = resolveImportPatient({ patientName: claim.patientName, identity: null, requestedPatientId: claim.patientId, createRequest: null, allPatients: roster, externalIds: [] });
  if (resolved.patientId && resolved.patientId !== claim.patientId) return `patient_name ${claim.patientName} matches a different patient than patient_id ${claim.patientId}.`;
  return null;
}
async function loadAndCheck(kind, csvText) {
  const parsed = parseClaimCsv(kind, csvText);
  if (parsed.templateError) return { parsed, roster: [], externalIds: [], claims: [] };
  const roster = (await getAllPatients()).map((p) => ({ id: p.id, name: p.name }));
  const externalIds = await listPatientExternalIds();
  const claims = [];
  for (const c of parsed.claims) {
    const problem = checkFilePatient(c, roster);
    if (problem) {
      parsed.rowErrors.push({ row: c.rows[0], claimId: c.claimId, message: problem });
      parsed.blockedClaimIds.push(c.claimId);
    } else {
      claims.push(c);
    }
  }
  return { parsed, roster, externalIds, claims };
}
async function hintsFor(claim, roster, externalIds, cmsDocIds) {
  if (claim.kind === "cms1500") return { filePeriods: claim.periods, roster, externalIds, fileIdentity: claim.identity ?? null, strictLineIdentity: claim.lineDateOptions != null };
  const eobTargets = {};
  for (const line of claim.lines) {
    const ref = claim.refs[line.sourceLineKey];
    let cms1500Ref = null;
    if (ref) {
      const sha = csvDocumentSha256("cms1500", ref.claimId);
      if (!cmsDocIds.has(sha)) cmsDocIds.set(sha, await findClaimImportDocumentId("cms1500", sha));
      cms1500Ref = { documentId: cmsDocIds.get(sha) ?? null, lineKey: csvLineKey("cms1500", ref.claimId, ref.lineId), label: `${ref.claimId} / line ${ref.lineId}`, sha256: sha };
    }
    eobTargets[line.sourceLineKey] = { cms1500Ref, authPeriod: claim.periods[line.sourceLineKey] ?? null };
  }
  return { eobTargets, roster, externalIds };
}
var csvLineEdits = z4.object({
  dateOfService: z4.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  cptCodes: z4.string().trim().max(20).nullable().optional(),
  unitsBilled: z4.number().int().min(1).max(999).nullable().optional(),
  diagnosisCodes: z4.string().trim().max(200).nullable().optional()
});
var lineEditsInput = z4.record(groupKey_(), csvLineEdits);
function groupKey_() {
  return z4.string().regex(CLAIM_IMPORT_KEY_RE);
}
var CPT_EDIT_RE = /^(?:\d{5}|\d{4}[A-Z]|[A-Z]\d{4})$/;
var ICD10_EDIT_RE = /^[A-Z]\d[0-9A-Z](?:\.[0-9A-Z]{1,4})?$/;
function applyCsvLineEdits(line, edits, dateOptions) {
  if (!edits || line.unreadable.length === 0) return line;
  const out = { ...line, unreadable: [...line.unreadable] };
  const clear = (field) => {
    out.unreadable = out.unreadable.filter((f) => f !== field);
  };
  if (line.unreadable.includes("dateOfService") && edits.dateOfService) {
    const parsed = parseCsvDateStrict(edits.dateOfService);
    if (parsed && (!dateOptions || dateOptions.length === 0 || dateOptions.includes(parsed))) {
      out.dateOfService = parsed;
      clear("dateOfService");
    }
  }
  if (line.unreadable.includes("cptCodes") && edits.cptCodes) {
    const c = edits.cptCodes.toUpperCase();
    if (CPT_EDIT_RE.test(c)) {
      out.cptCodes = c;
      clear("cptCodes");
    }
  }
  if (line.unreadable.includes("unitsBilled") && edits.unitsBilled != null) {
    out.unitsBilled = edits.unitsBilled;
    clear("unitsBilled");
  }
  if (line.unreadable.includes("diagnosisCodes") && edits.diagnosisCodes) {
    const codes = edits.diagnosisCodes.toUpperCase().split(/[\s,;]+/).filter(Boolean);
    if (codes.length > 0 && codes.length <= 12 && codes.every((c) => ICD10_EDIT_RE.test(c))) {
      out.diagnosisCodes = codes.join(", ");
      clear("diagnosisCodes");
    }
  }
  return out;
}
function parseCsvDateStrict(v) {
  const r = parseCsvDate(v);
  return r.ok ? r.value : null;
}
function lineInput(kind, l) {
  if (kind === "cms1500") {
    const c = l;
    return {
      sourceLineKey: c.sourceLineKey,
      dateOfService: c.dateOfService,
      cptCodes: c.cptCodes,
      modifier: c.modifier,
      unitsBilled: c.unitsBilled,
      placeOfService: c.placeOfService,
      diagnosisCodes: c.diagnosisCodes,
      claimSubmittedDate: c.claimSubmittedDate,
      insuranceBilled: c.insuranceBilled,
      visitNumber: c.visitNumber ?? null,
      unreadable: c.unreadable
    };
  }
  const e = l;
  return {
    sourceLineKey: e.sourceLineKey,
    dateOfService: e.dateOfService,
    cptCodes: e.cptCodes,
    modifier: e.modifier,
    unitsBilled: e.unitsBilled,
    chargeAmount: e.chargeAmount,
    insuranceReimbursement: e.insuranceReimbursement,
    patientAmountDue: e.patientAmountDue,
    patientAmountPaid: e.patientAmountPaid,
    claimStatus: e.claimStatus,
    oaClaimNumber: e.oaClaimNumber,
    checkDate: e.checkDate,
    checkNumberVirtualCard: e.checkNumberVirtualCard
  };
}
function toImportDocument(kind, fileName, csvText, claims, parsed) {
  return {
    kind,
    sha256: sha256Hex(Buffer.from(csvText, "utf8")),
    fileName,
    pageCount: null,
    extractionMethod: parsed.isExport ? "CMS1500 invoice export (CSV)" : `CSV template (${CLAIM_CSV_TEMPLATES[kind].fileName})`,
    warnings: parsed.fileWarnings ?? [],
    columnMapping: parsed.isExport ? CMS1500_EXPORT_MAPPING : void 0,
    groups: claims.map((c) => ({
      groupKey: c.groupKey,
      patientName: c.patientName,
      pages: null,
      claimIdentifier: c.claimId,
      lines: c.lines,
      warnings: c.warnings,
      unresolvedClaimTotals: c.unresolvedClaimTotals,
      patientIdentity: c.identity ?? null,
      sourcePayerLabel: c.payerLabel ?? null,
      lineDateOptions: c.lineDateOptions
    }))
  };
}
var groupKey = z4.string().regex(CLAIM_IMPORT_KEY_RE);
var csvFileInput = {
  kind: z4.enum(["cms1500", "eob"]),
  fileName: z4.string().trim().min(1).max(255),
  csvText: z4.string().max(CLAIM_CSV_MAX_BYTES)
};
var csvImportPreviewInput = z4.object({
  ...csvFileInput,
  /** Reviewer's patient choice per claim (groupKey) — only used when the file has no patient_id. */
  patientChoices: z4.record(groupKey, z4.string().uuid()).optional(),
  /** P4-P28: reviewer's request to create the patient, per claim. */
  patientCreates: z4.record(groupKey, createPatientRequest).optional(),
  lineEdits: lineEditsInput.optional()
});
async function previewClaimCsvImport(input) {
  const { parsed, roster, externalIds, claims } = await loadAndCheck(input.kind, input.csvText);
  const base = { templateError: parsed.templateError, rowErrors: parsed.rowErrors, blockedClaimIds: parsed.blockedClaimIds, dataRowCount: parsed.dataRowCount };
  if (parsed.templateError) return { ...base, document: null, preview: null };
  const cmsDocIds = /* @__PURE__ */ new Map();
  const groups = [];
  for (const c of claims) {
    const request = importPreviewInput.parse({
      kind: input.kind,
      document: { sha256: c.sha256, fileName: input.fileName, pageCount: null },
      contextPatientId: null,
      groups: [{
        groupKey: c.groupKey,
        patientName: claimName(c),
        patientId: c.patientId ?? input.patientChoices?.[c.groupKey] ?? null,
        createPatient: c.patientId ? null : input.patientCreates?.[c.groupKey] ?? null,
        lines: c.lines.map((l) => lineInput(input.kind, c.lineDateOptions ? applyCsvLineEdits(l, input.lineEdits?.[l.sourceLineKey], c.lineDateOptions[l.sourceLineKey]) : l))
      }]
    });
    const r = await previewClaimImport(request, await hintsFor(c, roster, externalIds, cmsDocIds));
    groups.push(...r.groups);
  }
  return { ...base, document: toImportDocument(input.kind, input.fileName, input.csvText, claims, parsed), preview: { documentId: null, groups } };
}
var commitGroup = (decision) => z4.object({
  groupKey,
  patientId: z4.string().uuid().nullable().optional(),
  patientConfirmed: z4.boolean().optional(),
  createPatient: createPatientRequest.nullable().optional(),
  lines: z4.array(z4.object({ sourceLineKey: groupKey, decision, edits: csvLineEdits.optional() })).min(1).max(500)
});
var csvImportCommitInput = z4.discriminatedUnion("kind", [
  z4.object({ ...csvFileInput, kind: z4.literal("cms1500"), groups: z4.array(commitGroup(cms1500Decision)).min(1).max(100) }),
  z4.object({ ...csvFileInput, kind: z4.literal("eob"), groups: z4.array(commitGroup(eobDecision)).min(1).max(100) })
]);
var CsvTemplateError = class extends Error {
};
async function commitClaimCsvImport(input, actor) {
  const { parsed, roster, externalIds, claims } = await loadAndCheck(input.kind, input.csvText);
  if (parsed.templateError) throw new CsvTemplateError(parsed.templateError);
  const byKey = new Map(claims.map((c) => [c.groupKey, c]));
  const blocked = new Set(parsed.blockedClaimIds.map((id) => csvGroupKey(input.kind, id)));
  const importBatchId = randomUUID2();
  const cmsDocIds = /* @__PURE__ */ new Map();
  const results = [];
  for (const g of input.groups) {
    const claim = byKey.get(g.groupKey);
    const notInFile = (sourceLineKey, message) => ({ sourceLineKey, status: "review_required", reason: "not_in_file", message });
    if (!claim) {
      const message = blocked.has(g.groupKey) ? "This claim has errors in the file. Fix them and upload the file again." : "This claim is not in the file any more.";
      results.push({ groupKey: g.groupKey, patientId: null, lines: g.lines.map((l) => notInFile(l.sourceLineKey, message)) });
      continue;
    }
    const fileLines = new Map(claim.lines.map((l) => [l.sourceLineKey, l]));
    const requested = /* @__PURE__ */ new Map();
    for (const l of g.lines) if (!requested.has(l.sourceLineKey)) requested.set(l.sourceLineKey, l);
    const missing = Array.from(requested.keys()).filter((k) => !fileLines.has(k));
    const present = Array.from(requested.values()).filter((l) => fileLines.has(l.sourceLineKey));
    let committed = [];
    let patientId = null;
    let patientOutcome = null;
    if (present.length > 0) {
      const request = importCommitInput.parse({
        kind: input.kind,
        document: { sha256: claim.sha256, fileName: input.fileName, pageCount: null },
        contextPatientId: null,
        contextAuthPeriod: null,
        groups: [{
          groupKey: claim.groupKey,
          patientName: claimName(claim),
          // A patient_id in the file wins over a reviewer choice; confirmation rules still apply.
          patientId: claim.patientId ?? g.patientId ?? null,
          patientConfirmed: g.patientConfirmed,
          createPatient: claim.patientId ? null : g.createPatient ?? null,
          allLineKeys: claim.lines.map((l) => l.sourceLineKey),
          lines: present.map((l) => {
            const fileLine = fileLines.get(l.sourceLineKey);
            const line = claim.lineDateOptions ? applyCsvLineEdits(fileLine, l.edits, claim.lineDateOptions[l.sourceLineKey]) : fileLine;
            return { ...lineInput(input.kind, line), decision: l.decision };
          })
        }]
      });
      const r = await commitClaimImport(request, actor, { ...await hintsFor(claim, roster, externalIds, cmsDocIds), importBatchId });
      committed = r.groups[0].lines;
      patientId = r.groups[0].patientId;
      patientOutcome = r.groups[0].patientOutcome ?? null;
    }
    results.push({
      groupKey: g.groupKey,
      patientId,
      patientOutcome,
      lines: [...committed, ...missing.map((k) => notInFile(k, "This line is not in the file any more."))]
    });
  }
  return { importBatchId, groups: results };
}

// server/pendingEob.ts
import { randomUUID as randomUUID3 } from "crypto";
import { z as z5 } from "zod";
init_db();
var numberOrNull = (v) => v === null || v === void 0 ? null : Number(v);
function lineOf(row) {
  return {
    sourceLineKey: row.lineKey,
    dateOfService: row.dateOfService,
    cptCodes: row.cptCodes,
    modifier: row.modifier,
    unitsBilled: row.unitsBilled,
    chargeAmount: numberOrNull(row.data.charge_amount),
    insuranceReimbursement: numberOrNull(row.data.insurance_reimbursement),
    patientAmountDue: numberOrNull(row.data.patient_amount_due),
    patientAmountPaid: numberOrNull(row.data.patient_amount_paid)
  };
}
async function classifyRow(row, cache) {
  const existing = await listPatientClaimLinesOnDates(row.patientId, [row.dateOfService]);
  const t2 = row.target;
  if (!t2) return classifyEobLine({ line: lineOf(row), documentId: row.documentId, existing });
  const sha = t2.cms1500_sha256;
  let documentId = null;
  if (sha) {
    if (!cache.has(sha)) cache.set(sha, await findClaimImportDocumentId("cms1500", sha));
    documentId = cache.get(sha) ?? null;
  }
  const target = {
    cms1500Ref: sha && t2.line_key ? { documentId, lineKey: String(t2.line_key), label: String(t2.label ?? t2.line_key) } : null,
    authPeriod: t2.auth_period == null ? null : Number(t2.auth_period)
  };
  return classifyEobLineForTarget({ line: lineOf(row), documentId: row.documentId, existing, target });
}
async function listPendingEob() {
  const rows = await listPendingEobLines();
  const cache = /* @__PURE__ */ new Map();
  const items = [];
  for (const row of rows) {
    items.push({
      id: row.id,
      patientId: row.patientId,
      patientName: row.patientName,
      fileName: row.fileName,
      dateOfService: row.dateOfService,
      cptCodes: row.cptCodes,
      modifier: row.modifier,
      unitsBilled: row.unitsBilled,
      chargeAmount: numberOrNull(row.data.charge_amount),
      insuranceReimbursement: numberOrNull(row.data.insurance_reimbursement),
      patientAmountDue: numberOrNull(row.data.patient_amount_due),
      patientAmountPaid: numberOrNull(row.data.patient_amount_paid),
      claimStatus: row.data.claim_status ?? null,
      createdAt: row.createdAt,
      classification: await classifyRow(row, cache)
    });
  }
  return { items, truncated: rows.length >= PENDING_EOB_LIST_LIMIT };
}
var pendingEobApplyInput = z5.object({
  items: z5.array(z5.object({
    pendingId: z5.string().uuid(),
    claimRecordId: z5.string().uuid(),
    confirmReplace: z5.boolean().optional()
  })).min(1).max(100)
});
var APPLY_MESSAGES = {
  cms1500_required: "The matching CMS1500 line is not saved yet.",
  already_reconciled: "That claim line already has a payment from another EOB line. Confirm replacing it.",
  existing_financials: "That claim line already has different amounts. Confirm replacing them.",
  source_line_already_saved: "This line is already applied to a different claim line.",
  incompatible: "That claim line has a different date of service or CPT.",
  patient_mismatch: "That claim line belongs to a different patient.",
  not_found: "This line or its claim line no longer exists.",
  pending_not_needed: "This line was already resolved.",
  line_dismissed: "This line was dismissed, so it was not applied."
};
async function applyPendingEob(input, actor) {
  const importBatchId = randomUUID3();
  const rows = new Map((await listPendingEobLines()).map((r) => [r.id, r]));
  const cache = /* @__PURE__ */ new Map();
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of input.items) {
    if (seen.has(item.pendingId)) continue;
    seen.add(item.pendingId);
    const row = rows.get(item.pendingId);
    if (row) {
      const c = await classifyRow(row, cache);
      if (!allowedEobTargets(c).includes(item.claimRecordId)) {
        results.push({ pendingId: item.pendingId, status: "review_required", message: c.reason ?? "This line cannot be applied to that claim line. Re-check and choose again." });
        continue;
      }
    }
    try {
      const r = await applyPendingEobLine({ pendingId: item.pendingId, targetClaimId: item.claimRecordId, confirmReplace: item.confirmReplace === true, actor, importBatchId });
      results.push({ pendingId: item.pendingId, status: r.status === "unchanged" ? "unchanged" : "saved" });
    } catch (err) {
      if (err instanceof ClaimImportRuleError) {
        results.push({ pendingId: item.pendingId, status: "review_required", message: APPLY_MESSAGES[err.reason] ?? err.reason });
      } else {
        console.error("[PendingEob] apply failed:", err);
        results.push({ pendingId: item.pendingId, status: "failed", message: "Could not apply this line. Nothing was changed for it \u2014 retry." });
      }
    }
  }
  return { importBatchId, results };
}
var pendingEobDismissInput = z5.object({ pendingId: z5.string().uuid() });
async function dismissPendingEob(input, actor) {
  await dismissPendingEobLine(input.pendingId, actor);
}

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

// server/patientCsvImport.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { z as z6 } from "zod";

// shared/insuranceCatalog.ts
function normalizeInsurerName(name) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}
function insurerMatchValues(entry) {
  return [entry.name, ...entry.aliases];
}

// shared/patientCsvImport.ts
import Papa5 from "papaparse";
var PATIENT_CSV_FILE_NAME = "clinic_patient_template.csv";
var PATIENT_CSV_MAX_BYTES = 2e6;
var PATIENT_CSV_MAX_ROWS = 1e3;
var PATIENT_NAME_MAX = 200;
var PATIENT_CSV_COLUMNS = [
  { field: "name", headers: ["Patient Name", "Name", "Patient"], required: true, help: "Patient name, e.g. DOE, JANE. Rows with the same name become one patient." },
  { field: "insurance", headers: ["Insurance", "Insurance Company"], required: false, help: "Must match a company in the insurance list. Leave blank if unknown." },
  { field: "authorized", headers: ["Authorized Sessions", "Total Authorized"], required: false, help: "Whole number, 0\u2013999." },
  { field: "authDate", headers: ["Authorization Date"], required: false, help: "YYYY-MM-DD or MM/DD/YYYY." },
  { field: "dateOfService", headers: ["Date of Service"], required: false, help: "YYYY-MM-DD or MM/DD/YYYY." },
  { field: "sessionNumber", headers: ["Session Number"], required: false, help: "Whole number, 1\u2013999." },
  { field: "remaining", headers: ["Sessions Remaining"], required: false, help: "Whole number, 0\u2013999. Blank = same as Authorized Sessions." },
  { field: "newAuth", headers: ["New Authorization?"], required: false, help: "YES or NO. Blank = NO." },
  { field: "authSubmitted", headers: ["Date Authorization Submitted", "Date ASH Submitted"], required: false, help: "YYYY-MM-DD or MM/DD/YYYY." }
];
function patientNameKey(name) {
  return name.toUpperCase().replace(/['’]/g, "").replace(/[,.\s-]+/g, " ").split(" ").filter(Boolean).sort().join(" ");
}
var FINANCIAL_HEADER_RE = /(amount|paid|payment|pay\b|charge|reimburs|balance|copay|co-pay|coinsurance|deductible|\bdue\b|billed|price|\bfee|\$|cpt|hcpcs|diagnos|icd|modifier|\bunits?\b|claim|invoice|eob|remit|check|eft|payer|adjust|\btotal\b(?! authorized))/i;
function financialHeaders(headers) {
  return headers.filter((h) => FINANCIAL_HEADER_RE.test(normalizeHeader(h)));
}
function intCell(v, min, max, label, errors) {
  if (!v) return null;
  if (!/^\d+$/.test(v)) {
    errors.push(`${label} "${v}" must be a whole number.`);
    return null;
  }
  const n = Number(v);
  if (n < min || n > max) {
    errors.push(`${label} "${v}" must be between ${min} and ${max}.`);
    return null;
  }
  return n;
}
function dateCell(v, label, errors) {
  const r = parseCsvDate(v);
  if (!r.ok) {
    errors.push(`${label}: ${r.error}`);
    return null;
  }
  return r.value;
}
function parsePatientCsv(text) {
  const empty = (fileError) => ({ fileError, rows: [], ignoredColumns: [] });
  if (new TextEncoder().encode(text).length > PATIENT_CSV_MAX_BYTES) {
    return empty({ code: "too_large", message: `The file is larger than ${PATIENT_CSV_MAX_BYTES / 1e6} MB. Split it into smaller files.` });
  }
  const { body, skippedLines } = stripLeadingCommentLines(text);
  const parsed = Papa5.parse(body, { skipEmptyLines: "greedy" });
  const [headerRow, ...dataRows] = parsed.data;
  if (!headerRow || headerRow.every((h) => !h.trim())) {
    return empty({ code: "empty", message: "The file is empty. Download the template and add one row per patient session." });
  }
  const headers = headerRow.map(normalizeHeader);
  const detected = detectCsvTemplate(headers);
  if (detected === "cms1500" || detected === "eob" || detected === "cms1500_export") {
    return empty({
      code: "claims_template",
      message: "This is a claims file (CMS1500 or Insurance Reimbursement), not the patient template. Nothing was imported. Claims files are uploaded under Bulk Upload by a Clinic Admin or the Owner."
    });
  }
  const money2 = financialHeaders(headerRow);
  if (money2.length > 0) {
    return empty({
      code: "financial_columns",
      message: `The patient import does not accept claims or payment columns (${money2.map((h) => `"${h.trim()}"`).join(", ")}). Remove them, or use the patient template. Nothing was imported.`
    });
  }
  const index = /* @__PURE__ */ new Map();
  const known = /* @__PURE__ */ new Set();
  for (const col of PATIENT_CSV_COLUMNS) {
    for (const alias of col.headers) {
      const i = headers.indexOf(normalizeHeader(alias));
      if (i >= 0 && !index.has(col.field)) {
        index.set(col.field, i);
        known.add(i);
      }
    }
  }
  if (!index.has("name")) {
    return empty({ code: "missing_name_column", message: `The file has no "Patient Name" column. Download ${PATIENT_CSV_FILE_NAME} and use its header row.` });
  }
  if (dataRows.length === 0) {
    return empty({ code: "empty", message: "The file has a header row but no patients." });
  }
  if (dataRows.length > PATIENT_CSV_MAX_ROWS) {
    return empty({ code: "too_many_rows", message: `The file has ${dataRows.length} rows; the limit is ${PATIENT_CSV_MAX_ROWS}. Split it into smaller files.` });
  }
  const ignoredColumns = headerRow.filter((h, i) => h.trim() && !known.has(i)).map((h) => h.trim());
  const get = (cells, f) => {
    const i = index.get(f);
    return i === void 0 ? "" : cleanCell(cells[i]);
  };
  const rows = dataRows.map((cells, k) => {
    const errors = [];
    const name = get(cells, "name").replace(/\s+/g, " ");
    if (!name) errors.push("Patient Name is required.");
    else if (name.length > PATIENT_NAME_MAX) errors.push(`Patient Name is longer than ${PATIENT_NAME_MAX} characters.`);
    else if (/^[=+@]/.test(name)) errors.push("Patient Name cannot start with =, + or @.");
    const insurance = get(cells, "insurance").replace(/\s+/g, " ");
    if (insurance.length > 120) errors.push("Insurance is longer than 120 characters.");
    const authorized = intCell(get(cells, "authorized"), 0, 999, "Authorized Sessions", errors);
    const sessionNumber = intCell(get(cells, "sessionNumber"), 1, 999, "Session Number", errors);
    const remainingRaw = intCell(get(cells, "remaining"), 0, 999, "Sessions Remaining", errors);
    const authDate = dateCell(get(cells, "authDate"), "Authorization Date", errors);
    const dateOfService = dateCell(get(cells, "dateOfService"), "Date of Service", errors);
    const dateAuthSubmitted = dateCell(get(cells, "authSubmitted"), "Date Authorization Submitted", errors);
    const newAuthRaw = get(cells, "newAuth").toUpperCase();
    let newAuth = "NO";
    if (newAuthRaw === "YES" || newAuthRaw === "Y") newAuth = "YES";
    else if (newAuthRaw && newAuthRaw !== "NO" && newAuthRaw !== "N") errors.push(`New Authorization? "${newAuthRaw}" must be YES or NO.`);
    const remaining = remainingRaw ?? authorized;
    if (authorized !== null && remaining !== null && remaining > authorized) {
      errors.push(`Sessions Remaining (${remaining}) is more than Authorized Sessions (${authorized}).`);
    }
    const hasVisit = authorized !== null || sessionNumber !== null || remainingRaw !== null || dateOfService !== null || dateAuthSubmitted !== null || newAuthRaw !== "";
    return {
      line: skippedLines + 2 + k,
      name,
      nameKey: name ? patientNameKey(name) : "",
      insurance,
      authDate,
      visit: hasVisit ? { sessionsAuthorized: authorized, sessionsRemaining: remaining, sessionNumber, dateOfService, newAuth, dateAuthSubmitted } : null,
      errors
    };
  });
  return { fileError: null, rows, ignoredColumns };
}
function groupPatientRows(rows) {
  const groups = /* @__PURE__ */ new Map();
  const invalidNoName = [];
  for (const row of rows) {
    if (!row.nameKey) {
      invalidNoName.push({
        key: `line-${row.line}`,
        name: "",
        insurance: "",
        authDate: null,
        lines: [row.line],
        visits: [],
        duplicateLines: [],
        status: "invalid",
        errors: row.errors.map((e) => `Line ${row.line}: ${e}`),
        matchedName: null
      });
      continue;
    }
    let g = groups.get(row.nameKey);
    if (!g) {
      g = { key: row.nameKey, name: row.name, insurance: "", authDate: null, lines: [], visits: [], duplicateLines: [], status: "new", errors: [], matchedName: null };
      groups.set(row.nameKey, g);
    }
    g.lines.push(row.line);
    for (const e of row.errors) g.errors.push(`Line ${row.line}: ${e}`);
    if (row.insurance) {
      if (g.insurance && g.insurance.toLowerCase() !== row.insurance.toLowerCase()) {
        g.errors.push(`Line ${row.line}: Insurance "${row.insurance}" differs from "${g.insurance}" on an earlier line for this patient.`);
      } else g.insurance = row.insurance;
    }
    if (row.authDate) {
      if (g.authDate && g.authDate !== row.authDate) {
        g.errors.push(`Line ${row.line}: Authorization Date ${row.authDate} differs from ${g.authDate} on an earlier line for this patient.`);
      } else g.authDate = row.authDate;
    }
    if (row.visit) {
      const same = g.visits.find((v) => JSON.stringify(v) === JSON.stringify(row.visit));
      if (same) g.duplicateLines.push(row.line);
      else g.visits.push(row.visit);
    }
  }
  const out = [...Array.from(groups.values()), ...invalidNoName];
  for (const g of out) if (g.errors.length > 0) g.status = "invalid";
  return out;
}

// server/patientCsvImport.ts
init_db();
var patientCsvPreviewInput = z6.object({
  fileName: z6.string().trim().min(1).max(255),
  csvText: z6.string().max(PATIENT_CSV_MAX_BYTES)
});
var patientCsvCommitInput = patientCsvPreviewInput.extend({
  /** Patients the reviewer unticked in the review (group keys). */
  skipKeys: z6.array(z6.string().max(400)).max(2e3).default([]),
  /** Possible duplicates the reviewer explicitly chose to add as new patients. */
  confirmKeys: z6.array(z6.string().max(400)).max(2e3).default([])
});
async function review(fileName, csvText) {
  const parsed = parsePatientCsv(csvText);
  const empty = { rows: 0, new: 0, existing: 0, possibleDuplicate: 0, invalid: 0, sessions: 0, duplicateLines: 0 };
  if (parsed.fileError) return { fileName, fileError: parsed.fileError, ignoredColumns: [], groups: [], counts: empty };
  const groups = groupPatientRows(parsed.rows);
  const [patients, catalog] = await Promise.all([getAllPatients(), listInsurerCatalog()]);
  const byKey = new Map(patients.map((p) => [patientNameKey(p.name), p.name]));
  for (const g of groups) {
    if (g.insurance) {
      const wanted = normalizeInsurerName(g.insurance);
      const entry = catalog.find((e) => insurerMatchValues(e).some((v) => normalizeInsurerName(v) === wanted));
      if (!entry) g.errors.push(`Insurance "${g.insurance}" is not in the insurance list. Leave it blank, or ask an admin to add it.`);
      else if (!entry.isActive) g.errors.push(`Insurance "${entry.name}" is deactivated. Choose an active insurance company or leave it blank.`);
      else g.insurance = entry.name;
    }
    if (g.errors.length > 0) {
      g.status = "invalid";
      continue;
    }
    const exact = byKey.get(g.key);
    if (exact) {
      g.status = "existing";
      g.matchedName = exact;
      continue;
    }
    const similar = patients.find((p) => fuzzyNameMatch(g.name, p.name));
    if (similar) {
      g.status = "possible_duplicate";
      g.matchedName = similar.name;
    }
  }
  const counts = { ...empty, rows: parsed.rows.length };
  for (const g of groups) {
    if (g.status === "new") counts.new++;
    else if (g.status === "existing") counts.existing++;
    else if (g.status === "possible_duplicate") counts.possibleDuplicate++;
    else counts.invalid++;
    if (g.status === "new" || g.status === "possible_duplicate") counts.sessions += g.visits.length;
    counts.duplicateLines += g.duplicateLines.length;
  }
  return { fileName, fileError: null, ignoredColumns: parsed.ignoredColumns, groups, counts };
}
function previewPatientCsvImport(input) {
  return review(input.fileName, input.csvText);
}
async function commitPatientCsvImport(input, actor) {
  const importBatchId = randomUUID4();
  const preview = await review(input.fileName, input.csvText);
  const summary = { created: 0, sessionsCreated: 0, alreadyExists: 0, skipped: 0, invalid: 0, failed: 0 };
  if (preview.fileError) return { importBatchId, fileError: preview.fileError, results: [], summary };
  const skip = new Set(input.skipKeys);
  const confirm = new Set(input.confirmKeys);
  const results = [];
  for (const g of preview.groups) {
    const base = { key: g.key, name: g.name, lines: g.lines };
    if (g.status === "invalid") {
      summary.invalid++;
      results.push({ ...base, outcome: "invalid", sessions: 0, message: g.errors.join(" ") });
      continue;
    }
    if (g.status === "existing") {
      summary.alreadyExists++;
      results.push({ ...base, outcome: "already_exists", sessions: 0, message: `Already on the dashboard as ${g.matchedName}. Not changed.` });
      continue;
    }
    if (skip.has(g.key) || g.status === "possible_duplicate" && !confirm.has(g.key)) {
      summary.skipped++;
      results.push({ ...base, outcome: "skipped", sessions: 0, message: g.status === "possible_duplicate" ? `Not added: similar to ${g.matchedName}.` : "Not selected." });
      continue;
    }
    try {
      const r = await commitPatientCsvGroup({
        name: g.name,
        insurance: g.insurance,
        authDate: g.authDate,
        visits: g.visits,
        fileName: input.fileName,
        importBatchId
      }, actor);
      if (r.status === "created") {
        summary.created++;
        summary.sessionsCreated += r.sessions;
        results.push({ ...base, outcome: "created", sessions: r.sessions, message: null });
      } else {
        summary.alreadyExists++;
        results.push({ ...base, outcome: "already_exists", sessions: 0, message: "Already on the dashboard (saved earlier). Not changed." });
      }
    } catch (err) {
      summary.failed++;
      const message = err instanceof InsurerDeletedError ? err.message : "Could not be saved. Nothing was saved for this patient; try again.";
      if (!(err instanceof InsurerDeletedError)) console.error("[patientCsvImport] commit failed:", err);
      results.push({ ...base, outcome: "failed", sessions: 0, message });
    }
  }
  return { importBatchId, fileError: null, results, summary };
}

// server/_core/loginRateLimit.ts
init_username();
var WINDOW_MS = 15 * 60 * 1e3;
var MAX_FAILED_ATTEMPTS = 5;
var attemptsByKey = /* @__PURE__ */ new Map();
var writesSinceSweep = 0;
var SWEEP_EVERY_N_WRITES = 200;
function sweepExpired(now) {
  attemptsByKey.forEach((entry, key2) => {
    if (now - entry.windowStart > WINDOW_MS) {
      attemptsByKey.delete(key2);
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
  const key2 = keyFor(normalizedUsername, ip);
  const entry = attemptsByKey.get(key2);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attemptsByKey.set(key2, { count: 1, windowStart: now });
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
function rethrowPeriodExpiryGuard(err) {
  const code = err?.code;
  if (code === "P0035") throw new TRPCError3({ code: "BAD_REQUEST", message: "Expiry is set per authorization period. Use Mark Expired / Restore on the period instead." });
  if (code === "P0036") throw new TRPCError3({ code: "CONFLICT", message: "This authorization period is expired. A date of service after the expiry date can't be recorded against it." });
  throw err;
}
var visitRecordInput = z7.object({
  sessionsAuthorized: z7.number().nullable().optional(),
  sessionsRemaining: z7.number().nullable().optional(),
  sessionNumber: z7.number().nullable().optional(),
  authPeriod: z7.number().optional(),
  // Which authorization period this visit belongs to
  dateOfService: z7.string().nullable().optional(),
  // ISO date string "YYYY-MM-DD"
  newAuth: z7.string().nullable().optional(),
  dateAshSubmitted: z7.string().nullable().optional(),
  // ISO date string "YYYY-MM-DD"
  authStatus: z7.enum(["none", "pending", "approved", "denied"]).optional(),
  totalInsuranceReimbursement: z7.number().nullable().optional(),
  totalPatientDue: z7.number().nullable().optional(),
  totalPatientPaid: z7.number().nullable().optional()
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
function toSafeStaff(user) {
  const { passwordHash: _passwordHash, tokenVersion: _tokenVersion, ...safe } = user;
  return safe;
}
function assertMayWriteVisitFinancials(user, input) {
  if (canAccessClaims(user)) return;
  if (VISIT_FINANCIAL_FIELDS.some((field) => input[field] !== void 0)) {
    throw new TRPCError3({ code: "FORBIDDEN", message: CLAIMS_ACCESS_DENIED_ERR_MSG });
  }
}
var retiredClaimsImportProcedure = claimsAccessProcedure.input(z7.unknown()).mutation(() => {
  throw new TRPCError3({
    code: "PRECONDITION_FAILED",
    message: "This upload flow was replaced by the CMS1500-first import. Reload the page and upload the CMS1500 first, then the EOB."
  });
});
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
          mustChangePassword: staff.mustChangePassword,
          // Always false for a clinic session — see server/_core/superAdmin.ts.
          isSuperAdmin: false,
          // P4-P25: true for a Clinic Admin, false for Staff — same
          // canAccessClaims() every server-side Claims gate uses.
          canAccessClaims: canAccessClaims(user)
        };
      }
      return {
        authType: "owner",
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isSuperAdmin: isSuperAdmin(user),
        // P4-P25 Claims capability. Computed by the same canAccessClaims()
        // every server-side Claims gate uses, so the UI can never show
        // Claims to a session the server would refuse.
        canAccessClaims: canAccessClaims(user)
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
    login: publicProcedure.input(z7.object({ username: z7.string().min(1), password: z7.string().min(1) })).mutation(async ({ ctx, input }) => {
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
      z7.object({
        currentPassword: z7.string().min(1),
        newPassword: z7.string().min(MIN_CLINIC_PASSWORD_LENGTH)
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
    get: adminOrOwnerProcedure.input(z7.object({ id: z7.string().uuid() })).query(async ({ input }) => {
      const row = await getClinicUserById(input.id);
      if (!row) throw new TRPCError3({ code: "NOT_FOUND", message: "Staff account not found" });
      return toSafeStaff(row);
    }),
    create: adminOrOwnerProcedure.input(
      z7.object({
        name: z7.string().min(1, "Name is required"),
        email: z7.string().trim().optional(),
        department: z7.string().trim().optional(),
        username: z7.string().trim().min(1, "Username is required"),
        role: z7.enum(["admin", "staff"]).default("staff"),
        status: z7.enum(["active", "archived"]).default("active"),
        password: z7.string().min(MIN_CLINIC_PASSWORD_LENGTH, `Password must be at least ${MIN_CLINIC_PASSWORD_LENGTH} characters`),
        confirmPassword: z7.string().min(1)
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
      z7.object({
        id: z7.string().uuid(),
        name: z7.string().min(1, "Name is required").optional(),
        email: z7.string().trim().optional(),
        department: z7.string().trim().optional(),
        role: z7.enum(["admin", "staff"]).optional()
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
      z7.object({
        id: z7.string().uuid(),
        password: z7.string().min(MIN_CLINIC_PASSWORD_LENGTH, `Password must be at least ${MIN_CLINIC_PASSWORD_LENGTH} characters`),
        confirmPassword: z7.string().min(1)
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
    archive: adminOrOwnerProcedure.input(z7.object({ id: z7.string().uuid() })).mutation(async ({ ctx, input }) => {
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
    reactivate: adminOrOwnerProcedure.input(z7.object({ id: z7.string().uuid() })).mutation(async ({ ctx, input }) => {
      const updated = await reactivateClinicUser(input.id, getActorContext(ctx.user));
      if (!updated) throw new TRPCError3({ code: "NOT_FOUND", message: "Staff account not found" });
      return toSafeStaff(updated);
    }),
    history: adminOrOwnerProcedure.input(z7.object({ id: z7.string().uuid() })).query(async ({ input }) => {
      return listHistoryForEntity("clinic_user", input.id);
    })
  }),
  // ── Patients ────────────────────────────────────────────────────────────────
  patients: router({
    // claimsStatus is claim data — omitted for sessions without Claims access (P4-P25).
    list: normalProtectedProcedure.query(async ({ ctx }) => {
      const claimsAllowed = canAccessClaims(ctx.user);
      return (await getAllPatients()).map((p) => redactPatient(p, claimsAllowed));
    }),
    get: normalProtectedProcedure.input(z7.object({ id: z7.string().uuid() })).query(async ({ ctx, input }) => {
      const patient = await getPatientById(input.id);
      if (!patient) throw new TRPCError3({ code: "NOT_FOUND", message: "Patient not found" });
      return redactPatient(patient, canAccessClaims(ctx.user));
    }),
    create: normalProtectedProcedure.input(
      z7.object({
        name: z7.string().min(1),
        insurance: z7.string().default(""),
        authDate: z7.string().nullable().optional(),
        authValidUntil: z7.number().nullable().optional()
        // Unix ms timestamp
      })
    ).mutation(async ({ input, ctx }) => {
      try {
        const id = await createPatient({
          name: input.name,
          insurance: input.insurance,
          authDate: parseDate2(input.authDate),
          authValidUntil: input.authValidUntil ?? null
        }, getActorContext(ctx.user));
        return { id };
      } catch (err) {
        if (err instanceof InsurerDeletedError) {
          throw new TRPCError3({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),
    update: normalProtectedProcedure.input(
      z7.object({
        id: z7.string().uuid(),
        name: z7.string().min(1).optional(),
        insurance: z7.string().optional(),
        authDate: z7.string().nullable().optional(),
        authValidUntil: z7.number().nullable().optional(),
        // "none" is the API-level sentinel for "no claims status set" (see
        // getPatientById/listPatients in db.ts, which map a NULL claims_status
        // column to "none"). It is NOT a column value — accepting it here and
        // translating it to `null` below lets the edit form round-trip an
        // unset status without that NULL ever being asked to match the
        // 7-value DB enum, which is what previously threw invalid_value.
        claimsStatus: z7.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "none"]).optional()
      })
    ).mutation(async ({ input, ctx }) => {
      const { id, authDate, authValidUntil, claimsStatus, ...rest } = input;
      if (claimsStatus !== void 0 && !canAccessClaims(ctx.user)) {
        throw new TRPCError3({ code: "FORBIDDEN", message: CLAIMS_ACCESS_DENIED_ERR_MSG });
      }
      const before = await getPatientById(id);
      if (!before) throw new TRPCError3({ code: "NOT_FOUND", message: "Patient not found" });
      try {
        await updatePatient(id, {
          ...rest,
          ...authDate !== void 0 ? { authDate: parseDate2(authDate) } : {},
          ...authValidUntil !== void 0 ? { authValidUntil } : {},
          // Field omitted entirely → key absent → updatePatient leaves the
          // column untouched. Field present as "none" → explicit clear (NULL).
          ...claimsStatus !== void 0 ? { claimsStatus: claimsStatus === "none" ? null : claimsStatus } : {}
        }, getActorContext(ctx.user));
      } catch (err) {
        if (err instanceof InsurerDeletedError) {
          throw new TRPCError3({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
      return { success: true };
    }),
    delete: normalProtectedProcedure.input(z7.object({ id: z7.string().uuid() })).mutation(async ({ input }) => {
      await deletePatient(input.id);
      return { success: true };
    }),
    setActive: normalProtectedProcedure.input(z7.object({
      id: z7.string().uuid(),
      isActive: z7.boolean(),
      dischargeDate: z7.number().nullable().optional(),
      dischargeReason: z7.string().nullable().optional()
    })).mutation(async ({ input }) => {
      await setPatientActive(input.id, input.isActive, input.dischargeDate, input.dischargeReason);
      return { success: true };
    }),
    history: normalProtectedProcedure.input(z7.object({ id: z7.string().uuid() })).query(async ({ ctx, input }) => {
      return redactAuditRows(await listHistoryForEntity("patient", input.id), canAccessClaims(ctx.user));
    }),
    /**
     * P4-P29: "Bulk Upload Patients" (Patient Data CSV). Same gate as create —
     * Staff, Clinic Admin and Owner; signed-out callers and sessions that must
     * change their password are refused by normalProtectedProcedure. Preview
     * never writes. Commit re-parses the file and re-checks every patient (see
     * server/patientCsvImport.ts); no claims data is read or written.
     */
    csvImportPreview: normalProtectedProcedure.input(patientCsvPreviewInput).mutation(({ input }) => previewPatientCsvImport(input)),
    csvImportCommit: normalProtectedProcedure.input(patientCsvCommitInput).mutation(({ input, ctx }) => commitPatientCsvImport(input, getActorContext(ctx.user)))
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
      z7.object({
        // Blank-after-trim is rejected by the .refine below rather than
        // z.string().min(1) alone, which would accept e.g. "   ".
        name: z7.string().transform((v) => v.trim()).refine((v) => v.length > 0, {
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
        return await reactivateInsurerCatalogEntry(existing.id, getActorContext(ctx.user));
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
    // Soft delete / "Deactivate" (P4-P13) — admin/owner only. Hides the entry from
    // new-selection dropdowns without touching any patient/visit/claim
    // record (those store the insurer name as free text, not an FK into
    // this table) and without deleting the catalog row itself.
    delete: adminOrOwnerProcedure.input(z7.object({ id: z7.string().uuid() })).mutation(async ({ input, ctx }) => {
      const existing = await getInsurerCatalogEntryById(input.id);
      if (!existing) {
        throw new TRPCError3({ code: "NOT_FOUND", message: "Insurance company not found" });
      }
      return await deactivateInsurerCatalogEntry(input.id, getActorContext(ctx.user));
    }),
    // Deliberate reactivation (P4-P13) from the Manage Insurance Companies
    // dialog — distinct from insurance.create's own reactivate-on-conflict
    // path above, for an admin who wants to bring an entry back without
    // retyping its exact name.
    reactivate: adminOrOwnerProcedure.input(z7.object({ id: z7.string().uuid() })).mutation(async ({ input, ctx }) => {
      const existing = await getInsurerCatalogEntryById(input.id);
      if (!existing) {
        throw new TRPCError3({ code: "NOT_FOUND", message: "Insurance company not found" });
      }
      return await reactivateInsurerCatalogEntry(input.id, getActorContext(ctx.user));
    }),
    // Permanent delete (P4-P21, P4-P22) — admin/owner only. Removes the
    // exact catalog id from the catalog even when patients/visits/claims
    // still store its name: those columns are free text (no FK), so every
    // record keeps its recorded insurer and nothing is reassigned or merged.
    // The delete, its tombstone, and its audit row run in one locked
    // Postgres transaction (delete_insurer_catalog_with_audit).
    permanentDelete: adminOrOwnerProcedure.input(z7.object({ id: z7.string().uuid() })).mutation(async ({ input, ctx }) => {
      try {
        await permanentlyDeleteInsurerCatalogEntry(input.id, getActorContext(ctx.user));
      } catch (err) {
        if (err instanceof InsurerCatalogHasForeignKeysError) {
          throw new TRPCError3({ code: "PRECONDITION_FAILED", message: err.message });
        }
        if (err instanceof InsurerCatalogEntryNotFoundError) {
          throw new TRPCError3({
            code: "NOT_FOUND",
            message: "This insurance company no longer exists. It may already have been deleted."
          });
        }
        throw err;
      }
      return { success: true, id: input.id };
    }),
    // Same gate as create/delete/reactivate — insurer catalog management is
    // admin/owner only, so its history is too (unlike patient/visit/claim
    // history, which any authenticated staff member can read).
    history: adminOrOwnerProcedure.input(z7.object({ id: z7.string().uuid() })).query(async ({ ctx, input }) => {
      return redactAuditRows(await listHistoryForEntity("insurer_catalog", input.id), canAccessClaims(ctx.user));
    })
  }),
  // ── Visit Records ────────────────────────────────────────────────────────────
  visits: router({
    // Per-session financial totals require Claims access (P4-P25).
    listByPatient: normalProtectedProcedure.input(z7.object({ patientId: z7.string().uuid() })).query(async ({ ctx, input }) => {
      const claimsAllowed = canAccessClaims(ctx.user);
      return (await getVisitsByPatientId(input.patientId)).map((v) => redactVisitRecord(v, claimsAllowed));
    }),
    create: normalProtectedProcedure.input(visitRecordInput.extend({ patientId: z7.string().uuid() })).mutation(async ({ input, ctx }) => {
      assertMayWriteVisitFinancials(ctx.user, input);
      const { patientId, dateOfService, dateAshSubmitted, ...rest } = input;
      let id;
      try {
        id = await createVisitRecord({
          patientId,
          ...rest,
          dateOfService: parseDate2(dateOfService),
          dateAshSubmitted: parseDate2(dateAshSubmitted)
        }, getActorContext(ctx.user));
      } catch (err) {
        rethrowPeriodExpiryGuard(err);
      }
      return { id };
    }),
    update: normalProtectedProcedure.input(visitRecordInput.extend({ id: z7.string().uuid() })).mutation(async ({ input, ctx }) => {
      assertMayWriteVisitFinancials(ctx.user, input);
      const { id, dateOfService, dateAshSubmitted, ...rest } = input;
      try {
        await updateVisitRecord(id, {
          ...rest,
          ...dateOfService !== void 0 ? { dateOfService: parseDate2(dateOfService) } : {},
          ...dateAshSubmitted !== void 0 ? { dateAshSubmitted: parseDate2(dateAshSubmitted) } : {}
        }, getActorContext(ctx.user));
      } catch (err) {
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
    updateSessionFields: normalProtectedProcedure.input(sessionWorkflowFieldsInput.extend({
      id: z7.string().uuid(),
      patientId: z7.string().uuid()
    })).mutation(async ({ input, ctx }) => {
      const { id, patientId, ...fields } = input;
      if (Object.values(fields).every((v) => v === void 0)) {
        throw new TRPCError3({ code: "BAD_REQUEST", message: "No session fields to update" });
      }
      try {
        await updateVisitRecord(id, fields, getActorContext(ctx.user), {
          action: "SESSION_FIELDS_UPDATE",
          patientId
        });
      } catch (err) {
        const code = err?.code;
        if (code === "P0030") throw new TRPCError3({ code: "NOT_FOUND", message: "Session not found" });
        if (code === "P0031") throw new TRPCError3({ code: "BAD_REQUEST", message: "This session does not belong to the selected patient." });
        if (code === "23514") throw new TRPCError3({ code: "BAD_REQUEST", message: "Invalid session field value" });
        throw err;
      }
      const saved = await getVisitRecordById(id);
      if (!saved) throw new TRPCError3({ code: "NOT_FOUND", message: "Session not found" });
      return {
        id: saved.id,
        assignmentOfBenefits: saved.assignmentOfBenefits,
        submissionStatus: saved.submissionStatus,
        remarks: saved.remarks
      };
    }),
    bulkCreate: normalProtectedProcedure.input(
      z7.object({
        patientId: z7.string().uuid(),
        records: z7.array(visitRecordInput)
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
      try {
        await bulkCreateVisitRecords(rows, getActorContext(ctx.user));
      } catch (err) {
        rethrowPeriodExpiryGuard(err);
      }
      return { success: true };
    }),
    // Returns urgency summaries for ALL patients — used by the homepage alert panel
    authAlerts: normalProtectedProcedure.query(async () => {
      return getAuthAlertSummaries();
    }),
    // Approves a pending authorization and creates a new batch of visit records
    approveAuthorization: normalProtectedProcedure.input(z7.object({
      patientId: z7.string().uuid(),
      sessionsAuthorized: z7.number().min(1).max(200),
      authDate: z7.string().nullable().optional(),
      // ISO date string "YYYY-MM-DD"
      newInsurance: z7.string().optional(),
      // optional insurance change for new period
      authValidUntil: z7.number().nullable().optional()
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
    markAsRequested: normalProtectedProcedure.input(z7.object({ patientId: z7.string().uuid() })).mutation(async ({ input, ctx }) => {
      const visitId = await getMarkAsRequestedTargetVisitId(input.patientId);
      if (!visitId) throw new TRPCError3({ code: "NOT_FOUND", message: "No visit records found for this patient" });
      const today = /* @__PURE__ */ new Date();
      const todayMidnight = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
      const actor = getActorContext(ctx.user);
      await updateVisitRecord(visitId, {
        authStatus: "pending",
        dateAshSubmitted: todayMidnight
      }, actor, { action: "AUTHORIZATION_MARKED_REQUESTED", patientId: input.patientId });
      return { success: true, visitId, date: todayMidnight.toISOString().split("T")[0] };
    }),
    // P4-P31: manually mark one authorization period Expired, or restore it
    // (reason required; refused once a later period exists). Same gate as
    // visits.update / markAsRequested (every authenticated dashboard user who
    // can edit authorization sessions). Never inferred from dates or a zero
    // balance. Only the period's period_expired_at changes — row statuses,
    // counts, dates, claims and money are untouched — audited once per change.
    setPeriodExpired: normalProtectedProcedure.input(z7.object({
      patientId: z7.string().uuid(),
      authPeriod: z7.number().int().min(1),
      expired: z7.boolean(),
      reason: z7.string().trim().max(500).optional()
    }).refine((v) => v.expired || (v.reason ?? "").length > 0, {
      message: "A reason is required to restore an expired authorization period",
      path: ["reason"]
    })).mutation(async ({ input, ctx }) => {
      try {
        const changed = await setAuthPeriodExpired(
          input.patientId,
          input.authPeriod,
          input.expired,
          input.reason || null,
          getActorContext(ctx.user)
        );
        return { success: true, changed };
      } catch (err) {
        const code = err?.code;
        if (code === "P0020") throw new TRPCError3({ code: "NOT_FOUND", message: "Patient not found" });
        if (code === "P0034") throw new TRPCError3({ code: "NOT_FOUND", message: "Authorization period not found for this patient" });
        if (code === "P0037") throw new TRPCError3({ code: "CONFLICT", message: "This period can't be restored: a newer authorization period already exists." });
        if (code === "22023") throw new TRPCError3({ code: "BAD_REQUEST", message: "A reason (500 characters or fewer) is required to restore an expired period." });
        throw err;
      }
    }),
    historyForPatient: normalProtectedProcedure.input(z7.object({ patientId: z7.string().uuid() })).query(async ({ ctx, input }) => {
      return redactAuditRows(await listHistoryForEntity("visit_record", input.patientId), canAccessClaims(ctx.user));
    })
  }),
  // P4-P23: the whole Claims surface — rows, financial totals, history,
  // follow-up/status aggregates, CMS1500/EOB enrichment and bulk import —
  // requires Claims access (claimsAccessProcedure, server/_core/trpc.ts).
  claims: router({
    getByPatientAndPeriod: claimsAccessProcedure.input(z7.object({ patientId: z7.string().uuid(), authPeriod: z7.number() })).query(async ({ input }) => {
      return await getClaimsByPatientAndPeriod(input.patientId, input.authPeriod);
    }),
    create: claimsAccessProcedure.input(z7.object({
      patientId: z7.string().uuid(),
      authPeriod: z7.number(),
      placeOfService: z7.string().nullable().optional(),
      dateOfService: z7.string().nullable().optional(),
      visitNumber: z7.number().nullable().optional(),
      cptCodes: z7.string().nullable().optional(),
      unitsBilled: z7.number().nullable().optional(),
      diagnosisCodes: z7.string().nullable().optional(),
      modifier: z7.string().nullable().optional(),
      chargeAmount: z7.number().nullable().optional(),
      insuranceReimbursement: z7.number().nullable().optional(),
      patientAmountPaid: z7.number().nullable().optional(),
      patientAmountDue: z7.number().nullable().optional(),
      insuranceBilled: z7.string().nullable().optional(),
      oaClaimNumber: z7.string().nullable().optional(),
      claimSubmittedDate: z7.string().nullable().optional(),
      expireBcbsClaimNumber: z7.string().nullable().optional(),
      claimStatus: z7.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "needs_review"]).optional(),
      paymentReceived: z7.number().nullable().optional(),
      checkDate: z7.string().nullable().optional(),
      checkNumberVirtualCard: z7.string().nullable().optional(),
      dateReceived: z7.string().nullable().optional(),
      dateOfAppeal: z7.string().nullable().optional(),
      referenceNo: z7.string().nullable().optional(),
      lmn: z7.string().nullable().optional()
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
    update: claimsAccessProcedure.input(z7.object({
      id: z7.string().uuid(),
      placeOfService: z7.string().nullable().optional(),
      dateOfService: z7.string().nullable().optional(),
      visitNumber: z7.number().nullable().optional(),
      cptCodes: z7.string().nullable().optional(),
      unitsBilled: z7.number().nullable().optional(),
      diagnosisCodes: z7.string().nullable().optional(),
      modifier: z7.string().nullable().optional(),
      chargeAmount: z7.number().nullable().optional(),
      insuranceReimbursement: z7.number().nullable().optional(),
      patientAmountPaid: z7.number().nullable().optional(),
      patientAmountDue: z7.number().nullable().optional(),
      insuranceBilled: z7.string().nullable().optional(),
      oaClaimNumber: z7.string().nullable().optional(),
      claimSubmittedDate: z7.string().nullable().optional(),
      expireBcbsClaimNumber: z7.string().nullable().optional(),
      claimStatus: z7.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted", "needs_review"]).optional(),
      paymentReceived: z7.number().nullable().optional(),
      checkDate: z7.string().nullable().optional(),
      checkNumberVirtualCard: z7.string().nullable().optional(),
      dateReceived: z7.string().nullable().optional(),
      dateOfAppeal: z7.string().nullable().optional(),
      referenceNo: z7.string().nullable().optional()
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
    delete: claimsAccessProcedure.input(z7.object({ id: z7.string().uuid(), patientId: z7.string().uuid() })).mutation(async ({ input, ctx }) => {
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
    // P4-P24: superseded by importPreview / importCommit below. Kept as
    // explicit refusals (still Claims-access gated) rather than removed, so a
    // browser still running the previous bundle during a deploy gets a clear
    // message instead of creating EOB-first rows or enriching untracked rows.
    upsert: retiredClaimsImportProcedure,
    historyForClaim: claimsAccessProcedure.input(z7.object({ id: z7.string().uuid() })).query(async ({ input }) => {
      return listHistoryForEntity("claim_record", input.id);
    }),
    /**
     * P4-P24: CMS1500-first import preview — no writes. Classifies every
     * extracted line of every patient group in one uploaded file (see
     * server/claimImport.ts and shared/claimImport.ts for the rules).
     */
    // P4-P28: reviewed EOB lines waiting for their CMS1500 (server/pendingEob.ts).
    pendingEobList: claimsAccessProcedure.query(() => listPendingEob()),
    pendingEobApply: claimsAccessProcedure.input(pendingEobApplyInput).mutation(({ input, ctx }) => applyPendingEob(input, getActorContext(ctx.user))),
    pendingEobDismiss: claimsAccessProcedure.input(pendingEobDismissInput).mutation(async ({ input, ctx }) => {
      await dismissPendingEob(input, getActorContext(ctx.user));
      return { success: true };
    }),
    // P4-P28: a patient created by an import can have claim lines and no visits yet.
    periodsForPatient: claimsAccessProcedure.input(z7.object({ patientId: z7.string().uuid() })).query(({ input }) => listPatientClaimPeriods(input.patientId)),
    importPreview: claimsAccessProcedure.input(importPreviewInput).mutation(async ({ input }) => {
      try {
        return await previewClaimImport(input);
      } catch (err) {
        if (err instanceof ClaimImportRuleError) throw new TRPCError3({ code: "NOT_FOUND", message: err.message });
        throw err;
      }
    }),
    /**
     * P4-P24: commit reviewed lines from one uploaded file. Each line is one
     * atomic write+audit RPC call; per-line results come back as saved /
     * unchanged / skipped / review_required / failed, so one bad line never
     * hides the others. Actor identity comes from the verified session only.
     */
    importCommit: claimsAccessProcedure.input(importCommitInput).mutation(async ({ input, ctx }) => {
      try {
        return await commitClaimImport(input, getActorContext(ctx.user));
      } catch (err) {
        if (err instanceof ClaimImportRuleError) throw new TRPCError3({ code: "NOT_FOUND", message: err.message });
        throw err;
      }
    }),
    /**
     * P4-P26: CMS1500 CSV / Insurance Reimbursement CSV bulk upload preview —
     * no writes. The CSV text is parsed here (server/claimCsvImport.ts); a
     * wrong or malformed template comes back as templateError, row-level
     * problems as rowErrors.
     */
    csvImportPreview: claimsAccessProcedure.input(csvImportPreviewInput).mutation(async ({ input }) => {
      try {
        return await previewClaimCsvImport(input);
      } catch (err) {
        if (err instanceof ClaimImportRuleError) throw new TRPCError3({ code: "NOT_FOUND", message: err.message });
        throw err;
      }
    }),
    /**
     * P4-P26: commit reviewed lines of a claims CSV. The file is re-parsed and
     * every line's identity and values come from it, not from the request;
     * persistence is the same audited CMS1500-first path as importCommit.
     */
    csvImportCommit: claimsAccessProcedure.input(csvImportCommitInput).mutation(async ({ input, ctx }) => {
      try {
        return await commitClaimCsvImport(input, getActorContext(ctx.user));
      } catch (err) {
        if (err instanceof CsvTemplateError) throw new TRPCError3({ code: "BAD_REQUEST", message: err.message });
        if (err instanceof ClaimImportRuleError) throw new TRPCError3({ code: "NOT_FOUND", message: err.message });
        throw err;
      }
    }),
    cms1500EnrichmentPreview: retiredClaimsImportProcedure,
    cms1500EnrichmentCommit: retiredClaimsImportProcedure,
    bulkImportFromEOB: retiredClaimsImportProcedure,
    markResolved: claimsAccessProcedure.input(z7.object({ id: z7.string().uuid() })).mutation(async ({ input }) => {
      const { supabase: supabase2 } = await Promise.resolve().then(() => (init_supabase(), supabase_exports));
      const { error } = await supabase2.from("claims_records").update({ is_resolved: true, claim_status: "pending" }).eq("id", input.id);
      if (error) throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return { success: true };
    }),
    getFollowUpClaims: claimsAccessProcedure.input(z7.object({ insurance: z7.string().optional() }).optional()).query(async ({ input }) => {
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
    getStatusCounts: claimsAccessProcedure.input(z7.object({ insurance: z7.string().optional() }).optional()).query(async ({ input }) => {
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
    list: adminOrOwnerProcedure.input(z7.object({
      actorId: z7.string().uuid().optional(),
      entityType: z7.enum(["patient", "visit_record", "claim_record", "pending_eob_line", "insurer_catalog", "clinic_user"]).optional(),
      action: z7.string().optional(),
      dateFrom: z7.string().nullable().optional(),
      // ISO date string "YYYY-MM-DD"
      dateTo: z7.string().nullable().optional(),
      page: z7.number().int().min(0).default(0),
      pageSize: z7.number().int().min(1).max(200).default(50)
    })).query(async ({ ctx, input }) => {
      const claimsAllowed = canAccessClaims(ctx.user);
      if (!claimsAllowed && (input.entityType === "claim_record" || input.entityType === "pending_eob_line")) {
        throw new TRPCError3({ code: "FORBIDDEN", message: CLAIMS_ACCESS_DENIED_ERR_MSG });
      }
      const result = await listActivityLog({
        actorId: input.actorId ?? null,
        entityType: input.entityType ?? null,
        action: input.action ?? null,
        dateFrom: parseDate2(input.dateFrom),
        dateTo: parseDate2(input.dateTo),
        page: input.page,
        pageSize: input.pageSize,
        excludeClaims: !claimsAllowed
      });
      return { ...result, rows: redactAuditRows(result.rows, claimsAllowed) };
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
import path2 from "path";
function serveStatic(app2) {
  const distPath = process.env.NODE_ENV === "development" ? path2.resolve(import.meta.dirname, "../..", "dist", "public") : path2.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app2.use(express.static(distPath));
  app2.use("*", (_req, res) => {
    res.sendFile(path2.resolve(distPath, "index.html"));
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
