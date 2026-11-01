/**
 * server/claimsRedaction.ts — P4-P23, P4-P25
 *
 * Claims data requires Claims access (see shared/claimsAccess.ts). The
 * claims.* router is gated wholesale, but a few SHARED responses that Staff
 * legitimately need (patients, visit/session rows, record history, the
 * Activity Log) also carry claim or claim-financial fields. These pure
 * helpers strip those fields for every caller without Claims access so a direct
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
  // P4-P28: which claim file created a patient.
  "source_kind",
  "source_file",
  "claims_status",
  "total_insurance_reimbursement",
  "total_patient_due",
  "total_patient_paid",
]);

export type RedactedVisitRecord = Omit<VisitRecord, VisitFinancialField> & Partial<Pick<VisitRecord, VisitFinancialField>>;
export type RedactedPatient = Omit<Patient, "claimsStatus"> & Partial<Pick<Patient, "claimsStatus">>;

export function redactVisitRecord(visit: VisitRecord, claimsAllowed: boolean): RedactedVisitRecord {
  if (claimsAllowed) return visit;
  const { totalInsuranceReimbursement: _r, totalPatientDue: _d, totalPatientPaid: _p, ...rest } = visit;
  return rest;
}

export function redactPatient(patient: Patient, claimsAllowed: boolean): RedactedPatient {
  if (claimsAllowed) return patient;
  const { claimsStatus: _c, ...rest } = patient;
  return rest;
}

/** P4-P28: pending reimbursement lines carry EOB amounts; external id links
 *  carry billing-system identifiers. Kept in step with listActivityLog's filter. */
export const CLAIM_AUDIT_ENTITY_TYPES = ["claim_record", "pending_eob_line"] as const;
export const CLAIM_AUDIT_ACTION_PREFIXES = ["CLAIM", "EOB_LINE", "PATIENT_EXTERNAL_ID"] as const;

/** True for any audit row that describes a claim record itself — including
 *  legacy rows written before entity_type existed (action-only). */
export function isClaimAuditRow(row: Pick<AuditLogRow, "entityType" | "action">): boolean {
  return (CLAIM_AUDIT_ENTITY_TYPES as readonly (string | null)[]).includes(row.entityType)
    || CLAIM_AUDIT_ACTION_PREFIXES.some(p => row.action.toUpperCase().startsWith(p));
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
 *  rest. A row whose ONLY change was a restricted field (e.g. an admin
 *  editing a session's financial total) is dropped rather than shown as an
 *  empty, unexplained edit. */
export function redactAuditRows(rows: AuditLogRow[], claimsAllowed: boolean): AuditLogRow[] {
  if (claimsAllowed) return rows;
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
