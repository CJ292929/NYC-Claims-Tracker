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
  -- P4-P17: attribution. NULL on rows created before this column existed —
  -- the app renders "Unknown — recorded before tracking" for those, never a
  -- guess. actor_type disambiguates which identity table *_by refers to
  -- ('clinic_user' -> public.clinic_users.id, 'owner' -> public.users.id).
  created_by uuid,
  created_by_type text,
  updated_by uuid,
  updated_by_type text,
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
  -- P4-P17: attribution (see patients.created_by's comment above).
  created_by uuid,
  created_by_type text,
  updated_by uuid,
  updated_by_type text,
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
    claim_status IN ('submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted', 'needs_review')
  ),
  payment_received numeric(10, 2),
  check_date date,
  check_number_virtual_card text,
  date_received date,
  date_of_appeal date,
  reference_no text,
  lmn text,
  is_resolved boolean NOT NULL DEFAULT false,
  -- P4-P14: 0-based position of a service line within its (date_of_service,
  -- cpt_codes) group as encountered in the source document. NULL = legacy
  -- row. See 20261017000000_claims_source_line_index_and_needs_review.sql.
  source_line_index integer,
  -- P4-P17: attribution (see patients.created_by's comment above).
  created_by uuid,
  created_by_type text,
  updated_by uuid,
  updated_by_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claims_patient_period ON public.claims_records(patient_id, auth_period);
CREATE INDEX IF NOT EXISTS idx_claims_status ON public.claims_records(claim_status);
CREATE INDEX IF NOT EXISTS idx_claims_is_resolved ON public.claims_records(is_resolved);
CREATE INDEX IF NOT EXISTS idx_claims_line_identity ON public.claims_records (patient_id, auth_period, date_of_service, cpt_codes, source_line_index);

-- ─── audit_logs (generic entity activity trail, P4-P17) ────────────────────
-- Originally patient-only (patient_id NOT NULL, old_value/new_value text);
-- generalized by the P4-P17 migration into a cross-entity event log via
-- entity_type/entity_id, with actor_type disambiguating which identity
-- table actor_id refers to, actor_display a point-in-time name snapshot
-- (survives a later account rename/deactivation), before_data/after_data a
-- controlled jsonb field-level diff (only the keys actually changed — never
-- a full row dump), and import_batch_id grouping events from one bulk
-- import/extraction. patient_id is kept (now nullable) for backward
-- compatibility with pre-P4-P17 rows and as a convenience link for
-- patient-scoped entities.
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid REFERENCES public.patients(id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL, -- e.g. 'PATIENT_NAME_UPDATE', 'CLAIM_RECORD_CREATE', 'ACCOUNT_ARCHIVE'
  old_value text,
  new_value text,
  entity_type text CHECK (
    entity_type IS NULL OR entity_type IN (
      'patient', 'visit_record', 'claim_record', 'insurer_catalog', 'clinic_user'
    )
  ),
  entity_id uuid,
  actor_type text CHECK (actor_type IS NULL OR actor_type IN ('clinic_user', 'owner')),
  actor_display text,
  before_data jsonb,
  after_data jsonb,
  import_batch_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_patient ON public.audit_logs(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_import_batch ON public.audit_logs(import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at DESC);

-- Server-only, same lockdown pattern as insurer_catalog below: RLS enabled
-- with zero policies (default-deny for anon/authenticated), NOT forced (the
-- table owner / Supabase SQL Editor keeps direct access), privileges
-- revoked from PUBLIC/anon/authenticated and granted only to service_role.
-- Added by the P4-P17 migration — this table previously had no such lockdown.
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_logs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.audit_logs TO service_role;

-- ─── insurer_catalog (P4-P7: staff-managed insurer choices) ────────────────
-- aliases preserves pre-rename display names (e.g. "United Healthcare
-- Medicare" for "United Healthcare Medicare Advantage") so existing
-- patient/claim rows stored under the old name still resolve to this entry.
-- normalized_name is DB-GENERATED from name (never application-supplied) so
-- no insert path can ever persist a name/normalized_name pair that disagree.
-- is_active + deactivated/reactivated at/by (P4-P13): soft-delete so
-- removing an insurer from new-selection dropdowns never deletes or
-- rewrites the row (insurance values on patients/visits/claims are free
-- text, not an FK into this table, and must keep resolving for historical
-- data). No actor-audit table fits here (audit_logs is patient-scoped via a
-- NOT NULL FK) — the trail lives on the row itself, this table's own
-- existing created_at convention extended to deactivate/reactivate.
CREATE TABLE IF NOT EXISTS public.insurer_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text GENERATED ALWAYS AS (
    lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))
  ) STORED,
  aliases text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  deactivated_at timestamptz,
  deactivated_by uuid,
  reactivated_at timestamptz,
  reactivated_by uuid,
  -- P4-P17: who added this catalog entry (see patients.created_by's comment
  -- above). deactivated_by/reactivated_by predate this and remain untyped
  -- (no matching *_by_type column) — a known, accepted gap for this table.
  created_by uuid,
  created_by_type text
);

-- Case/whitespace-insensitive uniqueness: "Aetna" / "aetna " / "AETNA" must collide.
-- Enforced across active AND inactive rows, so a deactivated entry still
-- blocks a duplicate insert -- insurance.create reactivates it instead.
CREATE UNIQUE INDEX IF NOT EXISTS insurer_catalog_normalized_name_key ON public.insurer_catalog (normalized_name);

-- New-selection dropdowns only ever query active rows.
CREATE INDEX IF NOT EXISTS insurer_catalog_active_name_idx ON public.insurer_catalog (name) WHERE is_active;

-- Server-only: accessed exclusively via the service-role client in
-- server/db.ts. RLS is enabled with no anon/authenticated policies (default
-- deny), and PostgREST-reachable roles are stripped of table privileges
-- outright, so the Supabase REST API can't read or write this table
-- directly regardless of what key a caller holds. NOT forced, so the table
-- owner (e.g. Supabase SQL Editor) keeps direct operational access.
ALTER TABLE public.insurer_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insurer_catalog NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.insurer_catalog FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.insurer_catalog TO service_role;

-- ─── delete_claim_record_with_audit (P4-P12R: atomic claim delete + audit) ─
-- Locks the target claims_records row, validates it exists and belongs to
-- the given patient, then deletes it and writes the audit_logs entry in the
-- same transaction — both succeed or both roll back. Called exclusively via
-- supabase.rpc() from the service-role client in server/db.ts. See
-- supabase/migrations/20261004010000_delete_claim_record_with_audit_fn.sql
-- for the full rationale (locking/concurrency behavior, SECURITY DEFINER +
-- fixed search_path, and the service_role-only execute grant).
-- P4-P17: extended with p_actor_type/p_actor_display (both default NULL, so
-- the pre-P4-P17 3-arg call shape keeps working) to populate the
-- generalized entity_type/entity_id/actor_type/actor_display columns on the
-- audit row it writes.
CREATE OR REPLACE FUNCTION public.delete_claim_record_with_audit(
  p_claim_id uuid,
  p_patient_id uuid,
  p_actor_id uuid,
  p_actor_type text DEFAULT NULL,
  p_actor_display text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_patient_id uuid;
BEGIN
  SELECT patient_id INTO v_patient_id
  FROM public.claims_records
  WHERE id = p_claim_id
  FOR UPDATE;

  IF v_patient_id IS NULL THEN
    RAISE EXCEPTION 'claim_record_not_found: % ', p_claim_id
      USING ERRCODE = 'P0010';
  END IF;

  IF v_patient_id <> p_patient_id THEN
    RAISE EXCEPTION 'claim_record_patient_mismatch: % does not belong to %', p_claim_id, p_patient_id
      USING ERRCODE = 'P0011';
  END IF;

  INSERT INTO public.audit_logs (
    patient_id, actor_id, action, old_value, new_value,
    entity_type, entity_id, actor_type, actor_display
  )
  VALUES (
    p_patient_id, p_actor_id, 'CLAIM_RECORD_DELETE', p_claim_id::text, NULL,
    'claim_record', p_claim_id, p_actor_type, p_actor_display
  );

  DELETE FROM public.claims_records WHERE id = p_claim_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_claim_record_with_audit(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_claim_record_with_audit(uuid, uuid, uuid, text, text) TO service_role;

-- ─── write_patient_with_audit (P4-P17: atomic patient create/update + audit) ─
-- p_id NULL => insert; otherwise patches the given row. p_data keys are
-- snake_case patient columns to set — omitted keys are left untouched
-- (jsonb_populate_record uses the existing row, or NULL defaults on insert,
-- as its base). Only the keys actually present in p_data are compared and
-- stored in the audit diff, and the audit row is skipped when none of them
-- actually changed (no misleading duplicate entries on a retried/no-op save).
-- See supabase/migrations/20261018000000_p4_p17_account_management_and_audit.sql.
CREATE OR REPLACE FUNCTION public.write_patient_with_audit(
  p_id uuid,
  p_data jsonb,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_action text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before public.patients;
  v_after public.patients;
  v_id uuid;
  v_before_diff jsonb := '{}'::jsonb;
  v_after_diff jsonb := '{}'::jsonb;
  v_key text;
BEGIN
  IF p_id IS NULL THEN
    v_after := jsonb_populate_record(NULL::public.patients, p_data);

    INSERT INTO public.patients (
      name, insurance, auth_date, auth_valid_until, claims_status,
      created_by, created_by_type, updated_by, updated_by_type
    ) VALUES (
      v_after.name, COALESCE(v_after.insurance, ''), v_after.auth_date, v_after.auth_valid_until, v_after.claims_status,
      p_actor_id, p_actor_type, p_actor_id, p_actor_type
    )
    RETURNING id INTO v_id;

    FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
      v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
    END LOOP;

    INSERT INTO public.audit_logs (
      entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
      action, before_data, after_data
    ) VALUES (
      'patient', v_id, v_id, p_actor_id, p_actor_type, p_actor_display,
      p_action, NULL, v_after_diff
    );

    RETURN v_id;
  ELSE
    SELECT * INTO v_before FROM public.patients WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'patient_not_found: %', p_id USING ERRCODE = 'P0020';
    END IF;

    v_after := jsonb_populate_record(v_before, p_data);

    UPDATE public.patients SET
      name = v_after.name,
      insurance = v_after.insurance,
      auth_date = v_after.auth_date,
      auth_valid_until = v_after.auth_valid_until,
      claims_status = v_after.claims_status,
      updated_by = p_actor_id,
      updated_by_type = p_actor_type
    WHERE id = p_id;

    FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
      IF (to_jsonb(v_before) -> v_key) IS DISTINCT FROM (to_jsonb(v_after) -> v_key) THEN
        v_before_diff := v_before_diff || jsonb_build_object(v_key, to_jsonb(v_before) -> v_key);
        v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
      END IF;
    END LOOP;

    IF v_before_diff <> '{}'::jsonb THEN
      INSERT INTO public.audit_logs (
        entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
        action, before_data, after_data
      ) VALUES (
        'patient', p_id, p_id, p_actor_id, p_actor_type, p_actor_display,
        p_action, v_before_diff, v_after_diff
      );
    END IF;

    RETURN p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.write_patient_with_audit(uuid, jsonb, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_patient_with_audit(uuid, jsonb, uuid, text, text, text) TO service_role;

-- ─── write_claim_record_with_audit (P4-P17: atomic claim create/update + audit) ─
-- Same shape as write_patient_with_audit, for claims_records. Shared by
-- claims.create/update/upsert, CMS1500 enrichment, and both bulk-import
-- paths (reimbursement + CMS1500) — every one of those resolves to "insert
-- or patch one claims_records row". p_patient_id is required (belt-and-
-- suspenders ownership check, mirrors delete_claim_record_with_audit).
CREATE OR REPLACE FUNCTION public.write_claim_record_with_audit(
  p_id uuid,
  p_patient_id uuid,
  p_data jsonb,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_action text,
  p_import_batch_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before public.claims_records;
  v_after public.claims_records;
  v_id uuid;
  v_before_diff jsonb := '{}'::jsonb;
  v_after_diff jsonb := '{}'::jsonb;
  v_key text;
BEGIN
  IF p_id IS NULL THEN
    v_after := jsonb_populate_record(NULL::public.claims_records, p_data);

    INSERT INTO public.claims_records (
      patient_id, auth_period, place_of_service, date_of_service, visit_number,
      cpt_codes, units_billed, diagnosis_codes, modifier, charge_amount,
      insurance_reimbursement, patient_amount_paid, patient_amount_due,
      insurance_billed, oa_claim_number, claim_submitted_date,
      expire_bcbs_claim_number, claim_status, payment_received, check_date,
      check_number_virtual_card, date_received, date_of_appeal, reference_no,
      lmn, source_line_index, created_by, created_by_type, updated_by, updated_by_type
    ) VALUES (
      p_patient_id, v_after.auth_period, v_after.place_of_service, v_after.date_of_service, v_after.visit_number,
      v_after.cpt_codes, v_after.units_billed, v_after.diagnosis_codes, v_after.modifier, v_after.charge_amount,
      v_after.insurance_reimbursement, v_after.patient_amount_paid, v_after.patient_amount_due,
      v_after.insurance_billed, v_after.oa_claim_number, v_after.claim_submitted_date,
      v_after.expire_bcbs_claim_number, COALESCE(v_after.claim_status, 'submitted'), v_after.payment_received, v_after.check_date,
      v_after.check_number_virtual_card, v_after.date_received, v_after.date_of_appeal, v_after.reference_no,
      v_after.lmn, v_after.source_line_index, p_actor_id, p_actor_type, p_actor_id, p_actor_type
    )
    RETURNING id INTO v_id;

    FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
      v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
    END LOOP;

    INSERT INTO public.audit_logs (
      entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
      action, before_data, after_data, import_batch_id
    ) VALUES (
      'claim_record', v_id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
      p_action, NULL, v_after_diff, p_import_batch_id
    );

    RETURN v_id;
  ELSE
    SELECT * INTO v_before FROM public.claims_records WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'claim_record_not_found: %', p_id USING ERRCODE = 'P0010';
    END IF;
    IF v_before.patient_id <> p_patient_id THEN
      RAISE EXCEPTION 'claim_record_patient_mismatch: % does not belong to %', p_id, p_patient_id
        USING ERRCODE = 'P0011';
    END IF;

    v_after := jsonb_populate_record(v_before, p_data);

    UPDATE public.claims_records SET
      place_of_service = v_after.place_of_service,
      date_of_service = v_after.date_of_service,
      visit_number = v_after.visit_number,
      cpt_codes = v_after.cpt_codes,
      units_billed = v_after.units_billed,
      diagnosis_codes = v_after.diagnosis_codes,
      modifier = v_after.modifier,
      charge_amount = v_after.charge_amount,
      insurance_reimbursement = v_after.insurance_reimbursement,
      patient_amount_paid = v_after.patient_amount_paid,
      patient_amount_due = v_after.patient_amount_due,
      insurance_billed = v_after.insurance_billed,
      oa_claim_number = v_after.oa_claim_number,
      claim_submitted_date = v_after.claim_submitted_date,
      expire_bcbs_claim_number = v_after.expire_bcbs_claim_number,
      claim_status = v_after.claim_status,
      payment_received = v_after.payment_received,
      check_date = v_after.check_date,
      check_number_virtual_card = v_after.check_number_virtual_card,
      date_received = v_after.date_received,
      date_of_appeal = v_after.date_of_appeal,
      reference_no = v_after.reference_no,
      lmn = v_after.lmn,
      source_line_index = v_after.source_line_index,
      updated_by = p_actor_id,
      updated_by_type = p_actor_type
    WHERE id = p_id;

    FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
      IF (to_jsonb(v_before) -> v_key) IS DISTINCT FROM (to_jsonb(v_after) -> v_key) THEN
        v_before_diff := v_before_diff || jsonb_build_object(v_key, to_jsonb(v_before) -> v_key);
        v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
      END IF;
    END LOOP;

    IF v_before_diff <> '{}'::jsonb THEN
      INSERT INTO public.audit_logs (
        entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
        action, before_data, after_data, import_batch_id
      ) VALUES (
        'claim_record', p_id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
        p_action, v_before_diff, v_after_diff, p_import_batch_id
      );
    END IF;

    RETURN p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.write_claim_record_with_audit(uuid, uuid, jsonb, uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_claim_record_with_audit(uuid, uuid, jsonb, uuid, text, text, text, uuid) TO service_role;

-- ─── Staff account management RPCs (P4-P17) ────────────────────────────────
-- Each wraps the existing CAS-guarded (token_version compare-and-swap)
-- clinic_users update together with its audit_logs entry in one
-- transaction. admin_reset's audit row carries no before/after payload at
-- all (never a password hash or any credential-shaped value — only that a
-- reset happened). update_clinic_user_role_with_audit and
-- archive_clinic_user_with_audit both enforce the "last active account
-- manager" guard: an action that would leave zero active admin clinic_users
-- is rejected (ERRCODE P0023), independent of who's performing it.

CREATE OR REPLACE FUNCTION public.create_clinic_user_with_audit(
  p_username text, p_password_hash text, p_name text, p_email text,
  p_department text, p_role text, p_status text,
  p_actor_id uuid, p_actor_type text, p_actor_display text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.clinic_users (
    username, password_hash, name, email, department, role, status,
    must_change_password, token_version
  ) VALUES (
    p_username, p_password_hash, p_name, p_email, p_department, p_role, p_status,
    true, 0
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'clinic_user', v_id, p_actor_id, p_actor_type, p_actor_display,
    'ACCOUNT_CREATE', NULL,
    jsonb_build_object('username', p_username, 'name', p_name, 'role', p_role, 'status', p_status)
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_clinic_user_with_audit(text, text, text, text, text, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_clinic_user_with_audit(text, text, text, text, text, text, text, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.update_clinic_user_role_with_audit(
  p_id uuid, p_role text, p_expected_token_version integer,
  p_actor_id uuid, p_actor_type text, p_actor_display text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before public.clinic_users;
  v_other_active_admins integer;
BEGIN
  SELECT * INTO v_before FROM public.clinic_users WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clinic_user_not_found: %', p_id USING ERRCODE = 'P0021';
  END IF;
  IF v_before.token_version <> p_expected_token_version THEN
    RAISE EXCEPTION 'clinic_user_conflict: % token_version moved', p_id USING ERRCODE = 'P0022';
  END IF;

  IF v_before.role = 'admin' AND p_role <> 'admin' AND v_before.status = 'active' THEN
    SELECT count(*) INTO v_other_active_admins
    FROM public.clinic_users
    WHERE role = 'admin' AND status = 'active' AND id <> p_id;
    IF v_other_active_admins = 0 THEN
      RAISE EXCEPTION 'last_active_account_manager: cannot demote the only active admin' USING ERRCODE = 'P0023';
    END IF;
  END IF;

  UPDATE public.clinic_users
  SET role = p_role, token_version = p_expected_token_version + 1
  WHERE id = p_id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'clinic_user', p_id, p_actor_id, p_actor_type, p_actor_display,
    'ACCOUNT_ROLE_CHANGE', jsonb_build_object('role', v_before.role), jsonb_build_object('role', p_role)
  );

  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_clinic_user_role_with_audit(uuid, text, integer, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_clinic_user_role_with_audit(uuid, text, integer, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_reset_clinic_user_password_with_audit(
  p_id uuid, p_password_hash text, p_expected_token_version integer,
  p_actor_id uuid, p_actor_type text, p_actor_display text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before public.clinic_users;
BEGIN
  SELECT * INTO v_before FROM public.clinic_users WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clinic_user_not_found: %', p_id USING ERRCODE = 'P0021';
  END IF;
  IF v_before.token_version <> p_expected_token_version THEN
    RAISE EXCEPTION 'clinic_user_conflict: % token_version moved', p_id USING ERRCODE = 'P0022';
  END IF;

  UPDATE public.clinic_users
  SET password_hash = p_password_hash, must_change_password = true, token_version = p_expected_token_version + 1
  WHERE id = p_id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'clinic_user', p_id, p_actor_id, p_actor_type, p_actor_display,
    'ACCOUNT_PASSWORD_RESET', NULL, NULL
  );

  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_reset_clinic_user_password_with_audit(uuid, text, integer, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reset_clinic_user_password_with_audit(uuid, text, integer, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.archive_clinic_user_with_audit(
  p_id uuid, p_expected_token_version integer,
  p_actor_id uuid, p_actor_type text, p_actor_display text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before public.clinic_users;
  v_other_active_admins integer;
BEGIN
  SELECT * INTO v_before FROM public.clinic_users WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clinic_user_not_found: %', p_id USING ERRCODE = 'P0021';
  END IF;
  IF v_before.token_version <> p_expected_token_version THEN
    RAISE EXCEPTION 'clinic_user_conflict: % token_version moved', p_id USING ERRCODE = 'P0022';
  END IF;

  IF v_before.role = 'admin' AND v_before.status = 'active' THEN
    SELECT count(*) INTO v_other_active_admins
    FROM public.clinic_users
    WHERE role = 'admin' AND status = 'active' AND id <> p_id;
    IF v_other_active_admins = 0 THEN
      RAISE EXCEPTION 'last_active_account_manager: cannot archive the only active admin' USING ERRCODE = 'P0023';
    END IF;
  END IF;

  UPDATE public.clinic_users
  SET status = 'archived', archived_at = now(), token_version = p_expected_token_version + 1
  WHERE id = p_id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'clinic_user', p_id, p_actor_id, p_actor_type, p_actor_display,
    'ACCOUNT_ARCHIVE', jsonb_build_object('status', v_before.status), jsonb_build_object('status', 'archived')
  );

  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_clinic_user_with_audit(uuid, integer, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_clinic_user_with_audit(uuid, integer, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.reactivate_clinic_user_with_audit(
  p_id uuid, p_actor_id uuid, p_actor_type text, p_actor_display text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before public.clinic_users;
BEGIN
  SELECT * INTO v_before FROM public.clinic_users WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clinic_user_not_found: %', p_id USING ERRCODE = 'P0021';
  END IF;

  UPDATE public.clinic_users SET status = 'active', archived_at = NULL WHERE id = p_id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'clinic_user', p_id, p_actor_id, p_actor_type, p_actor_display,
    'ACCOUNT_REACTIVATE', jsonb_build_object('status', v_before.status), jsonb_build_object('status', 'active')
  );

  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reactivate_clinic_user_with_audit(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reactivate_clinic_user_with_audit(uuid, uuid, text, text) TO service_role;

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
