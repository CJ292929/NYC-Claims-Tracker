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
  FOLLOW_UP_STALE_DAYS: () => FOLLOW_UP_STALE_DAYS,
  aggregateClaimStatusCounts: () => aggregateClaimStatusCounts,
  approveAndCreateNewBatch: () => approveAndCreateNewBatch,
  bulkCreateVisitRecords: () => bulkCreateVisitRecords,
  classifyClaimFollowUp: () => classifyClaimFollowUp,
  createClaimRecord: () => createClaimRecord,
  createPatient: () => createPatient,
  createVisitRecord: () => createVisitRecord,
  deleteClaimRecord: () => deleteClaimRecord,
  deletePatient: () => deletePatient,
  determineActiveAuthPeriod: () => determineActiveAuthPeriod,
  determineMarkAsRequestedTargetRow: () => determineMarkAsRequestedTargetRow,
  getAllPatients: () => getAllPatients,
  getAuthAlertSummaries: () => getAuthAlertSummaries,
  getClaimsByPatientAndPeriod: () => getClaimsByPatientAndPeriod,
  getClinicUserByUsername: () => getClinicUserByUsername,
  getCompletedPatients: () => getCompletedPatients,
  getLatestVisitIdForPatient: () => getLatestVisitIdForPatient,
  getMarkAsRequestedTargetVisitId: () => getMarkAsRequestedTargetVisitId,
  getPatientById: () => getPatientById,
  getUserByOpenId: () => getUserByOpenId,
  getVisitsByPatientId: () => getVisitsByPatientId,
  setPatientActive: () => setPatientActive,
  sortByFollowUpUrgency: () => sortByFollowUpUrgency,
  updateClaimRecord: () => updateClaimRecord,
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
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}
function toClinicUser(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: new Date(row.created_at)
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
async function createPatient(data) {
  const { data: row, error } = await supabase.from("patients").insert({
    name: data.name,
    insurance: data.insurance ?? "",
    auth_date: data.authDate ? data.authDate.toISOString().split("T")[0] : null,
    auth_valid_until: data.authValidUntil ?? null
  }).select("id").single();
  if (error) {
    console.error("[Supabase] createPatient:", error);
    throw error;
  }
  return row.id;
}
async function updatePatient(id, data) {
  const update = {};
  if (data.name !== void 0) update.name = data.name;
  if (data.insurance !== void 0) update.insurance = data.insurance;
  if (data.authDate !== void 0) {
    update.auth_date = data.authDate ? data.authDate.toISOString().split("T")[0] : null;
  }
  if (data.authValidUntil !== void 0) {
    update.auth_valid_until = data.authValidUntil ?? null;
  }
  if (data.isActive !== void 0) {
    update.is_active = data.isActive;
  }
  if (data.claimsStatus !== void 0) {
    update.claims_status = data.claimsStatus;
  }
  const { error } = await supabase.from("patients").update(update).eq("id", id);
  if (error) {
    console.error("[Supabase] updatePatient:", error);
    throw error;
  }
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
async function createVisitRecord(data) {
  const { data: row, error } = await supabase.from("visit_records").insert({
    patient_id: data.patientId,
    sessions_authorized: data.sessionsAuthorized ?? null,
    sessions_remaining: data.sessionsRemaining ?? null,
    session_number: data.sessionNumber ?? null,
    auth_period: data.authPeriod ?? 1,
    date_of_service: data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null,
    new_auth: data.newAuth ?? null,
    date_ash_submitted: data.dateAshSubmitted ? data.dateAshSubmitted.toISOString().split("T")[0] : null,
    auth_status: data.authStatus ?? "none"
  }).select("id").single();
  if (error) {
    console.error("[Supabase] createVisitRecord:", error);
    throw error;
  }
  return row.id;
}
async function updateVisitRecord(id, data) {
  const update = {};
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
  const { error } = await supabase.from("visit_records").update(update).eq("id", id);
  if (error) {
    console.error("[Supabase] updateVisitRecord:", error);
    throw error;
  }
}
async function bulkCreateVisitRecords(records) {
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
    auth_status: r.authStatus ?? "none"
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
async function approveAndCreateNewBatch(patientId, sessionsAuthorized, authDate, newInsurance, authValidUntil) {
  const { data: periodStatusRows, error: periodStatusErr } = await supabase.from("visit_records").select("auth_period, sessions_authorized, date_of_service").eq("patient_id", patientId);
  if (periodStatusErr) {
    console.error("[Supabase] approveAndCreateNewBatch periodStatus:", periodStatusErr);
    throw periodStatusErr;
  }
  const statusRows = periodStatusRows ?? [];
  const statusPeriods = Array.from(new Set(statusRows.map((r) => r.auth_period ?? 1))).sort((a, b) => a - b);
  const latestStatusPeriod = statusPeriods.length > 0 ? statusPeriods[statusPeriods.length - 1] : 1;
  const targetApprovalPeriod = determineActiveAuthPeriod(statusRows) ?? latestStatusPeriod;
  const { error: approveErr } = await supabase.from("visit_records").update({ auth_status: "approved" }).eq("patient_id", patientId).eq("auth_period", targetApprovalPeriod);
  if (approveErr) {
    console.error("[Supabase] approveAndCreateNewBatch approve:", approveErr);
    throw approveErr;
  }
  const patientUpdates = {};
  if (authDate) patientUpdates.auth_date = authDate.toISOString().split("T")[0];
  if (newInsurance && newInsurance.trim()) patientUpdates.insurance = newInsurance.trim();
  if (authValidUntil !== void 0) patientUpdates.auth_valid_until = authValidUntil ?? null;
  if (Object.keys(patientUpdates).length > 0) {
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
  const { data: inserted, error: insertErr } = await supabase.from("visit_records").insert(newRows).select("id");
  if (insertErr) {
    console.error("[Supabase] approveAndCreateNewBatch insert:", insertErr);
    throw insertErr;
  }
  const newVisitIds = (inserted ?? []).map((r) => r.id);
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
  const { data, error } = await supabase.from("clinic_users").select("*").eq("username", username).maybeSingle();
  if (error) {
    console.error("[Supabase] getClinicUserByUsername:", error);
    return void 0;
  }
  return data ? toClinicUser(data) : void 0;
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
async function createClaimRecord(data) {
  const { data: row, error } = await supabase.from("claims_records").insert({
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
    lmn: data.lmn ?? null
  }).select("id").single();
  if (error) {
    console.error("[Supabase] createClaimRecord:", error);
    throw error;
  }
  return row.id;
}
async function updateClaimRecord(id, data) {
  const update = {};
  if (data.placeOfService !== void 0) update.place_of_service = data.placeOfService;
  if (data.dateOfService !== void 0) {
    update.date_of_service = data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null;
  }
  if (data.visitNumber !== void 0) update.visit_number = data.visitNumber;
  if (data.cptCodes !== void 0) update.cpt_codes = data.cptCodes;
  if (data.unitsBilled !== void 0) update.units_billed = data.unitsBilled;
  if (data.diagnosisCodes !== void 0) update.diagnosis_codes = data.diagnosisCodes;
  if (data.modifier !== void 0) update.modifier = data.modifier;
  if (data.chargeAmount !== void 0) update.charge_amount = data.chargeAmount;
  if (data.insuranceReimbursement !== void 0) update.insurance_reimbursement = data.insuranceReimbursement;
  if (data.patientAmountPaid !== void 0) update.patient_amount_paid = data.patientAmountPaid;
  if (data.patientAmountDue !== void 0) update.patient_amount_due = data.patientAmountDue;
  if (data.insuranceBilled !== void 0) update.insurance_billed = data.insuranceBilled;
  if (data.oaClaimNumber !== void 0) update.oa_claim_number = data.oaClaimNumber;
  if (data.claimSubmittedDate !== void 0) {
    update.claim_submitted_date = data.claimSubmittedDate ? data.claimSubmittedDate.toISOString().split("T")[0] : null;
  }
  if (data.expireBcbsClaimNumber !== void 0) update.expire_bcbs_claim_number = data.expireBcbsClaimNumber;
  if (data.claimStatus !== void 0) update.claim_status = data.claimStatus;
  if (data.paymentReceived !== void 0) update.payment_received = data.paymentReceived;
  if (data.checkDate !== void 0) {
    update.check_date = data.checkDate ? data.checkDate.toISOString().split("T")[0] : null;
  }
  if (data.checkNumberVirtualCard !== void 0) update.check_number_virtual_card = data.checkNumberVirtualCard;
  if (data.dateReceived !== void 0) {
    update.date_received = data.dateReceived ? data.dateReceived.toISOString().split("T")[0] : null;
  }
  if (data.dateOfAppeal !== void 0) {
    update.date_of_appeal = data.dateOfAppeal ? data.dateOfAppeal.toISOString().split("T")[0] : null;
  }
  if (data.referenceNo !== void 0) update.reference_no = data.referenceNo;
  const { error } = await supabase.from("claims_records").update(update).eq("id", id);
  if (error) {
    console.error("[Supabase] updateClaimRecord:", error);
    throw error;
  }
}
async function deleteClaimRecord(id) {
  const { error } = await supabase.from("claims_records").delete().eq("id", id);
  if (error) {
    console.error("[Supabase] deleteClaimRecord:", error);
    throw error;
  }
}
async function upsertClaimRecord(data) {
  const dosStr = data.dateOfService ? data.dateOfService.toISOString().split("T")[0] : null;
  let existingId = null;
  if (dosStr) {
    let query = supabase.from("claims_records").select("id").eq("patient_id", data.patientId).eq("auth_period", data.authPeriod).eq("date_of_service", dosStr);
    if (data.cptCodes) {
      query = query.eq("cpt_codes", data.cptCodes);
    } else {
      query = query.is("cpt_codes", null);
    }
    const { data: existing } = await query.maybeSingle();
    existingId = existing ? existing.id : null;
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
    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from("claims_records").update(patch).eq("id", existingId);
      if (error) {
        console.error("[Supabase] upsertClaimRecord (update):", error);
        throw error;
      }
    }
    return existingId;
  }
  return createClaimRecord(data);
}
var FOLLOW_UP_STALE_DAYS, FOLLOW_UP_URGENCY_RANK, FOLLOW_UP_REASONS, CLAIM_STATUS_KEYS;
var init_db = __esm({
  "server/db.ts"() {
    "use strict";
    init_supabase();
    init_env();
    init_authPeriodMetrics();
    init_authUrgency();
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
  }
});

// server/nameMatch.ts
var nameMatch_exports = {};
__export(nameMatch_exports, {
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
var NAME_SUFFIXES;
var init_nameMatch = __esm({
  "server/nameMatch.ts"() {
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
    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name
    }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expirationSeconds).sign(secretKey);
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
      const { openId, appId, name } = payload;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }
      return {
        openId,
        appId,
        name
      };
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
  for (let section of patientSections) {
    if (!section.includes("Claim #:")) continue;
    const claimTotalIdx = section.indexOf("Claim Total:");
    if (claimTotalIdx !== -1) {
      section = section.slice(0, claimTotalIdx);
    }
    const nameMatch = section.match(/Patient:\s+([A-Z][A-Z\s]+?)(?=\s{2,}|\n)/);
    const patientName = nameMatch ? nameMatch[1].trim() : "UNKNOWN";
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
        // Charge is a CMS-1500-only field. dateOfService/cptCodes above stay
        // populated even on a Reimbursement/EOB upload — they're the upsert
        // match key used to attach this payment to its existing CMS-1500
        // row, not reimbursement "value" data.
        chargeAmount: null,
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
    const modifier = cm2[9].trim().split(/\s+/)[0];
    const chargeAmount = parseMoney(cm2[11]);
    const units = parseInt(cm2[12], 10);
    const visitNumber = clampVisitNumber(compactRowCounter);
    const dateKey = fromDate || "no-date";
    if (!dateMap.has(dateKey)) {
      dateMap.set(dateKey, {
        dateOfService: fromDate,
        placeOfService,
        diagnosisCodes: allDiagCodes || null,
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
      diagnosisCodes: allDiagCodes || null
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
          diagnosisCodes: allDiagCodes || null,
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
        diagnosisCodes: allDiagCodes || null
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

*** DOCUMENT-TYPE BOUNDARY: This is a Reimbursement/EOB document. Only extract payment-side data \u2014 insuranceReimbursement, patientAmountPaid, patientAmountDue, oaClaimNumber (Claim #), checkDate (Check/Payment Date), and checkNumberVirtualCard (Check/EFT) \u2014 plus dateOfService and cptCodes, which you extract ONLY to identify which existing claim this payment applies to, never as billing data. NEVER extract placeOfService, diagnosisCodes, unitsBilled, modifier, or chargeAmount \u2014 those belong exclusively to CMS-1500 claim forms and must not appear on a Reimbursement/EOB record. ***

Payers lay these documents out very differently \u2014 a table of many patients on one page, a single-patient web-portal export, a per-claim narrative block, etc. Do not assume there is only one patient name at the top of the document: scan the ENTIRE document and re-identify the patient name at each claim/service-line block, since one EOB commonly covers many different patients (e.g. a check remitting payment for a whole clinic's batch of claims).

For each claim/service line, extract EVERY one of these fields when it appears anywhere in the document \u2014 a payment line's reimbursement, patient-paid, patient-due, claim #, check date, and check/EFT number are often printed in different parts of the same claim block, not all in one place, so check the whole block before leaving any of them null:
- patientName: REQUIRED - full name exactly as shown next to that specific claim (e.g., "JOHN SMITH" or "Smith, John" or "JOHN M SMITH"). Never reuse a different claim's patient name.
- dateOfService: MM/DD/YYYY format \u2014 extracted only to match this payment to the correct existing claim record, not as reimbursement data
- cptCodes: CPT/HCPCS code(s), comma-separated if multiple \u2014 extracted only to match this payment to the correct existing claim record, not as reimbursement data
- insuranceReimbursement: insurance reimbursement/allowed/paid amount (numeric only)
- patientAmountPaid: patient co-pay amount already paid (numeric only)
- patientAmountDue: patient balance/responsibility still due (numeric only)
- oaClaimNumber: claim number/ID/ICN/reference number for this claim \u2014 copy it character-for-character exactly as printed; never reformat, abbreviate, or invent one
- checkDate: check/payment/EFT date in MM/DD/YYYY format
- checkNumberVirtualCard: check number, EFT trace number, or virtual card number
- claimStatus: one of "approved", "denied", or "submitted" (infer from context \u2014 e.g. a $0 paid line with a denial code is "denied"; a line with a payment amount is "approved")
- insuranceBilled: the NUMERIC billing/group/payer identifier for this claim \u2014 e.g. "Group #", "Group Number", "Group No", "Group ID", "Billing ID", "Billing Number", "Payer ID", "Payer Number", or a slash-separated identifier like "16404/137040261". This is NEVER the insurance company/payer name (do not write "Aetna", "Meritain Health", "BCBS", "Cigna", etc. here \u2014 that is a completely different field, not this one). If no such numeric identifier is visible anywhere in this claim's block, use null \u2014 do not substitute the payer name as a fallback.
- visitNumber: Always return null for EOB documents. Visit number comes only from CMS-1500 forms.

FIELD NAME VARIATIONS \u2014 the same data point is labeled differently across payers; map by meaning, not by exact label. Some payers print several *different, non-interchangeable* dollar columns \u2014 read carefully, don't just grab the first similar-sounding label:
- Insurance Reimbursement = the amount the payer actually PAID/will pay: "Paid Amount", "Payable Amount", "Plan Paid", "Claim Payment Amount". This is NOT the same as "Allowed Amount"/"Allowable"/"QPA" \u2014 that is only the contractually recognized rate the patient-responsibility math is based on, and is often larger than what was actually paid (especially out-of-network). If both an "Allowed" and a "Paid"/"Payable" column exist, use the "Paid"/"Payable" one.
- Patient Due = the patient's owed balance under the plan: "Patient Responsibility", "Patient Resp", "Balance Due", or Copay + Deductible + Coinsurance summed. Some EOBs separately print a "Not Payable"/"Not Covered" column for amounts the plan simply doesn't cover \u2014 that is a different concept from Patient Responsibility (it's often only billable to the patient if a separate balance-billing agreement applies) \u2014 prefer the explicit "Patient Responsibility" figure when both are present.
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
  "patientAmountDue"
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
  "diagnosisCodes",
  "unitsBilled",
  "modifier",
  "chargeAmount",
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
            if (detection.confidence > 0.7 && detection.documentType === "cms1500") {
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
        const templateResult = tryTemplateExtraction(reimbursementText, originalname);
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
          console.log(`[ClaimUpload] Stage 7/7 \u2014 Database save pending: ${templateResult.claims.length} claim(s) via template "${templateResult.templateName}"`);
          res.json({
            claims: templateResult.claims,
            patientGroups: templateResult.patientGroups ?? null,
            extractedLength: extractedText.length,
            templateUsed: templateResult.templateName,
            uploadType: "reimbursement"
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
var t = initTRPC.context().create({
  transformer: superjson
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
var adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError2({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user
      }
    });
  })
);

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

// server/_core/loginRateLimit.ts
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
function normalizeUsername(username) {
  return username.trim().toLowerCase();
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
  authStatus: z2.enum(["none", "pending", "approved", "denied"]).optional()
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
var appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
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
      const syntheticOpenId = `clinic_${clinicUser.username}`;
      const token = await sdk.createSessionToken(syntheticOpenId, {
        name: clinicUser.username,
        expiresInMs: ONE_YEAR_MS
      });
      const { upsertUser: upsertUser2 } = await Promise.resolve().then(() => (init_db(), db_exports));
      await upsertUser2({
        openId: syntheticOpenId,
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
    })
  }),
  // ── Patients ────────────────────────────────────────────────────────────────
  patients: router({
    list: protectedProcedure.query(async () => {
      return getAllPatients();
    }),
    get: protectedProcedure.input(z2.object({ id: z2.string().uuid() })).query(async ({ input }) => {
      const patient = await getPatientById(input.id);
      if (!patient) throw new TRPCError3({ code: "NOT_FOUND", message: "Patient not found" });
      return patient;
    }),
    create: protectedProcedure.input(
      z2.object({
        name: z2.string().min(1),
        insurance: z2.string().default(""),
        authDate: z2.string().nullable().optional(),
        authValidUntil: z2.number().nullable().optional()
        // Unix ms timestamp
      })
    ).mutation(async ({ input }) => {
      const id = await createPatient({
        name: input.name,
        insurance: input.insurance,
        authDate: parseDate2(input.authDate),
        authValidUntil: input.authValidUntil ?? null
      });
      return { id };
    }),
    update: protectedProcedure.input(
      z2.object({
        id: z2.string().uuid(),
        name: z2.string().min(1).optional(),
        insurance: z2.string().optional(),
        authDate: z2.string().nullable().optional(),
        authValidUntil: z2.number().nullable().optional(),
        claimsStatus: z2.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted"]).optional()
      })
    ).mutation(async ({ input }) => {
      const { id, authDate, authValidUntil, claimsStatus, ...rest } = input;
      await updatePatient(id, {
        ...rest,
        ...authDate !== void 0 ? { authDate: parseDate2(authDate) } : {},
        ...authValidUntil !== void 0 ? { authValidUntil } : {},
        ...claimsStatus !== void 0 ? { claimsStatus } : {}
      });
      return { success: true };
    }),
    delete: protectedProcedure.input(z2.object({ id: z2.string().uuid() })).mutation(async ({ input }) => {
      await deletePatient(input.id);
      return { success: true };
    }),
    setActive: protectedProcedure.input(z2.object({
      id: z2.string().uuid(),
      isActive: z2.boolean(),
      dischargeDate: z2.number().nullable().optional(),
      dischargeReason: z2.string().nullable().optional()
    })).mutation(async ({ input }) => {
      await setPatientActive(input.id, input.isActive, input.dischargeDate, input.dischargeReason);
      return { success: true };
    })
  }),
  // ── Visit Records ────────────────────────────────────────────────────────────
  visits: router({
    listByPatient: protectedProcedure.input(z2.object({ patientId: z2.string().uuid() })).query(async ({ input }) => {
      return getVisitsByPatientId(input.patientId);
    }),
    create: protectedProcedure.input(visitRecordInput.extend({ patientId: z2.string().uuid() })).mutation(async ({ input }) => {
      const { patientId, dateOfService, dateAshSubmitted, ...rest } = input;
      const id = await createVisitRecord({
        patientId,
        ...rest,
        dateOfService: parseDate2(dateOfService),
        dateAshSubmitted: parseDate2(dateAshSubmitted)
      });
      return { id };
    }),
    update: protectedProcedure.input(visitRecordInput.extend({ id: z2.string().uuid() })).mutation(async ({ input }) => {
      const { id, dateOfService, dateAshSubmitted, ...rest } = input;
      await updateVisitRecord(id, {
        ...rest,
        ...dateOfService !== void 0 ? { dateOfService: parseDate2(dateOfService) } : {},
        ...dateAshSubmitted !== void 0 ? { dateAshSubmitted: parseDate2(dateAshSubmitted) } : {}
      });
      return { success: true };
    }),
    bulkCreate: protectedProcedure.input(
      z2.object({
        patientId: z2.string().uuid(),
        records: z2.array(visitRecordInput)
      })
    ).mutation(async ({ input }) => {
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
      await bulkCreateVisitRecords(rows);
      return { success: true };
    }),
    // Returns urgency summaries for ALL patients — used by the homepage alert panel
    authAlerts: protectedProcedure.query(async () => {
      return getAuthAlertSummaries();
    }),
    // Approves a pending authorization and creates a new batch of visit records
    approveAuthorization: protectedProcedure.input(z2.object({
      patientId: z2.string().uuid(),
      sessionsAuthorized: z2.number().min(1).max(200),
      authDate: z2.string().nullable().optional(),
      // ISO date string "YYYY-MM-DD"
      newInsurance: z2.string().optional(),
      // optional insurance change for new period
      authValidUntil: z2.number().nullable().optional()
      // Unix ms timestamp for expiry
    })).mutation(async ({ input }) => {
      const authDate = input.authDate ? /* @__PURE__ */ new Date(input.authDate + "T00:00:00Z") : null;
      const { newVisitIds } = await approveAndCreateNewBatch(
        input.patientId,
        input.sessionsAuthorized,
        authDate,
        input.newInsurance,
        input.authValidUntil ?? void 0
      );
      return { success: true, newVisitCount: newVisitIds.length };
    }),
    // Returns IDs of patients whose sessions are fully completed (0 remaining + all dated)
    completedPatientIds: protectedProcedure.query(async () => {
      return getCompletedPatients();
    }),
    // Sets the active-period visit row (same period getAuthAlertSummaries is
    // showing) to authStatus=pending + today's dateAshSubmitted
    markAsRequested: protectedProcedure.input(z2.object({ patientId: z2.string().uuid() })).mutation(async ({ input }) => {
      const visitId = await getMarkAsRequestedTargetVisitId(input.patientId);
      if (!visitId) throw new TRPCError3({ code: "NOT_FOUND", message: "No visit records found for this patient" });
      const today = /* @__PURE__ */ new Date();
      const todayMidnight = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
      await updateVisitRecord(visitId, {
        authStatus: "pending",
        dateAshSubmitted: todayMidnight
      });
      return { success: true, visitId, date: todayMidnight.toISOString().split("T")[0] };
    })
  }),
  claims: router({
    getByPatientAndPeriod: protectedProcedure.input(z2.object({ patientId: z2.string().uuid(), authPeriod: z2.number() })).query(async ({ input }) => {
      return await getClaimsByPatientAndPeriod(input.patientId, input.authPeriod);
    }),
    create: protectedProcedure.input(z2.object({
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
      claimStatus: z2.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted"]).optional(),
      paymentReceived: z2.number().nullable().optional(),
      checkDate: z2.string().nullable().optional(),
      checkNumberVirtualCard: z2.string().nullable().optional(),
      dateReceived: z2.string().nullable().optional(),
      dateOfAppeal: z2.string().nullable().optional(),
      referenceNo: z2.string().nullable().optional(),
      lmn: z2.string().nullable().optional()
    })).mutation(async ({ input }) => {
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
      });
      return { success: true, claimId };
    }),
    update: protectedProcedure.input(z2.object({
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
      claimStatus: z2.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted"]).optional(),
      paymentReceived: z2.number().nullable().optional(),
      checkDate: z2.string().nullable().optional(),
      checkNumberVirtualCard: z2.string().nullable().optional(),
      dateReceived: z2.string().nullable().optional(),
      dateOfAppeal: z2.string().nullable().optional(),
      referenceNo: z2.string().nullable().optional()
    })).mutation(async ({ input }) => {
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
      });
      return { success: true };
    }),
    delete: protectedProcedure.input(z2.object({ id: z2.string().uuid() })).mutation(async ({ input }) => {
      await deleteClaimRecord(input.id);
      return { success: true };
    }),
    upsert: protectedProcedure.input(z2.object({
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
      claimStatus: z2.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted"]).optional(),
      paymentReceived: z2.number().nullable().optional(),
      checkDate: z2.string().nullable().optional(),
      checkNumberVirtualCard: z2.string().nullable().optional(),
      dateReceived: z2.string().nullable().optional(),
      dateOfAppeal: z2.string().nullable().optional(),
      referenceNo: z2.string().nullable().optional(),
      lmn: z2.string().nullable().optional()
    })).mutation(async ({ input }) => {
      await upsertClaimRecord({
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
      });
      return { success: true };
    }),
    /**
     * Bulk import claims from a multi-patient EOB file.
     * Matches patient names (case-insensitive) against dashboard patients,
     * finds each patient's latest auth period, and saves all their claims.
     */
    bulkImportFromEOB: protectedProcedure.input(z2.object({
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
          claimStatus: z2.enum(["submitted", "approved", "pending", "denied", "pended", "rejected", "resubmitted"]).optional(),
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
      }))
    })).mutation(async ({ input }) => {
      const { supabase: supabase2 } = await Promise.resolve().then(() => (init_supabase(), supabase_exports));
      const allPatients = await getAllPatients();
      const uploadType = input.uploadType ?? "reimbursement";
      const results = [];
      for (const group of input.patientGroups) {
        const { findMatchingPatient: findMatchingPatient2 } = await Promise.resolve().then(() => (init_nameMatch(), nameMatch_exports));
        const matchedPatient = findMatchingPatient2(group.patientName, allPatients);
        if (!matchedPatient) {
          results.push({
            patientName: group.patientName,
            matched: false,
            claimsImported: 0
          });
          continue;
        }
        const { data: periodRows } = await supabase2.from("visit_records").select("auth_period").eq("patient_id", matchedPatient.id);
        const maxPeriod = periodRows && periodRows.length > 0 ? Math.max(...periodRows.map((r) => r.auth_period ?? 1)) : 1;
        let claimsImported = 0;
        try {
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
            for (const line of lines) {
              const isReimb = uploadType === "reimbursement";
              const isCms = uploadType === "cms1500";
              const cptForMatch = line.cptCodes ?? null;
              await upsertClaimRecord({
                patientId: matchedPatient.id,
                authPeriod: maxPeriod,
                // ── Match key fields (always provided) ─────────────────────────────
                dateOfService: parseDate2(claim.dateOfService),
                // always save DOS for identification
                cptCodes: cptForMatch,
                // always used for matching; written for both types
                // ── Fields for BOTH upload types ──────────────────────────────
                claimStatus: claim.claimStatus ?? "submitted",
                // ── Reimbursement Insurance upload fields ─────────────────────
                // Saves: Insurance Reimbursement, Pt Paid, Pt Due,
                //        Claim #, Check/Payment Date, Check/EFT
                oaClaimNumber: isReimb ? claim.oaClaimNumber ?? null : null,
                // Claim #
                insuranceReimbursement: isReimb ? line.insuranceReimbursement ?? null : null,
                patientAmountPaid: isReimb ? line.patientAmountPaid ?? null : null,
                // Pt Paid
                patientAmountDue: isReimb ? line.patientAmountDue ?? null : null,
                // Pt Due
                checkDate: isReimb ? parseDate2(claim.checkDate) : null,
                // Check/Payment Date
                checkNumberVirtualCard: isReimb ? claim.checkNumberVirtualCard ?? null : null,
                // Check/EFT
                referenceNo: isReimb ? claim.referenceNo ?? null : null,
                insuranceBilled: isReimb ? claim.insuranceBilled ?? null : null,
                paymentReceived: isReimb ? line.insuranceReimbursement ?? null : null,
                // ── CMS1500 upload fields ─────────────────────────────────────
                // Saves: Date of Service, Place of Service, Diagnosis Codes,
                //        Units Billed, Modifier, CPT Code, Units, Charge, Date Submitted
                placeOfService: isCms ? claim.placeOfService ?? null : null,
                visitNumber: isCms ? claim.visitNumber ?? null : null,
                unitsBilled: isCms ? line.unitsBilled ?? null : null,
                diagnosisCodes: isCms ? line.diagnosisCodes ?? null : null,
                modifier: isCms ? line.modifier ?? null : null,
                chargeAmount: isCms ? line.chargeAmount ?? null : null,
                claimSubmittedDate: isCms ? parseDate2(claim.claimSubmittedDate) : null,
                expireBcbsClaimNumber: isCms ? claim.expireBcbsClaimNumber ?? null : null,
                // ── Shared optional fields ────────────────────────────────────
                dateReceived: parseDate2(claim.dateReceived),
                dateOfAppeal: parseDate2(claim.dateOfAppeal),
                lmn: claim.lmn ?? null
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
            claimsImported
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
    markResolved: protectedProcedure.input(z2.object({ id: z2.string().uuid() })).mutation(async ({ input }) => {
      const { supabase: supabase2 } = await Promise.resolve().then(() => (init_supabase(), supabase_exports));
      const { error } = await supabase2.from("claims_records").update({ is_resolved: true, claim_status: "pending" }).eq("id", input.id);
      if (error) throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return { success: true };
    }),
    getFollowUpClaims: protectedProcedure.input(z2.object({ insurance: z2.string().optional() }).optional()).query(async ({ input }) => {
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
    getStatusCounts: protectedProcedure.input(z2.object({ insurance: z2.string().optional() }).optional()).query(async ({ input }) => {
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
