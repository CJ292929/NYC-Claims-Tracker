-- ============================================================================
-- NYC Home Rehab Clinic Dashboard — full schema setup
--
-- THIS FILE IS THE AUTHORITATIVE SCHEMA SOURCE OF TRUTH for this repo. It is
-- a hand-maintained snapshot, not generated — when the schema changes, apply
-- the change in the Supabase SQL Editor first, then update this file (and the
-- mirrored TypeScript types in drizzle/schema.ts and server/supabase.types.ts)
-- to match. The drizzle/ directory is unrelated legacy MySQL tooling — see
-- drizzle/LEGACY.md — and must not be used to manage this schema.
--
-- This Supabase project (whezsmwxbozzfddhpebq) had NO tables in it, which is
-- why login and every dashboard query failed. Run this ENTIRE script once in
-- Supabase → SQL Editor → New Query → Run.
--
-- NOTE: this ref has since been reconciled as the production Supabase project,
-- with high confidence, via `supabase projects list` (only project in the
-- account matching this app) and this repo's own Supabase CLI link
-- (supabase/.temp/linked-project.json). The ref previously documented in
-- VERCEL_DEPLOY.md (czjckcplzuigjbhegbon) does not exist in this Supabase
-- account and was stale/incorrect; VERCEL_DEPLOY.md has been updated to match.
-- The literal Vercel Production SUPABASE_URL value itself is marked Sensitive
-- and was not read directly, so this is a high-confidence correlation, not a
-- byte-exact confirmation. See drizzle/LEGACY.md and the schema audit report
-- for detail.
--
-- Reconstructed from server/supabase.types.ts, server/db.ts, and
-- server/routers.ts (the previous references/create-claims-table.sql was
-- stale — missing lmn and is_resolved columns actually used by the app).
-- ============================================================================

-- ─── users (Manus OAuth + clinic-login identities) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  open_id text NOT NULL UNIQUE,
  name text,
  email text,
  login_method text,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_signed_in timestamptz NOT NULL DEFAULT now()
);

-- ─── clinic_users (individual staff identities; username/password login) ──
CREATE TABLE IF NOT EXISTS public.clinic_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  password_hash text NOT NULL,
  name text,
  email text,
  department text,
  role text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  must_change_password boolean NOT NULL DEFAULT true,
  token_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  archived_at timestamptz
);

-- Case-insensitive uniqueness: jerome / Jerome / JEROME must collide.
CREATE UNIQUE INDEX IF NOT EXISTS clinic_users_username_lower_key ON public.clinic_users (lower(username));

-- ─── patients ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  insurance text NOT NULL DEFAULT '',
  auth_date date,
  auth_valid_until bigint,          -- unix ms timestamp
  is_active boolean NOT NULL DEFAULT true,
  discharge_date bigint,            -- unix ms timestamp
  discharge_reason text,
  claims_status text CHECK (
    claims_status IS NULL OR claims_status IN
    ('submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ─── visit_records ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.visit_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  sessions_authorized integer,
  sessions_remaining integer,
  session_number integer,
  auth_period integer NOT NULL DEFAULT 1,
  date_of_service date,
  new_auth text,
  date_ash_submitted date,
  auth_status text NOT NULL DEFAULT 'none' CHECK (auth_status IN ('none', 'pending', 'approved', 'denied')),
  insurance_company text,
  total_insurance_reimbursement numeric(10,2),
  total_patient_due numeric(10,2),
  total_patient_paid numeric(10,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visit_records_patient ON public.visit_records(patient_id);

-- Migration for an already-existing visit_records table (CREATE TABLE IF NOT EXISTS
-- above is a no-op once the table exists) — run this ALTER on the live Supabase
-- project to add the 3 new money columns without touching existing rows.
ALTER TABLE public.visit_records ADD COLUMN IF NOT EXISTS total_insurance_reimbursement numeric(10,2);
ALTER TABLE public.visit_records ADD COLUMN IF NOT EXISTS total_patient_due numeric(10,2);
ALTER TABLE public.visit_records ADD COLUMN IF NOT EXISTS total_patient_paid numeric(10,2);

-- ─── claims_records ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.claims_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  auth_period integer NOT NULL,
  place_of_service text,
  date_of_service date,
  visit_number integer,
  cpt_codes text,
  units_billed integer,
  diagnosis_codes text,
  modifier text,
  charge_amount numeric(10, 2),
  insurance_reimbursement numeric(10, 2),
  patient_amount_paid numeric(10, 2),
  patient_amount_due numeric(10, 2),
  insurance_billed text,
  oa_claim_number text,
  claim_submitted_date date,
  expire_bcbs_claim_number text,
  claim_status text NOT NULL DEFAULT 'submitted' CHECK (
    claim_status IN ('submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted')
  ),
  payment_received numeric(10, 2),
  check_date date,
  check_number_virtual_card text,
  date_received date,
  date_of_appeal date,
  reference_no text,
  lmn text,
  is_resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claims_patient_period ON public.claims_records(patient_id, auth_period);
CREATE INDEX IF NOT EXISTS idx_claims_status ON public.claims_records(claim_status);
CREATE INDEX IF NOT EXISTS idx_claims_is_resolved ON public.claims_records(is_resolved);

-- ─── audit_logs (immutable trail of patient field changes) ────────────────
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL, -- e.g. 'PATIENT_NAME_UPDATE'
  old_value text,
  new_value text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_patient ON public.audit_logs(patient_id, created_at DESC);

-- ─── auto-update updated_at on row changes ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON public.users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_patients_updated_at ON public.patients;
CREATE TRIGGER trg_patients_updated_at BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_visit_records_updated_at ON public.visit_records;
CREATE TRIGGER trg_visit_records_updated_at BEFORE UPDATE ON public.visit_records
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_claims_records_updated_at ON public.claims_records;
CREATE TRIGGER trg_claims_records_updated_at BEFORE UPDATE ON public.claims_records
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_clinic_users_updated_at ON public.clinic_users;
CREATE TRIGGER trg_clinic_users_updated_at BEFORE UPDATE ON public.clinic_users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- seed initial clinic login account
INSERT INTO public.clinic_users (username, password_hash)
VALUES ('jeromerivera123', '$2b$10$kuVrXRE2VoaLoS7UJY6OG.OHWULrOWxg6VCKPoMm6hiWmpSwyoeo6')
ON CONFLICT ((lower(username))) DO NOTHING;
