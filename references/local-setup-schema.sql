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
  -- P4-P23: per-session workflow fields. Nullable, NO default — NULL means
  -- "not yet set" (never an implied 'no' / 'ready_to_file').
  assignment_of_benefits text CONSTRAINT visit_records_assignment_of_benefits_check
    CHECK (assignment_of_benefits IS NULL OR assignment_of_benefits IN ('yes', 'no')),
  submission_status text CONSTRAINT visit_records_submission_status_check
    CHECK (submission_status IS NULL OR submission_status IN ('ready_to_file', 'hold', 'do_not_file')),
  remarks text CONSTRAINT visit_records_remarks_length_check
    CHECK (remarks IS NULL OR char_length(remarks) <= 2000),
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

-- ─── write_visit_record_with_audit (P4-P17R: atomic single-row visit create/update + audit) ─
-- (P4-P23: carries assignment_of_benefits/submission_status/remarks and
-- skips the UPDATE entirely on a no-op — see 20261025000000_p4_p23_session_workflow_fields.sql)
-- Same shape as write_patient_with_audit, for visit_records.create/update
-- (single row only — bulkCreateVisitRecords stays stamp-only, see that
-- function's comment in server/db.ts for why a per-row audit entry there
-- would be noise).
CREATE OR REPLACE FUNCTION public.write_visit_record_with_audit(
  p_id uuid,
  p_patient_id uuid,
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
  v_before public.visit_records;
  v_after public.visit_records;
  v_id uuid;
  v_before_diff jsonb := '{}'::jsonb;
  v_after_diff jsonb := '{}'::jsonb;
  v_key text;
BEGIN
  IF p_id IS NULL THEN
    v_after := jsonb_populate_record(NULL::public.visit_records, p_data);

    INSERT INTO public.visit_records (
      patient_id, sessions_authorized, sessions_remaining, session_number,
      auth_period, date_of_service, new_auth, date_ash_submitted, auth_status,
      insurance_company, total_insurance_reimbursement, total_patient_due, total_patient_paid,
      assignment_of_benefits, submission_status, remarks,
      created_by, created_by_type, updated_by, updated_by_type
    ) VALUES (
      p_patient_id, v_after.sessions_authorized, v_after.sessions_remaining, v_after.session_number,
      COALESCE(v_after.auth_period, 1), v_after.date_of_service, v_after.new_auth, v_after.date_ash_submitted,
      COALESCE(v_after.auth_status, 'none'), v_after.insurance_company, v_after.total_insurance_reimbursement,
      v_after.total_patient_due, v_after.total_patient_paid,
      v_after.assignment_of_benefits, v_after.submission_status, v_after.remarks,
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
      'visit_record', v_id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
      p_action, NULL, v_after_diff
    );

    RETURN v_id;
  ELSE
    SELECT * INTO v_before FROM public.visit_records WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'visit_record_not_found: %', p_id USING ERRCODE = 'P0030';
    END IF;
    -- p_patient_id is optional on update (see P4-P17R); when supplied it is
    -- checked as an ownership guard.
    IF p_patient_id IS NOT NULL AND v_before.patient_id <> p_patient_id THEN
      RAISE EXCEPTION 'visit_record_patient_mismatch: % does not belong to %', p_id, p_patient_id
        USING ERRCODE = 'P0031';
    END IF;

    v_after := jsonb_populate_record(v_before, p_data);

    FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
      IF (to_jsonb(v_before) -> v_key) IS DISTINCT FROM (to_jsonb(v_after) -> v_key) THEN
        v_before_diff := v_before_diff || jsonb_build_object(v_key, to_jsonb(v_before) -> v_key);
        v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
      END IF;
    END LOOP;

    -- No-op save: nothing changed, so neither the row nor its attribution
    -- is touched and no audit row is written.
    IF v_before_diff = '{}'::jsonb THEN
      RETURN p_id;
    END IF;

    UPDATE public.visit_records SET
      sessions_authorized = v_after.sessions_authorized,
      sessions_remaining = v_after.sessions_remaining,
      session_number = v_after.session_number,
      auth_period = v_after.auth_period,
      date_of_service = v_after.date_of_service,
      new_auth = v_after.new_auth,
      date_ash_submitted = v_after.date_ash_submitted,
      auth_status = v_after.auth_status,
      insurance_company = v_after.insurance_company,
      total_insurance_reimbursement = v_after.total_insurance_reimbursement,
      total_patient_due = v_after.total_patient_due,
      total_patient_paid = v_after.total_patient_paid,
      assignment_of_benefits = v_after.assignment_of_benefits,
      submission_status = v_after.submission_status,
      remarks = v_after.remarks,
      updated_by = p_actor_id,
      updated_by_type = p_actor_type
    WHERE id = p_id;

    INSERT INTO public.audit_logs (
      entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
      action, before_data, after_data
    ) VALUES (
      'visit_record', p_id, v_before.patient_id, p_actor_id, p_actor_type, p_actor_display,
      p_action, v_before_diff, v_after_diff
    );

    RETURN p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.write_visit_record_with_audit(uuid, uuid, jsonb, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_visit_record_with_audit(uuid, uuid, jsonb, uuid, text, text, text) TO service_role;

-- ─── write_insurer_catalog_with_audit (P4-P17R: atomic insurer create/deactivate/reactivate + audit) ─
CREATE OR REPLACE FUNCTION public.write_insurer_catalog_with_audit(
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
  v_before public.insurer_catalog;
  v_after public.insurer_catalog;
  v_id uuid;
  v_before_diff jsonb := '{}'::jsonb;
  v_after_diff jsonb := '{}'::jsonb;
  v_key text;
BEGIN
  IF p_id IS NULL THEN
    v_after := jsonb_populate_record(NULL::public.insurer_catalog, p_data);

    -- P4-P21: a deliberate re-add clears this name's permanent-delete tombstone.
    DELETE FROM public.insurer_catalog_deleted_names
    WHERE normalized_name = public.normalize_insurer_name(v_after.name);

    INSERT INTO public.insurer_catalog (
      name, created_by, created_by_type
    ) VALUES (
      v_after.name, p_actor_id, p_actor_type
    )
    RETURNING id INTO v_id;

    FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
      v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
    END LOOP;

    INSERT INTO public.audit_logs (
      entity_type, entity_id, actor_id, actor_type, actor_display,
      action, before_data, after_data
    ) VALUES (
      'insurer_catalog', v_id, p_actor_id, p_actor_type, p_actor_display,
      p_action, NULL, v_after_diff
    );

    RETURN v_id;
  ELSE
    -- P4-P21: NO KEY UPDATE so deactivate/reactivate don't block guard_insurer_assignment.
    SELECT * INTO v_before FROM public.insurer_catalog WHERE id = p_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insurer_catalog_not_found: %', p_id USING ERRCODE = 'P0032';
    END IF;

    v_after := jsonb_populate_record(v_before, p_data);

    UPDATE public.insurer_catalog SET
      is_active = v_after.is_active,
      deactivated_at = v_after.deactivated_at,
      deactivated_by = v_after.deactivated_by,
      reactivated_at = v_after.reactivated_at,
      reactivated_by = v_after.reactivated_by
    WHERE id = p_id;

    FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
      IF (to_jsonb(v_before) -> v_key) IS DISTINCT FROM (to_jsonb(v_after) -> v_key) THEN
        v_before_diff := v_before_diff || jsonb_build_object(v_key, to_jsonb(v_before) -> v_key);
        v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
      END IF;
    END LOOP;

    IF v_before_diff <> '{}'::jsonb THEN
      INSERT INTO public.audit_logs (
        entity_type, entity_id, actor_id, actor_type, actor_display,
        action, before_data, after_data
      ) VALUES (
        'insurer_catalog', p_id, p_actor_id, p_actor_type, p_actor_display,
        p_action, v_before_diff, v_after_diff
      );
    END IF;

    RETURN p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.write_insurer_catalog_with_audit(uuid, jsonb, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_insurer_catalog_with_audit(uuid, jsonb, uuid, text, text, text) TO service_role;

-- ─── Permanent insurer delete (P4-P21; see
-- supabase/migrations/20261023000000_p4_p21_insurer_permanent_delete.sql) ─
-- Same rule as shared/insuranceCatalog.ts normalizeInsurerName and the
-- insurer_catalog.normalized_name generated column.
CREATE OR REPLACE FUNCTION public.normalize_insurer_name(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT lower(btrim(regexp_replace(p_value, '\s+', ' ', 'g')));
$$;

-- ─── 3: tombstones ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.insurer_catalog_deleted_names (
  normalized_name text PRIMARY KEY,
  deleted_insurer_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.insurer_catalog_deleted_names ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insurer_catalog_deleted_names NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.insurer_catalog_deleted_names FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.insurer_catalog_deleted_names TO service_role;

CREATE OR REPLACE FUNCTION public.skip_deleted_insurer_reinsert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.insurer_catalog_deleted_names
    WHERE normalized_name = public.normalize_insurer_name(NEW.name)
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS insurer_catalog_skip_deleted_reinsert ON public.insurer_catalog;
CREATE TRIGGER insurer_catalog_skip_deleted_reinsert
  BEFORE INSERT ON public.insurer_catalog
  FOR EACH ROW EXECUTE FUNCTION public.skip_deleted_insurer_reinsert();

-- ─── 2: assignment guard ───────────────────────────────────────────────────
-- TG_ARGV[0] names the referencing column on the table the trigger is on.
CREATE OR REPLACE FUNCTION public.guard_insurer_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_new text := public.normalize_insurer_name(to_jsonb(NEW) ->> TG_ARGV[0]);
  v_ids uuid[];
  v_locked integer;
BEGIN
  IF v_new IS NULL OR v_new = '' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND public.normalize_insurer_name(to_jsonb(OLD) ->> TG_ARGV[0]) IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;

  SELECT array_agg(c.id) INTO v_ids
  FROM public.insurer_catalog c
  WHERE c.normalized_name = v_new
     OR EXISTS (SELECT 1 FROM unnest(c.aliases) a WHERE public.normalize_insurer_name(a) = v_new);

  IF v_ids IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.insurer_catalog_deleted_names WHERE normalized_name = v_new) THEN
      RAISE EXCEPTION 'This insurance company was permanently deleted. Choose a different insurance company.'
        USING ERRCODE = 'P0041';
    END IF;
    RETURN NEW;
  END IF;

  -- Blocks while a permanent delete of any of these rows is in flight; a row
  -- that delete removed is simply not returned once it commits.
  SELECT count(*) INTO v_locked FROM (
    SELECT 1 FROM public.insurer_catalog WHERE id = ANY(v_ids) FOR KEY SHARE
  ) locked;

  IF v_locked < cardinality(v_ids) THEN
    RAISE EXCEPTION 'This insurance company was permanently deleted. Choose a different insurance company.'
      USING ERRCODE = 'P0041';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS patients_guard_insurer_assignment ON public.patients;
CREATE TRIGGER patients_guard_insurer_assignment
  BEFORE INSERT OR UPDATE OF insurance ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.guard_insurer_assignment('insurance');

-- P4-P22: patients.insurance only. visit_records / claims_records record
-- historical insurer text (incl. a deleted insurer a patient still carries,
-- copied into new visit batches), so they are deliberately not guarded.
DROP TRIGGER IF EXISTS visit_records_guard_insurer_assignment ON public.visit_records;
DROP TRIGGER IF EXISTS claims_records_guard_insurer_assignment ON public.claims_records;

-- ─── 1: delete_insurer_catalog_with_audit (P4-P22: catalog-only; see
-- supabase/migrations/20261024000000_p4_p22_insurer_catalog_only_delete.sql) ─
CREATE OR REPLACE FUNCTION public.delete_insurer_catalog_with_audit(
  p_id uuid,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.insurer_catalog;
  v_values text[];
  v_patients integer;
  v_visits integer;
  v_claims integer;
BEGIN
  -- Never delete through a foreign key: an FK's ON DELETE action would change
  -- records this function promises to leave untouched.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE contype = 'f' AND confrelid = 'public.insurer_catalog'::regclass
  ) THEN
    RAISE EXCEPTION 'insurer_catalog_has_foreign_keys: refusing to delete %', p_id
      USING ERRCODE = 'P0042';
  END IF;

  SELECT * INTO v_row FROM public.insurer_catalog WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insurer_catalog_not_found: %', p_id USING ERRCODE = 'P0032';
  END IF;

  SELECT array_agg(DISTINCT v) INTO v_values
  FROM (
    SELECT public.normalize_insurer_name(x) AS v
    FROM unnest(array_prepend(v_row.name, v_row.aliases)) AS x
  ) s
  WHERE v IS NOT NULL AND v <> '';

  -- Informational only (recorded in the audit row) — records that store
  -- this name keep it; nothing here blocks the delete.
  SELECT count(*) INTO v_patients FROM public.patients
  WHERE public.normalize_insurer_name(insurance) = ANY(v_values);
  SELECT count(*) INTO v_visits FROM public.visit_records
  WHERE public.normalize_insurer_name(insurance_company) = ANY(v_values);
  SELECT count(*) INTO v_claims FROM public.claims_records
  WHERE public.normalize_insurer_name(insurance_billed) = ANY(v_values);

  DELETE FROM public.insurer_catalog WHERE id = p_id;

  INSERT INTO public.insurer_catalog_deleted_names (normalized_name, deleted_insurer_id)
  SELECT unnest(v_values), p_id
  ON CONFLICT (normalized_name) DO UPDATE
    SET deleted_insurer_id = EXCLUDED.deleted_insurer_id, deleted_at = now();

  INSERT INTO public.audit_logs (
    entity_type, entity_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'insurer_catalog', p_id, p_actor_id, p_actor_type, p_actor_display,
    'INSURER_PERMANENT_DELETE',
    jsonb_build_object(
      'id', v_row.id,
      'name', v_row.name,
      'aliases', to_jsonb(v_row.aliases),
      'is_active', v_row.is_active,
      'created_at', v_row.created_at,
      'retained_references', jsonb_build_object(
        'patients', v_patients, 'visits', v_visits, 'claims', v_claims
      )
    ),
    NULL
  );

  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_insurer_catalog_with_audit(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_insurer_catalog_with_audit(uuid, uuid, text, text) TO service_role;


-- ─── approve_authorization_with_audit (P4-P17R: atomic authorization approval + batch + audit) ─
-- Folds approveAndCreateNewBatch's writes (approve period, patch patient,
-- insert next batch) and its audit entry into one transaction. p_target_period
-- is re-validated against the patient's actual visit_records under lock
-- rather than trusted blindly; the next period is always recomputed here
-- from MAX(auth_period), never passed in.
CREATE OR REPLACE FUNCTION public.approve_authorization_with_audit(
  p_patient_id uuid,
  p_target_period integer,
  p_sessions_authorized integer,
  p_auth_date date,
  p_new_insurance text,
  p_auth_valid_until_provided boolean,
  p_auth_valid_until bigint,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text
)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_patient_exists boolean;
  v_target_exists boolean;
  v_max_period integer;
  v_next_period integer;
  v_batch_insurance text;
  v_new_ids uuid[];
BEGIN
  IF p_sessions_authorized IS NULL OR p_sessions_authorized < 1 THEN
    RAISE EXCEPTION 'invalid_sessions_authorized: %', p_sessions_authorized USING ERRCODE = 'P0033';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.patients WHERE id = p_patient_id FOR UPDATE) INTO v_patient_exists;
  IF NOT v_patient_exists THEN
    RAISE EXCEPTION 'patient_not_found: %', p_patient_id USING ERRCODE = 'P0020';
  END IF;

  PERFORM 1 FROM public.visit_records WHERE patient_id = p_patient_id FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM public.visit_records WHERE patient_id = p_patient_id AND auth_period = p_target_period
  ) INTO v_target_exists;
  IF NOT v_target_exists THEN
    RAISE EXCEPTION 'auth_period_not_found: %', p_target_period USING ERRCODE = 'P0034';
  END IF;

  UPDATE public.visit_records
  SET auth_status = 'approved', updated_by = p_actor_id, updated_by_type = p_actor_type
  WHERE patient_id = p_patient_id AND auth_period = p_target_period;

  IF p_auth_date IS NOT NULL
     OR (p_new_insurance IS NOT NULL AND length(btrim(p_new_insurance)) > 0)
     OR p_auth_valid_until_provided
  THEN
    UPDATE public.patients SET
      auth_date = COALESCE(p_auth_date, auth_date),
      insurance = CASE
        WHEN p_new_insurance IS NOT NULL AND length(btrim(p_new_insurance)) > 0 THEN btrim(p_new_insurance)
        ELSE insurance
      END,
      auth_valid_until = CASE WHEN p_auth_valid_until_provided THEN p_auth_valid_until ELSE auth_valid_until END,
      updated_by = p_actor_id,
      updated_by_type = p_actor_type
    WHERE id = p_patient_id;
  END IF;

  SELECT max(auth_period) INTO v_max_period FROM public.visit_records WHERE patient_id = p_patient_id;
  v_next_period := COALESCE(v_max_period, p_target_period) + 1;

  v_batch_insurance := NULLIF(btrim(COALESCE(p_new_insurance, '')), '');
  IF v_batch_insurance IS NULL THEN
    SELECT insurance INTO v_batch_insurance FROM public.patients WHERE id = p_patient_id;
  END IF;

  WITH inserted AS (
    INSERT INTO public.visit_records (
      patient_id, sessions_authorized, sessions_remaining, session_number,
      auth_period, date_of_service, new_auth, date_ash_submitted, auth_status,
      insurance_company, created_by, created_by_type, updated_by, updated_by_type
    )
    SELECT
      p_patient_id, p_sessions_authorized, p_sessions_authorized - (gs - 1), gs,
      v_next_period, NULL, NULL, NULL, 'none',
      v_batch_insurance, p_actor_id, p_actor_type, p_actor_id, p_actor_type
    FROM generate_series(1, p_sessions_authorized) AS gs
    RETURNING id
  )
  SELECT array_agg(id) INTO v_new_ids FROM inserted;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'visit_record', p_patient_id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    'AUTHORIZATION_APPROVED',
    jsonb_build_object('auth_period', p_target_period),
    jsonb_build_object('new_auth_period', v_next_period, 'sessions_authorized', p_sessions_authorized, 'new_visit_ids', to_jsonb(v_new_ids))
  );

  RETURN QUERY SELECT unnest(v_new_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_authorization_with_audit(uuid, integer, integer, date, text, boolean, bigint, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_authorization_with_audit(uuid, integer, integer, date, text, boolean, bigint, uuid, text, text) TO service_role;

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
  v_total_active_admins integer;
BEGIN
  SELECT * INTO v_before FROM public.clinic_users WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clinic_user_not_found: %', p_id USING ERRCODE = 'P0021';
  END IF;
  IF v_before.token_version <> p_expected_token_version THEN
    RAISE EXCEPTION 'clinic_user_conflict: % token_version moved', p_id USING ERRCODE = 'P0022';
  END IF;

  -- P4-P17R: locks the WHOLE active-admin set (not just "other" rows) so a
  -- concurrent demote/archive of a different admin blocks here instead of
  -- both transactions reading a stale pre-commit count and both passing.
  IF v_before.role = 'admin' AND p_role <> 'admin' AND v_before.status = 'active' THEN
    -- FOR UPDATE can't combine with an aggregate in one SELECT: lock every
    -- matching row first (blocks here if a concurrent call holds one),
    -- then count.
    PERFORM 1 FROM public.clinic_users WHERE role = 'admin' AND status = 'active' FOR UPDATE;
    SELECT count(*) INTO v_total_active_admins
    FROM public.clinic_users
    WHERE role = 'admin' AND status = 'active';
    IF v_total_active_admins <= 1 THEN
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
  v_total_active_admins integer;
BEGIN
  SELECT * INTO v_before FROM public.clinic_users WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clinic_user_not_found: %', p_id USING ERRCODE = 'P0021';
  END IF;
  IF v_before.token_version <> p_expected_token_version THEN
    RAISE EXCEPTION 'clinic_user_conflict: % token_version moved', p_id USING ERRCODE = 'P0022';
  END IF;

  IF v_before.role = 'admin' AND v_before.status = 'active' THEN
    -- FOR UPDATE can't combine with an aggregate in one SELECT: lock every
    -- matching row first (blocks here if a concurrent call holds one),
    -- then count.
    PERFORM 1 FROM public.clinic_users WHERE role = 'admin' AND status = 'active' FOR UPDATE;
    SELECT count(*) INTO v_total_active_admins
    FROM public.clinic_users
    WHERE role = 'admin' AND status = 'active';
    IF v_total_active_admins <= 1 THEN
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
