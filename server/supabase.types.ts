/**
 * TypeScript types for the Supabase PostgreSQL schema.
 * Matches the tables created in the Supabase SQL Editor.
 * IDs are UUIDs (string), timestamps are ISO strings.
 *
 * Hand-maintained, not generated. The authoritative schema snapshot lives at
 * references/local-setup-schema.sql — keep this file's shapes in sync with it.
 */

export type UserRole = "user" | "admin";
export type AuthStatus = "none" | "pending" | "approved" | "denied";
export type ClaimsStatus = "submitted" | "approved" | "pending" | "denied" | "pended" | "rejected" | "resubmitted";
export type ClinicUserRole = "admin" | "staff";
export type ClinicUserStatus = "active" | "archived";

// ─── Row types (what SELECT returns) ─────────────────────────────────────────

export interface UserRow {
  id: string;               // uuid
  open_id: string;
  name: string | null;
  email: string | null;
  login_method: string | null;
  role: UserRole;
  created_at: string;
  updated_at: string;
  last_signed_in: string;
}

export interface ClinicUserRow {
  id: string;               // uuid
  username: string;
  password_hash: string;
  name: string | null;
  email: string | null;
  department: string | null;
  role: ClinicUserRole;
  status: ClinicUserStatus;
  must_change_password: boolean;
  token_version: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  archived_at: string | null;
}

export interface PatientRow {
  id: string;               // uuid
  name: string;
  insurance: string;
  auth_date: string | null;        // ISO date "YYYY-MM-DD"
  auth_valid_until: number | null; // Unix ms timestamp — expiry date of current authorization
  is_active: boolean;              // false = discharged
  discharge_date: number | null;   // Unix ms timestamp — when patient was discharged
  discharge_reason: string | null; // reason for discharge
  claims_status: ClaimsStatus;     // claims status: submitted, approved, pending, or denied
  created_at: string;
  updated_at: string;
}

export interface VisitRecordRow {
  id: string;               // uuid
  patient_id: string;       // uuid → patients.id
  sessions_authorized: number | null;
  sessions_remaining: number | null;
  session_number: number | null;
  auth_period: number;
  date_of_service: string | null;   // ISO date "YYYY-MM-DD"
  new_auth: string | null;
  date_ash_submitted: string | null; // ISO date "YYYY-MM-DD"
  auth_status: AuthStatus;
  insurance_company: string | null;  // insurance used for this auth period
  total_insurance_reimbursement: number | null;  // numeric(10,2)
  total_patient_due: number | null;              // numeric(10,2)
  total_patient_paid: number | null;             // numeric(10,2)
  created_at: string;
  updated_at: string;
}

export interface ClaimRecordRow {
  id: string;                           // uuid
  patient_id: string;                   // uuid → patients.id
  auth_period: number;                  // authorization period
  place_of_service: string | null;
  date_of_service: string | null;       // ISO date "YYYY-MM-DD"
  visit_number: number | null;
  cpt_codes: string | null;             // comma-separated
  units_billed: number | null;
  diagnosis_codes: string | null;       // comma-separated
  modifier: string | null;
  charge_amount: number | null;         // in cents
  insurance_reimbursement: number | null; // in cents
  patient_amount_paid: number | null;   // in cents
  patient_amount_due: number | null;    // in cents
  insurance_billed: string | null;
  oa_claim_number: string | null;
  claim_submitted_date: string | null;  // ISO date "YYYY-MM-DD"
  expire_bcbs_claim_number: string | null;
  claim_status: ClaimsStatus;
  payment_received: number | null;      // in cents
  check_date: string | null;            // ISO date "YYYY-MM-DD"
  check_number_virtual_card: string | null;
  date_received: string | null;         // ISO date "YYYY-MM-DD"
  date_of_appeal: string | null;        // ISO date "YYYY-MM-DD"
  reference_no: string | null;
  lmn: string | null;                   // letter of medical necessity note/reference
  is_resolved: boolean;                 // staff has cleared this claim from the follow-up queue
  created_at: string;
  updated_at: string;
}

