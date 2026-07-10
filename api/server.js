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
      forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
      forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
    };
  }
});

// server/db.ts
var db_exports = {};
__export(db_exports, {
  approveAndCreateNewBatch: () => approveAndCreateNewBatch,
  bulkCreateVisitRecords: () => bulkCreateVisitRecords,
  createClaimRecord: () => createClaimRecord,
  createPatient: () => createPatient,
  createVisitRecord: () => createVisitRecord,
  deleteClaimRecord: () => deleteClaimRecord,
  deletePatient: () => deletePatient,
  getAllPatients: () => getAllPatients,
  getAuthAlertSummaries: () => getAuthAlertSummaries,
  getClaimsByPatientAndPeriod: () => getClaimsByPatientAndPeriod,
  getClinicUserByUsername: () => getClinicUserByUsername,
  getCompletedPatients: () => getCompletedPatients,
  getLatestVisitIdForPatient: () => getLatestVisitIdForPatient,
  getPatientById: () => getPatientById,
  getUserByOpenId: () => getUserByOpenId,
  getVisitsByPatientId: () => getVisitsByPatientId,
  setPatientActive: () => setPatientActive,
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
        authValidUntil: patient.authValidUntil ?? null
      };
    }
    const allPeriods = Array.from(new Set(pVisits.map((v) => v.authPeriod ?? 1))).sort((a, b) => a - b);
    let activePeriod = null;
    for (const period of allPeriods) {
      const periodVisits = pVisits.filter((v) => (v.authPeriod ?? 1) === period);
      const authRow2 = periodVisits.find((v) => v.sessionsAuthorized != null);
      const periodAuthorized = authRow2?.sessionsAuthorized ?? 0;
      const periodCompleted = periodVisits.filter((v) => v.dateOfService != null).length;
      const periodRemaining = Math.max(0, periodAuthorized - periodCompleted);
      if (periodRemaining > 0) {
        activePeriod = period;
        break;
      }
    }
    const latestPeriod = allPeriods[allPeriods.length - 1];
    const targetPeriod = activePeriod ?? latestPeriod;
    const targetVisits = pVisits.filter((v) => (v.authPeriod ?? 1) === targetPeriod);
    const authRow = targetVisits.find((v) => v.sessionsAuthorized != null);
    const sessionsAuthorized = authRow?.sessionsAuthorized ?? null;
    const completed = targetVisits.filter((v) => v.dateOfService != null).length;
    const sessionsRemaining = activePeriod !== null ? Math.max(0, (sessionsAuthorized ?? 0) - completed) : 0;
    const lastActiveRow = targetVisits[targetVisits.length - 1];
    const authStatus = lastActiveRow?.authStatus ?? "none";
    const dateAshSubmitted = lastActiveRow?.dateAshSubmitted ?? null;
    let urgency = "ok";
    if (sessionsRemaining === 0) urgency = "exhausted";
    else if (sessionsRemaining <= 2) urgency = "critical";
    else if (sessionsRemaining <= 3) urgency = "warning";
    if (authStatus === "pending" && urgency === "ok") urgency = "pending";
    if (authStatus === "denied") urgency = "exhausted";
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1e3;
    const authValidUntil = patient.authValidUntil ?? null;
    const expiresWithin7Days = authValidUntil !== null && authValidUntil > now && authValidUntil - now <= sevenDaysMs;
    const alreadyExpired = authValidUntil !== null && authValidUntil < now;
    const authExpiryWarning = (expiresWithin7Days || alreadyExpired) && urgency === "ok";
    if (authExpiryWarning) urgency = "warning";
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
      authExpiryWarning
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
async function approveAndCreateNewBatch(patientId, sessionsAuthorized, authDate, newInsurance, authValidUntil) {
  const { error: approveErr } = await supabase.from("visit_records").update({ auth_status: "approved" }).eq("patient_id", patientId);
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
  const { data: allVisits, error: vErr } = await supabase.from("visit_records").select("id, patient_id, date_of_service, sessions_remaining, auth_period, session_number");
  if (vErr) {
    console.error("[Supabase] getCompletedPatients visits:", vErr);
    return [];
  }
  const visits = allVisits ?? [];
  return allPatients.filter((patient) => {
    const pVisits = visits.filter((v) => v.patient_id === patient.id);
    if (pVisits.length === 0) return false;
    const sorted = [...pVisits].sort((a, b) => {
      const pd = (a.auth_period ?? 1) - (b.auth_period ?? 1);
      if (pd !== 0) return pd;
      return (a.session_number ?? 0) - (b.session_number ?? 0);
    });
    const latest = sorted[sorted.length - 1];
    if (latest.sessions_remaining !== 0) return false;
    return pVisits.every((v) => v.date_of_service != null);
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
async function getClaimsByPatientAndPeriod(patientId, authPeriod) {
  const { data, error } = await supabase.from("claims_records").select("*").eq("patient_id", patientId).eq("auth_period", authPeriod).order("date_of_service", { ascending: false });
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
var init_db = __esm({
  "server/db.ts"() {
    "use strict";
    init_supabase();
    init_env();
  }
});

// server/nameMatch.ts
var nameMatch_exports = {};
__export(nameMatch_exports, {
  findMatchingPatient: () => findMatchingPatient,
  fuzzyNameMatch: () => fuzzyNameMatch
});
function normalizeName(name) {
  return name.toUpperCase().replace(/[,\.]/g, " ").replace(/\s+/g, " ").trim();
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
function tokenSetMatch(tokensA, tokensB) {
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  return shorter.every((t2) => longer.includes(t2));
}
function lastNameFirstInitialMatch(tokensA, tokensB) {
  if (tokensA.length < 1 || tokensB.length < 1) return false;
  for (const a of tokensA) {
    for (const b of tokensB) {
      if (a === b) {
        const aOthers = tokensA.filter((t2) => t2 !== a);
        const bOthers = tokensB.filter((t2) => t2 !== b);
        if (aOthers.length === 0 || bOthers.length === 0) continue;
        if (aOthers[0][0] === bOthers[0][0]) return true;
      }
    }
  }
  return false;
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
  if (lastNameFirstInitialMatch(tokensEob, tokensDash)) return true;
  if (tokensEob.length >= 2 && tokensDash.length >= 2) {
    if (tokenSetMatch(tokensEob, tokensDash)) return true;
  }
  return false;
}
function findMatchingPatient(eobName, patients) {
  const exact = patients.find(
    (p) => normalizeName(p.name) === normalizeName(eobName)
  );
  if (exact) return exact;
  return patients.find((p) => fuzzyNameMatch(eobName, p.name)) ?? null;
}
var init_nameMatch = __esm({
  "server/nameMatch.ts"() {
    "use strict";
  }
});

// api/server.ts
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
function registerStorageProxy(app2) {
  app2.get("/manus-storage/*", async (req, res) => {
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
var resolveApiUrl = () => ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0 ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions` : "https://forge.manus.im/v1/chat/completions";
var assertApiKey = () => {
  if (!ENV.forgeApiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
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
        `LLM request retry ${attempt + 1}/${RETRY_MAX_RETRIES} after status ${response.status}`
      );
      await sleep(computeBackoffDelay(attempt, retryAfterMs));
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_MAX_RETRIES) throw error;
      console.warn(
        `LLM request retry ${attempt + 1}/${RETRY_MAX_RETRIES} after network error`
      );
      await sleep(computeBackoffDelay(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("LLM request failed after exhausting retries");
};
async function invokeLLM(params) {
  assertApiKey();
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
    messages: messages.map(normalizeMessage)
  };
  if (model) {
    payload.model = model;
  }
  if (tools && tools.length > 0) {
    payload.tools = tools;
  }
  const normalizedToolChoice = normalizeToolChoice(
    toolChoice || tool_choice,
    tools
  );
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }
  const resolvedMaxTokens = max_tokens ?? maxTokens;
  if (typeof resolvedMaxTokens === "number") {
    payload.max_tokens = resolvedMaxTokens;
  }
  if (thinking) {
    payload.thinking = thinking;
  }
  if (reasoning) {
    payload.reasoning = reasoning;
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
  const response = await fetchWithBackoff(resolveApiUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.forgeApiKey}`
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `LLM invoke failed: ${response.status} ${response.statusText} \u2013 ${errorText}`
    );
  }
  return await response.json();
}

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
    let visitNum = patientClaims.length + 1;
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
        chargeAmount: totalCharge,
        insuranceReimbursement: notPaymentAmount,
        patientAmountPaid: coPayAmountFromLine,
        insuranceBilled: "Meritain Health",
        oaClaimNumber: claimNo,
        claimStatus,
        checkDate: docPaymentDate,
        dateReceived: docPaymentDate,
        referenceNo: epcDraftNo,
        checkNumberVirtualCard: checkEftNumber,
        visitNumber: visitNum++,
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
  while ((cm2 = compactPattern.exec(serviceArea)) !== null) {
    const fromDate = parseCMS1500Date(cm2[1], cm2[2], cm2[3]);
    const placeOfService = cm2[7];
    const cptCode = cm2[8];
    const modifier = cm2[9].trim().split(/\s+/)[0];
    const chargeAmount = parseMoney(cm2[11]);
    const units = parseInt(cm2[12], 10);
    const dateKey = fromDate || "no-date";
    if (!dateMap.has(dateKey)) {
      dateMap.set(dateKey, {
        dateOfService: fromDate,
        placeOfService,
        diagnosisCodes: allDiagCodes || null,
        claimSubmittedDate: dateSubmitted,
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
      const dateKey = fromDate || "no-date";
      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, {
          dateOfService: fromDate,
          placeOfService,
          diagnosisCodes: allDiagCodes || null,
          claimSubmittedDate: dateSubmitted,
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

// server/openaiExtractor.ts
async function extractClaimsWithOpenAI(pdfText, uploadType) {
  const systemPrompt = uploadType === "reimbursement" ? `You are a medical claims data extraction specialist. Extract all Explanation of Benefits (EOB) claim information accurately from the provided document text.

*** CRITICAL: You MUST extract the PATIENT NAME for EACH claim. This is required for matching against the clinic's patient database. ***

For each claim, extract:
- patientName: REQUIRED - full name as shown on document (e.g., "JOHN SMITH" or "Smith, John" or "JOHN M SMITH")
- dateOfService: MM/DD/YYYY format
- cptCodes: CPT code(s), comma-separated if multiple
- chargeAmount: total charge amount (numeric only, no $ sign)
- insuranceReimbursement: insurance reimbursement/allowed amount (numeric only)
- patientAmountPaid: patient co-pay amount (numeric only)
- patientAmountDue: patient balance due (numeric only)
- oaClaimNumber: claim number
- checkDate: check/payment date in MM/DD/YYYY format
- checkNumberVirtualCard: check number or virtual card number
- claimStatus: one of "approved", "denied", or "submitted"

IMPORTANT:
- If patient name appears in document header/top section, use it for ALL claims in that section
- If multiple patients in document, create separate claim objects for each patient
- Patient name is REQUIRED - never leave it null or empty
- Return ONLY valid JSON, no markdown or explanations.` : `You are a medical claims data extraction specialist. Extract all CMS-1500 Health Insurance Claim Form information accurately from the provided document text.

*** CRITICAL: You MUST extract the PATIENT NAME from Box 2. This is required for matching against the clinic's patient database. ***

For each claim, extract:
- patientName: REQUIRED - from Box 2 of form (e.g., "JOHN SMITH" or "Smith, John")
- dateOfService: MM/DD/YYYY format (from Box 24A)
- placeOfService: place of service code (from Box 24B)
- cptCodes: CPT/HCPCS code(s), comma-separated if multiple (from Box 24D)
- diagnosisCodes: ICD-10 diagnosis codes, comma-separated (from Box 21)
- unitsBilled: units billed (from Box 24G)
- modifier: modifier codes if present (from Box 24D)
- chargeAmount: total charge amount (numeric only)

IMPORTANT:
- Patient name is REQUIRED - never leave it null or empty
- Return ONLY valid JSON, no markdown or explanations.`;
  const userPrompt = uploadType === "reimbursement" ? `Extract all EOB claims from this document. IMPORTANT: Make sure to extract the patient name for each claim.

${pdfText}` : `Extract all CMS-1500 claims from this document. IMPORTANT: Make sure to extract the patient name from Box 2 for each claim.

${pdfText}`;
  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userPrompt
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
                  properties: {
                    patientName: { type: "string" },
                    // REQUIRED
                    dateOfService: { type: ["string", "null"] },
                    cptCodes: { type: ["string", "null"] },
                    chargeAmount: { type: ["number", "null"] },
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
                    placeOfService: { type: ["string", "null"] },
                    diagnosisCodes: { type: ["string", "null"] },
                    unitsBilled: { type: ["number", "null"] },
                    modifier: { type: ["string", "null"] }
                  },
                  required: ["patientName", "claimStatus"]
                }
              },
              detectedInsurer: { type: ["string", "null"] },
              confidence: { type: "number" },
              extractionNotes: { type: ["string", "null"] }
            },
            required: ["claims"]
          }
        }
      }
    });
    const content = response.choices[0].message.content;
    if (!content || typeof content !== "string") {
      throw new Error("No response from OpenAI");
    }
    const parsed = JSON.parse(content);
    const normalizedClaims = (parsed.claims || []).map(
      (claim) => ({
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
        insuranceBilled: parsed.detectedInsurer || "Unknown",
        claimSubmittedDate: null,
        expireBcbsClaimNumber: null,
        paymentReceived: null,
        lmn: null,
        dateReceived: null,
        referenceNo: null,
        visitNumber: 0,
        dateOfAppeal: null,
        notes: parsed.extractionNotes || null
      })
    );
    const uniquePatientNames = new Set(
      parsed.claims.map((c) => c.patientName?.toUpperCase().trim())
    );
    const patientName = uniquePatientNames.size === 1 ? Array.from(uniquePatientNames)[0] : void 0;
    return {
      claims: normalizedClaims,
      confidence: parsed.confidence || 0.8,
      detectedInsurer: parsed.detectedInsurer,
      extractionNotes: parsed.extractionNotes,
      patientName
    };
  } catch (error) {
    console.error("[OpenAI Extraction Error]", error);
    throw new Error(
      `Failed to extract claims with OpenAI: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
async function detectInsuranceType(pdfText) {
  try {
    const response = await invokeLLM({
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
            required: ["insurer", "documentType", "confidence"]
          }
        }
      }
    });
    const content = response.choices[0].message.content;
    if (!content || typeof content !== "string") {
      throw new Error("No response from OpenAI");
    }
    return JSON.parse(content);
  } catch (error) {
    console.error("[Insurance Detection Error]", error);
    return {
      insurer: "Unknown",
      documentType: "other",
      confidence: 0
    };
  }
}

// server/claimUpload.ts
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
- visitNumber: number \u2014 visit or service line number
- cptCodes: string \u2014 CPT/procedure codes (comma-separated if multiple)
- unitsBilled: number \u2014 units billed
- diagnosisCodes: string \u2014 ICD-10 diagnosis codes (comma-separated)
- modifier: string \u2014 modifier codes
- chargeAmount: number \u2014 total charge/billed amount (numeric, no $ sign)
- insuranceReimbursement: number \u2014 amount paid/reimbursed by insurance (numeric, no $ sign)
- patientAmountPaid: number \u2014 amount paid by patient
- patientAmountDue: number \u2014 patient balance/amount due
- insuranceBilled: string \u2014 insurance company name
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
        const isXlsx = name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".xlsm") || mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mimetype === "application/vnd.ms-excel.sheet.macroEnabled.12";
        const isCsv = !isXlsx && (mimetype === "text/csv" || name.endsWith(".csv"));
        if (isXlsx) {
          extractedText = extractXlsxText(buffer);
        } else if (isCsv) {
          extractedText = extractCsvText(buffer);
        } else {
          extractedText = await extractPdfText(buffer);
        }
        if (!extractedText.trim()) {
          res.status(422).json({ error: "Could not extract any text from the file. Please ensure it is a digital (not scanned) PDF, a valid CSV, or a valid Excel file." });
          return;
        }
        let uploadType = req.body?.uploadType || "reimbursement";
        if (!req.body?.uploadType && !isXlsx && !isCsv) {
          try {
            const detection = await detectInsuranceType(extractedText);
            console.log(`[ClaimUpload] Detected: ${detection.insurer} (${detection.documentType}, confidence: ${detection.confidence})`);
            if (detection.confidence > 0.7 && detection.documentType === "cms1500") {
              uploadType = "cms1500";
              console.log("[ClaimUpload] Auto-detected CMS1500 format");
            }
          } catch (error) {
            console.error("[ClaimUpload] Document type detection failed:", error);
          }
        }
        if (uploadType === "cms1500") {
          let cms1500Text = extractedText;
          if (!isXlsx && !isCsv) {
            try {
              cms1500Text = extractPdfTextLayout(buffer);
            } catch {
            }
          }
          const patientGroups = parseCMS1500(cms1500Text);
          const flatClaims = patientGroups.flatMap((g) => g.claims);
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
          } catch {
            reimbursementText = extractedText;
          }
        }
        const templateResult = tryTemplateExtraction(reimbursementText, originalname);
        if (templateResult && templateResult.claims.length > 0) {
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
          console.log("[ClaimUpload] No template matched, using OpenAI extraction...");
          const openaiResult = await extractClaimsWithOpenAI(reimbursementText, "reimbursement");
          if (openaiResult.claims.length > 0) {
            console.log(`[ClaimUpload] OpenAI extracted ${openaiResult.claims.length} claims for patient: ${openaiResult.patientName}`);
            let patientGroups = null;
            if (openaiResult.patientName) {
              patientGroups = [{
                patientName: openaiResult.patientName,
                claims: openaiResult.claims
              }];
            }
            res.json({
              claims: openaiResult.claims,
              patientGroups,
              extractedLength: extractedText.length,
              templateUsed: `OpenAI (${openaiResult.detectedInsurer || "Unknown"})`,
              uploadType: "reimbursement",
              confidence: openaiResult.confidence,
              extractionNotes: openaiResult.extractionNotes
            });
            return;
          }
        } catch (openaiError) {
          console.error("[ClaimUpload] OpenAI extraction failed:", openaiError);
        }
        console.log("[ClaimUpload] OpenAI failed, using legacy AI extraction...");
        const claims = await mapToClaimColumns(extractedText);
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
  const d = /* @__PURE__ */ new Date(s + "T00:00:00Z");
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
      const clinicUser = await getClinicUserByUsername(input.username);
      if (!clinicUser) {
        throw new TRPCError3({ code: "UNAUTHORIZED", message: "Invalid username or password" });
      }
      const valid = await bcrypt.compare(input.password, clinicUser.passwordHash);
      if (!valid) {
        throw new TRPCError3({ code: "UNAUTHORIZED", message: "Invalid username or password" });
      }
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
    // Sets the latest visit row for a patient to authStatus=pending + today's dateAshSubmitted
    markAsRequested: protectedProcedure.input(z2.object({ patientId: z2.string().uuid() })).mutation(async ({ input }) => {
      const visitId = await getLatestVisitIdForPatient(input.patientId);
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
    getZeroReimbursement: protectedProcedure.query(async () => {
      const { supabase: supabase2 } = await Promise.resolve().then(() => (init_supabase(), supabase_exports));
      const { data, error } = await supabase2.from("claims_records").select(`
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
          `).or("insurance_reimbursement.is.null,insurance_reimbursement.eq.0").gt("charge_amount", 0).in("claim_status", ["denied", "rejected", "pended", "resubmitted"]).neq("is_resolved", true).order("claim_submitted_date", { ascending: true });
      if (error) throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return (data ?? []).map((row) => ({
        id: row.id,
        patientId: row.patient_id,
        patientName: row.patients?.name,
        insurance: row.patients?.insurance,
        authPeriod: row.auth_period,
        dateOfService: row.date_of_service,
        chargeAmount: row.charge_amount,
        insuranceReimbursement: row.insurance_reimbursement,
        claimStatus: row.claim_status,
        claimSubmittedDate: row.claim_submitted_date,
        claimNumber: row.expire_bcbs_claim_number
      }));
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
import fs2 from "fs";
import { nanoid } from "nanoid";
import path2 from "path";
import { createServer as createViteServer } from "vite";

// vite.config.ts
import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";
var PROJECT_ROOT = import.meta.dirname;
var LOG_DIR = path.join(PROJECT_ROOT, ".manus-logs");
var MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;
var TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6);
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}
function trimLogFile(logPath, maxSize) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines = [];
    let keptBytes = 0;
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}
`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }
    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
  }
}
function writeToLogFile(source, entries) {
  if (entries.length === 0) return;
  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);
  const lines = entries.map((entry) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });
  fs.appendFileSync(logPath, `${lines.join("\n")}
`, "utf-8");
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}
function vitePluginManusDebugCollector() {
  return {
    name: "manus-debug-collector",
    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true
            },
            injectTo: "head"
          }
        ]
      };
    },
    configureServer(server) {
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }
        const handlePayload = (payload) => {
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };
        const reqBody = req.body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    }
  };
}
var plugins = [react(), tailwindcss(), jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector()];
var vite_config_default = defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets")
    }
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true
  },
  server: {
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1"
    ],
    fs: {
      strict: true,
      deny: ["**/.*"]
    }
  }
});

// server/_core/vite.ts
function serveStatic(app2) {
  const distPath = process.env.NODE_ENV === "development" ? path2.resolve(import.meta.dirname, "../..", "dist", "public") : path2.resolve(import.meta.dirname, "public");
  if (!fs2.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app2.use(express.static(distPath));
  app2.use("*", (_req, res) => {
    res.sendFile(path2.resolve(distPath, "index.html"));
  });
}

// api/server.ts
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
var server_default = app;
export {
  server_default as default
};
