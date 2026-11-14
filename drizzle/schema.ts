/**
 * drizzle/schema.ts — Type definitions for the clinic dashboard.
 *
 * The database is now backed by Supabase PostgreSQL (UUID primary keys, snake_case columns).
 * These types use camelCase field names and string UUIDs to match what the rest of the app
 * (tRPC routers, frontend, sdk.ts) expects. The db.ts layer converts between Supabase
 * snake_case rows and these camelCase types.
 *
 * This file is a hand-maintained TypeScript mirror, not the schema source of truth.
 * The authoritative schema is references/local-setup-schema.sql (applied directly in the
 * Supabase SQL Editor). The drizzle-kit/MySQL migration pipeline under drizzle/ is legacy
 * and unrelated to the current runtime database — see drizzle/LEGACY.md.
 */

// ─── User ─────────────────────────────────────────────────────────────────────

export interface User {
  id: string;               // UUID
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: string | null;
  role: "user" | "admin";
  createdAt: Date;
  updatedAt: Date;
  lastSignedIn: Date;
}

export type InsertUser = Partial<User> & { openId: string };

// ─── Patient ──────────────────────────────────────────────────────────────────

export interface Patient {
  id: string;               // UUID
  name: string;
  insurance: string;
  authDate: Date | null;
  authValidUntil: number | null; // Unix ms timestamp — expiry date of current authorization
  isActive: boolean;             // false = discharged
  dischargeDate: number | null;  // Unix ms timestamp — when patient was discharged
  dischargeReason: string | null; // reason for discharge
  claimsStatus: 'submitted' | 'approved' | 'pending' | 'denied' | 'pended' | 'rejected' | 'resubmitted'; // claims status
  createdAt: Date;
  updatedAt: Date;
}

export type InsertPatient = Omit<Patient, "id" | "createdAt" | "updatedAt">;

// ─── VisitRecord ──────────────────────────────────────────────────────────────

export interface VisitRecord {
  id: string;               // UUID
  patientId: string;        // UUID → patients.id
  sessionsAuthorized: number | null;
  sessionsRemaining: number | null;
  sessionNumber: number | null;
  authPeriod: number;
  dateOfService: Date | null;
  newAuth: string | null;
  dateAshSubmitted: Date | null;
  authStatus: "none" | "pending" | "approved" | "denied" | "expired";
  insuranceCompany: string | null;  // insurance used for this auth period
  totalInsuranceReimbursement: number | null;  // numeric(10,2)
  totalPatientDue: number | null;              // numeric(10,2)
  totalPatientPaid: number | null;             // numeric(10,2)
  // P4-P23 per-session workflow fields — NULL means "not yet set".
  assignmentOfBenefits: "yes" | "no" | null;
  submissionStatus: "ready_to_file" | "hold" | "do_not_file" | null;
  remarks: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertVisitRecord = Omit<VisitRecord, "id" | "createdAt" | "updatedAt">;

// ─── ClinicUser ───────────────────────────────────────────────────────────────

export interface ClinicUser {
  id: string;               // UUID
  username: string;
  passwordHash: string;
  name: string | null;
  email: string | null;
  department: string | null;
  role: "admin" | "staff";
  status: "active" | "archived";
  mustChangePassword: boolean;
  tokenVersion: number;      // schema/type ready in S1; revocation enforcement deferred to S2
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  archivedAt: Date | null;
}

export type InsertClinicUser = Omit<ClinicUser, "id" | "createdAt" | "updatedAt">;

// ─── InsurerCatalogEntry ────────────────────────────────────────────────────

export interface InsurerCatalogEntry {
  id: string;               // UUID
  name: string;
  aliases: string[];        // previously-used display names for this same product
  createdAt: Date;
  /** Soft-delete flag (P4-P13). Inactive entries are hidden from new-selection
   *  dropdowns but remain readable/filterable so historical patient/claim
   *  records stored under this name keep resolving correctly. */
  isActive: boolean;
  deactivatedAt: Date | null;
  reactivatedAt: Date | null;
}

// ─── ClaimRecord ──────────────────────────────────────────────────────────────

export interface ClaimRecord {
  id: string;               // UUID
  patientId: string;        // UUID → patients.id
  authPeriod: number;       // authorization period number
  placeOfService: string | null;
  dateOfService: Date | null;
  visitNumber: number | null;
  cptCodes: string | null;
  unitsBilled: number | null;
  diagnosisCodes: string | null;
  modifier: string | null;
  chargeAmount: number | null;      // numeric(10,2)
  insuranceReimbursement: number | null;
  patientAmountPaid: number | null;
  patientAmountDue: number | null;
  insuranceBilled: string | null;
  oaClaimNumber: string | null;
  claimSubmittedDate: Date | null;
  expireBcbsClaimNumber: string | null;
  claimStatus: 'submitted' | 'approved' | 'pending' | 'denied' | 'pended' | 'rejected' | 'resubmitted';
  paymentReceived: number | null;
  checkDate: Date | null;
  checkNumberVirtualCard: string | null;
  dateReceived: Date | null;
  dateOfAppeal: Date | null;
  referenceNo: string | null;
  lmn: string | null;           // letter of medical necessity note/reference
  isResolved: boolean;          // staff has cleared this claim from the follow-up queue
  // P4-P24: source provenance (null on pre-P4-P24 rows).
  cms1500DocumentId: string | null;
  cms1500LineKey: string | null;
  eobDocumentId: string | null;
  eobLineKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertClaimRecord = Omit<ClaimRecord, "id" | "createdAt" | "updatedAt">;
export type UpdateClaimRecord = Partial<InsertClaimRecord>;

// ─── AuditLog ─────────────────────────────────────────────────────────────────

export interface AuditLog {
  id: string;               // UUID
  patientId: string;        // UUID → patients.id
  actorId: string | null;   // UUID → clinic_users.id / users.id, if known
  action: string;           // e.g. "PATIENT_NAME_UPDATE"
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
}

export type InsertAuditLog = Omit<AuditLog, "id" | "createdAt">;
