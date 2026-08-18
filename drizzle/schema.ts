/**
 * drizzle/schema.ts — Type definitions for the clinic dashboard.
 *
 * The database is now backed by Supabase PostgreSQL (UUID primary keys, snake_case columns).
 * These types use camelCase field names and string UUIDs to match what the rest of the app
 * (tRPC routers, frontend, sdk.ts) expects. The db.ts layer converts between Supabase
 * snake_case rows and these camelCase types.
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
  authStatus: "none" | "pending" | "approved" | "denied";
  insuranceCompany: string | null;  // insurance used for this auth period
  createdAt: Date;
  updatedAt: Date;
}

export type InsertVisitRecord = Omit<VisitRecord, "id" | "createdAt" | "updatedAt">;

// ─── ClinicUser ───────────────────────────────────────────────────────────────

export interface ClinicUser {
  id: string;               // UUID
  username: string;
  passwordHash: string;
  createdAt: Date;
}

export type InsertClinicUser = Omit<ClinicUser, "id" | "createdAt">;

// ─── ClaimRecord ──────────────────────────────────────────────────────────────

export interface ClaimRecord {
  id: string;               // UUID
  patientId: string;        // UUID → patients.id
  authPeriod: number;       // authorization period number
  placeOfService: string | null;
  dateOfService: Date | null;
  visitNumber: string | null;
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
  createdAt: Date;
  updatedAt: Date;
}

export type InsertClaimRecord = Omit<ClaimRecord, "id" | "createdAt" | "updatedAt">;
export type UpdateClaimRecord = Partial<InsertClaimRecord>;