export interface AuditLogRow {
  id: string;                // uuid
  patient_id: string;        // uuid → patients.id
  actor_id: string | null;   // uuid → clinic_users.id / users.id, if known
  action: string;            // e.g. "PATIENT_NAME_UPDATE"
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

export interface InsurerCatalogRow {
  id: string;                // uuid
  name: string;
  normalized_name: string;   // lower(trim(collapse-whitespace(name))) — UNIQUE
  aliases: string[];         // pre-rename display names for this same product
  created_at: string;
}

// ─── Insert types (what INSERT accepts) ──────────────────────────────────────

export type InsertUser = Omit<UserRow, "id" | "created_at" | "updated_at"> & {
  id?: string;
};

export type InsertPatient = {
  name: string;
  insurance?: string;
  auth_date?: string | null;
  auth_valid_until?: number | null;
  is_active?: boolean;
  discharge_date?: number | null;
  discharge_reason?: string | null;
  claims_status?: ClaimsStatus;
};

export type InsertVisitRecord = {
  patient_id: string;
  sessions_authorized?: number | null;
  sessions_remaining?: number | null;
  session_number?: number | null;
  auth_period?: number;
  date_of_service?: string | null;
  new_auth?: string | null;
  date_ash_submitted?: string | null;
  auth_status?: AuthStatus;
  total_insurance_reimbursement?: number | null;
  total_patient_due?: number | null;
  total_patient_paid?: number | null;
};

export type InsertClaimRecord = {
  patient_id: string;
  auth_period: number;
  place_of_service?: string | null;
  date_of_service?: string | null;
  visit_number?: number | null;
  cpt_codes?: string | null;
  units_billed?: number | null;
  diagnosis_codes?: string | null;
  modifier?: string | null;
  charge_amount?: number | null;
  insurance_reimbursement?: number | null;
  patient_amount_paid?: number | null;
  patient_amount_due?: number | null;
  insurance_billed?: string | null;
  oa_claim_number?: string | null;
  claim_submitted_date?: string | null;
  expire_bcbs_claim_number?: string | null;
  claim_status?: ClaimsStatus;
  payment_received?: number | null;
  check_date?: string | null;
  check_number_virtual_card?: string | null;
  date_received?: string | null;
  date_of_appeal?: string | null;
  reference_no?: string | null;
  lmn?: string | null;
  is_resolved?: boolean;
};

export type InsertAuditLog = {
  patient_id: string;
  actor_id?: string | null;
  action: string;
  old_value?: string | null;
  new_value?: string | null;
};

export type UpdatePatient = Partial<InsertPatient>;
export type UpdateVisitRecord = Partial<InsertVisitRecord>;
export type UpdateClaimRecord = Partial<InsertClaimRecord>;

// ─── Database interface for the Supabase client generic ──────────────────────

export interface Database {
  public: {
    Tables: {
      users: {
        Row: UserRow;
        Insert: InsertUser;
        Update: Partial<InsertUser>;
      };
      clinic_users: {
        Row: ClinicUserRow;
        Insert: Omit<ClinicUserRow, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<ClinicUserRow, "id" | "created_at" | "updated_at">>;
      };
      patients: {
        Row: PatientRow;
        Insert: InsertPatient;
        Update: UpdatePatient;
      };
      visit_records: {
        Row: VisitRecordRow;
        Insert: InsertVisitRecord;
        Update: UpdateVisitRecord;
      };
      claims_records: {
        Row: ClaimRecordRow;
        Insert: InsertClaimRecord;
        Update: UpdateClaimRecord;
      };
      audit_logs: {
        Row: AuditLogRow;
        Insert: InsertAuditLog;
        Update: Partial<InsertAuditLog>;
      };
      insurer_catalog: {
        Row: InsurerCatalogRow;
        // normalized_name is a GENERATED column — never supplied on insert/update.
        Insert: Omit<InsurerCatalogRow, "id" | "normalized_name" | "aliases" | "created_at">;
        Update: Partial<Omit<InsurerCatalogRow, "id" | "normalized_name" | "created_at">>;
      };
    };
    Views: {
      active_patient_periods: {
        Row: {
          patient_id: string;
          patient_name: string;
          insurance: string;
          auth_period: number;
          sessions_authorized: number | null;
          sessions_completed: number;
          sessions_remaining: number;
          earliest_ash_submitted: string | null;
          latest_ash_submitted: string | null;
          period_auth_status: AuthStatus;
        };
      };
      authorization_alerts: {
        Row: {
          patient_id: string;
          patient_name: string;
          insurance: string;
          sessions_authorized: number;
          sessions_remaining: number;
          sessions_completed: number;
          urgency: string;
        };
      };
    };
    Functions: Record<string, never>;
    Enums: {
      user_role: UserRole;
      auth_status: AuthStatus;
    };
  };
}
