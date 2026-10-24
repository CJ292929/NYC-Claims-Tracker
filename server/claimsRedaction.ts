/**
 * server/claimsRedaction.ts — P4-P23
 *
 * Claims data is Super Admin only (see server/_core/superAdmin.ts). The
 * claims.* router is gated wholesale, but a few SHARED responses that Admin
 * and Staff legitimately need (patients, visit/session rows, record history,
 * the Activity Log) also carry claim or claim-financial fields. These pure
 * helpers strip those fields for every non-Super-Admin caller so a direct
 * API call can't read them either. Stored data is never modified — this is
 * response shaping only.
 */
import type { Patient, VisitRecord } from "../drizzle/schema";
import type { AuditLogRow } from "./db";

/** Per-session financial totals on visit_records (camelCase API shape). */
export const VISIT_FINANCIAL_FIELDS = ["totalInsuranceReimbursement", "totalPatientDue", "totalPatientPaid"] as const;
type VisitFinancialField = (typeof VISIT_FINANCIAL_FIELDS)[number];

/** Claim-derived or claim-financial columns as they appear (snake_case) in
 *  audit_logs before_data/after_data for patient and visit_record rows. */
const RESTRICTED_AUDIT_KEYS = new Set([
  "claims_status",
  "total_insurance_reimbursement",
  "total_patient_due",
  "total_patient_paid",
]);

export type RedactedVisitRecord = Omit<VisitRecord, VisitFinancialField> & Partial<Pick<VisitRecord, VisitFinancialField>>;
export type RedactedPatient = Omit<Patient, "claimsStatus"> & Partial<Pick<Patient, "claimsStatus">>;

export function redactVisitRecord(visit: VisitRecord, superAdmin: boolean): RedactedVisitRecord {
  if (superAdmin) return visit;
  const { totalInsuranceReimbursement: _r, totalPatientDue: _d, totalPatientPaid: _p, ...rest } = visit;
  return rest;
}

export function redactPatient(patient: Patient, superAdmin: boolean): RedactedPatient {
  if (superAdmin) return patient;
  const { claimsStatus: _c, ...rest } = patient;
  return rest;
}

/** True for any audit row that describes a claim record itself — including
 *  legacy rows written before entity_type existed (action-only). */
export function isClaimAuditRow(row: Pick<AuditLogRow, "entityType" | "action">): boolean {
  return row.entityType === "claim_record" || /^CLAIM/i.test(row.action);
}

function stripRestrictedKeys(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (RESTRICTED_AUDIT_KEYS.has(key)) continue;
    // INSURER_PERMANENT_DELETE keeps reference counts per table; the claims
    // count is claim data, the patient/visit counts are not.
    if (key === "retained_references" && value && typeof value === "object") {
      const { claims: _claims, ...counts } = value as Record<string, unknown>;
      out[key] = counts;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Drops claim audit rows entirely and strips claim/financial keys from the
 *  rest. A row whose ONLY change was a restricted field (e.g. a Super Admin
 *  editing a session's financial total) is dropped rather than shown as an
 *  empty, unexplained edit. */
export function redactAuditRows(rows: AuditLogRow[], superAdmin: boolean): AuditLogRow[] {
  if (superAdmin) return rows;
  const out: AuditLogRow[] = [];
  for (const row of rows) {
    if (isClaimAuditRow(row)) continue;
    const beforeData = stripRestrictedKeys(row.beforeData);
    const afterData = stripRestrictedKeys(row.afterData);
    const hadData = row.beforeData !== null || row.afterData !== null;
    const isEmpty =
      (beforeData === null || Object.keys(beforeData).length === 0) &&
      (afterData === null || Object.keys(afterData).length === 0);
    if (hadData && isEmpty) continue;
    out.push({ ...row, beforeData, afterData });
  }
  return out;
}
