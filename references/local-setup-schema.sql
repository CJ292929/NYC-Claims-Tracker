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

-- ─── claim_import_documents (P4-P24: one row per uploaded CMS1500/EOB file) ─
-- See 20261026000000_p4_p24_cms1500_first_claim_lines.sql.
CREATE TABLE IF NOT EXISTS public.claim_import_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_kind text NOT NULL CHECK (document_kind IN ('cms1500', 'eob')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  file_name text CHECK (file_name IS NULL OR char_length(file_name) <= 255),
  page_count integer CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 500),
  created_by uuid,
  created_by_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_import_documents_kind_sha_key UNIQUE (document_kind, content_sha256)
);

-- Server-only, same lockdown as audit_logs / insurer_catalog.
ALTER TABLE public.claim_import_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_import_documents NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.claim_import_documents FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.claim_import_documents TO service_role;

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
  -- P4-P24: source provenance. NULL on every pre-P4-P24 row (historical
  -- reimbursement-first rows are never backfilled). A CMS1500 commit stamps
  -- cms1500_*; an EOB apply stamps eob_* and requires cms1500_* to be set.
  cms1500_document_id uuid REFERENCES public.claim_import_documents(id),
  cms1500_line_key text,
  eob_document_id uuid REFERENCES public.claim_import_documents(id),
  eob_line_key text,
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

-- P4-P24: provenance columns for an already-existing claims_records table.
ALTER TABLE public.claims_records
  ADD COLUMN IF NOT EXISTS cms1500_document_id uuid REFERENCES public.claim_import_documents(id),
  ADD COLUMN IF NOT EXISTS cms1500_line_key text,
  ADD COLUMN IF NOT EXISTS eob_document_id uuid REFERENCES public.claim_import_documents(id),
  ADD COLUMN IF NOT EXISTS eob_line_key text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_records_cms1500_source_pair_check') THEN
    ALTER TABLE public.claims_records ADD CONSTRAINT claims_records_cms1500_source_pair_check
      CHECK ((cms1500_document_id IS NULL) = (cms1500_line_key IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_records_eob_source_pair_check') THEN
    ALTER TABLE public.claims_records ADD CONSTRAINT claims_records_eob_source_pair_check
      CHECK ((eob_document_id IS NULL) = (eob_line_key IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_records_source_line_key_format_check') THEN
    ALTER TABLE public.claims_records ADD CONSTRAINT claims_records_source_line_key_format_check
      CHECK (
        (cms1500_line_key IS NULL OR cms1500_line_key ~ '^[A-Za-z0-9:_.,-]{1,160}$')
        AND (eob_line_key IS NULL OR eob_line_key ~ '^[A-Za-z0-9:_.,-]{1,160}$')
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_cms1500_source_line
  ON public.claims_records (cms1500_document_id, cms1500_line_key)
  WHERE cms1500_document_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_eob_source_line
  ON public.claims_records (eob_document_id, eob_line_key)
  WHERE eob_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_patient_dos
  ON public.claims_records (patient_id, date_of_service);


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

-- ─── P4-P24: CMS1500-first import RPCs ──────────────────────────────────────
-- See 20261026000000_p4_p24_cms1500_first_claim_lines.sql for the full
-- rationale and error-code table.
-- ─── helper: resolve (or create) the document row for one upload ───────────
CREATE OR REPLACE FUNCTION public.claim_import_document_id(
  p_kind text,
  p_content_sha256 text,
  p_file_name text,
  p_page_count integer,
  p_actor_id uuid,
  p_actor_type text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_import_input: content_sha256' USING ERRCODE = 'P0027';
  END IF;
  INSERT INTO public.claim_import_documents (document_kind, content_sha256, file_name, page_count, created_by, created_by_type)
  VALUES (p_kind, p_content_sha256, left(p_file_name, 255), p_page_count, p_actor_id, p_actor_type)
  ON CONFLICT ON CONSTRAINT claim_import_documents_kind_sha_key DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.claim_import_documents
    WHERE document_kind = p_kind AND content_sha256 = p_content_sha256;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_import_document_id(text, text, text, integer, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_import_document_id(text, text, text, integer, uuid, text) TO service_role;

-- ─── commit_cms1500_line_with_audit ────────────────────────────────────────
-- p_data carries ONLY clinical keys; anything else is ignored. Accepted:
--   date_of_service (required), cpt_codes (required), place_of_service,
--   modifier, units_billed, diagnosis_codes, claim_submitted_date,
--   insurance_billed, visit_number.
-- Exactly one of three outcomes per call:
--   * this source line was saved before (same document + line key)
--       -> re-apply clinical fields to that row ('updated' / 'unchanged')
--   * p_target_claim_id given (reviewed association with an existing,
--     typically historical reimbursement-first row)
--       -> stamp provenance + clinical fields on it, money untouched,
--          auth_period untouched ('associated')
--   * otherwise insert a new line with every money column NULL
--     ('created'). Refused with P0021 when any other row for this patient
--     already sits at the same date + CPT and is not a sibling line of this
--     same extraction (p_sibling_line_keys), unless p_allow_new_distinct is
--     true (an explicit "this is a separate service line" decision).
CREATE OR REPLACE FUNCTION public.commit_cms1500_line_with_audit(
  p_patient_id uuid,
  p_auth_period integer,
  p_content_sha256 text,
  p_file_name text,
  p_page_count integer,
  p_line_key text,
  p_sibling_line_keys text[],
  p_target_claim_id uuid,
  p_allow_new_distinct boolean,
  p_data jsonb,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_import_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_clinical constant text[] := ARRAY[
    'date_of_service', 'cpt_codes', 'place_of_service', 'modifier', 'units_billed',
    'diagnosis_codes', 'claim_submitted_date', 'insurance_billed', 'visit_number'
  ];
  v_doc uuid;
  v_clean jsonb;
  v_dos date;
  v_cpt text;
  v_before public.claims_records;
  v_after public.claims_records;
  v_id uuid;
  v_status text;
  v_action text;
  v_key text;
  v_before_diff jsonb := '{}'::jsonb;
  v_after_diff jsonb := '{}'::jsonb;
BEGIN
  IF p_patient_id IS NULL OR p_line_key IS NULL OR p_line_key !~ '^[A-Za-z0-9:_.,-]{1,160}$' THEN
    RAISE EXCEPTION 'invalid_import_input: patient/line key' USING ERRCODE = 'P0027';
  END IF;

  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO v_clean
  FROM jsonb_each(COALESCE(p_data, '{}'::jsonb))
  WHERE key = ANY (c_clinical) AND value <> 'null'::jsonb;

  v_dos := (v_clean ->> 'date_of_service')::date;
  v_cpt := NULLIF(btrim(v_clean ->> 'cpt_codes'), '');
  IF v_dos IS NULL OR v_cpt IS NULL THEN
    RAISE EXCEPTION 'invalid_import_input: date_of_service and cpt_codes are required' USING ERRCODE = 'P0027';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('claims-import-patient:' || p_patient_id::text));
  v_doc := public.claim_import_document_id('cms1500', p_content_sha256, p_file_name, p_page_count, p_actor_id, p_actor_type);

  SELECT * INTO v_before FROM public.claims_records
  WHERE cms1500_document_id = v_doc AND cms1500_line_key = p_line_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_before.patient_id <> p_patient_id THEN
      RAISE EXCEPTION 'claim_record_patient_mismatch: source line saved for another patient' USING ERRCODE = 'P0011';
    END IF;
    IF p_target_claim_id IS NOT NULL AND p_target_claim_id <> v_before.id THEN
      RAISE EXCEPTION 'source_line_already_saved: %', v_before.id USING ERRCODE = 'P0024';
    END IF;
    v_action := 'CLAIM_RECORD_CMS1500_REAPPLY';
  ELSIF p_target_claim_id IS NOT NULL THEN
    SELECT * INTO v_before FROM public.claims_records WHERE id = p_target_claim_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'claim_record_not_found: %', p_target_claim_id USING ERRCODE = 'P0010';
    END IF;
    IF v_before.patient_id <> p_patient_id THEN
      RAISE EXCEPTION 'claim_record_patient_mismatch: % does not belong to %', p_target_claim_id, p_patient_id USING ERRCODE = 'P0011';
    END IF;
    IF v_before.cms1500_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'claim_record_has_cms1500: %', p_target_claim_id USING ERRCODE = 'P0025';
    END IF;
    IF v_before.date_of_service IS DISTINCT FROM v_dos OR v_before.cpt_codes IS DISTINCT FROM v_cpt THEN
      RAISE EXCEPTION 'claim_record_incompatible: date/CPT differ' USING ERRCODE = 'P0026';
    END IF;
    v_action := 'CLAIM_RECORD_CMS1500_ASSOCIATE';
  ELSE
    IF NOT COALESCE(p_allow_new_distinct, false) AND EXISTS (
      SELECT 1 FROM public.claims_records r
      WHERE r.patient_id = p_patient_id
        AND r.date_of_service = v_dos
        AND r.cpt_codes = v_cpt
        AND (
          r.cms1500_document_id IS DISTINCT FROM v_doc
          OR NOT (r.cms1500_line_key = ANY (COALESCE(p_sibling_line_keys, ARRAY[]::text[])))
        )
    ) THEN
      RAISE EXCEPTION 'needs_selection: an existing claim line already sits at this date and CPT' USING ERRCODE = 'P0021';
    END IF;
    IF p_auth_period IS NULL OR p_auth_period < 1 THEN
      RAISE EXCEPTION 'period_required: a new line needs an authorization period' USING ERRCODE = 'P0029';
    END IF;

    v_after := jsonb_populate_record(NULL::public.claims_records, v_clean);
    INSERT INTO public.claims_records (
      patient_id, auth_period, place_of_service, date_of_service, visit_number, cpt_codes,
      units_billed, diagnosis_codes, modifier, insurance_billed, claim_submitted_date,
      claim_status, cms1500_document_id, cms1500_line_key,
      created_by, created_by_type, updated_by, updated_by_type
    ) VALUES (
      p_patient_id, p_auth_period, v_after.place_of_service, v_after.date_of_service, v_after.visit_number, v_after.cpt_codes,
      v_after.units_billed, v_after.diagnosis_codes, v_after.modifier, v_after.insurance_billed, v_after.claim_submitted_date,
      'submitted', v_doc, p_line_key,
      p_actor_id, p_actor_type, p_actor_id, p_actor_type
    )
    RETURNING * INTO v_after;

    FOR v_key IN SELECT jsonb_object_keys(v_clean) LOOP
      v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
    END LOOP;
    v_after_diff := v_after_diff || jsonb_build_object(
      'auth_period', v_after.auth_period,
      'cms1500_document_id', v_doc,
      'cms1500_line_key', p_line_key
    );

    INSERT INTO public.audit_logs (
      entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
      action, before_data, after_data, import_batch_id
    ) VALUES (
      'claim_record', v_after.id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
      'CLAIM_RECORD_CMS1500_CREATE', NULL, v_after_diff, p_import_batch_id
    );

    RETURN jsonb_build_object('status', 'created', 'claim_id', v_after.id, 'auth_period', v_after.auth_period, 'document_id', v_doc);
  END IF;

  -- Re-apply / associate: patch clinical fields + provenance on v_before.
  v_after := jsonb_populate_record(v_before, v_clean);
  v_after.cms1500_document_id := v_doc;
  v_after.cms1500_line_key := p_line_key;

  FOR v_key IN SELECT unnest(c_clinical || ARRAY['cms1500_document_id', 'cms1500_line_key']) LOOP
    IF (to_jsonb(v_before) -> v_key) IS DISTINCT FROM (to_jsonb(v_after) -> v_key) THEN
      v_before_diff := v_before_diff || jsonb_build_object(v_key, to_jsonb(v_before) -> v_key);
      v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
    END IF;
  END LOOP;

  IF v_before_diff = '{}'::jsonb THEN
    RETURN jsonb_build_object('status', 'unchanged', 'claim_id', v_before.id, 'auth_period', v_before.auth_period, 'document_id', v_doc);
  END IF;

  UPDATE public.claims_records SET
    date_of_service = v_after.date_of_service,
    cpt_codes = v_after.cpt_codes,
    place_of_service = v_after.place_of_service,
    modifier = v_after.modifier,
    units_billed = v_after.units_billed,
    diagnosis_codes = v_after.diagnosis_codes,
    claim_submitted_date = v_after.claim_submitted_date,
    insurance_billed = v_after.insurance_billed,
    visit_number = v_after.visit_number,
    cms1500_document_id = v_after.cms1500_document_id,
    cms1500_line_key = v_after.cms1500_line_key,
    updated_by = p_actor_id,
    updated_by_type = p_actor_type
  WHERE id = v_before.id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data, import_batch_id
  ) VALUES (
    'claim_record', v_before.id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    v_action, v_before_diff, v_after_diff, p_import_batch_id
  );

  v_status := CASE WHEN v_action = 'CLAIM_RECORD_CMS1500_ASSOCIATE' THEN 'associated' ELSE 'updated' END;
  RETURN jsonb_build_object('status', v_status, 'claim_id', v_before.id, 'auth_period', v_before.auth_period, 'document_id', v_doc);
END;
$$;

REVOKE ALL ON FUNCTION public.commit_cms1500_line_with_audit(uuid, integer, text, text, integer, text, text[], uuid, boolean, jsonb, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_cms1500_line_with_audit(uuid, integer, text, text, integer, text, text[], uuid, boolean, jsonb, uuid, text, text, uuid) TO service_role;

-- ─── apply_eob_line_with_audit ─────────────────────────────────────────────
-- p_match carries the EOB line's own date_of_service / cpt_codes, checked
-- against the target row. p_data carries ONLY financial / adjudication keys;
-- anything else is ignored, and a JSON null (unknown) never overwrites a
-- stored value. Accepted:
--   charge_amount (billed), insurance_reimbursement, payment_received,
--   patient_amount_due (patient responsibility), patient_amount_paid,
--   claim_status, oa_claim_number, check_date, check_number_virtual_card,
--   date_received, expire_bcbs_claim_number.
-- Clinical fields (CPT, modifiers, units, diagnosis) are never written: the
-- CMS1500 owns them.
-- p_confirm_replace is the explicit reviewed decision required to (a)
-- overwrite a different non-null amount already on the row (manual or
-- historical reimbursement-first money), or (b) move the row's EOB
-- provenance from another EOB line (a corrected/reprocessed EOB).
CREATE OR REPLACE FUNCTION public.apply_eob_line_with_audit(
  p_patient_id uuid,
  p_content_sha256 text,
  p_file_name text,
  p_page_count integer,
  p_line_key text,
  p_target_claim_id uuid,
  p_match jsonb,
  p_confirm_replace boolean,
  p_data jsonb,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_import_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_financial constant text[] := ARRAY[
    'charge_amount', 'insurance_reimbursement', 'payment_received', 'patient_amount_due',
    'patient_amount_paid', 'claim_status', 'oa_claim_number', 'check_date',
    'check_number_virtual_card', 'date_received', 'expire_bcbs_claim_number'
  ];
  v_doc uuid;
  v_clean jsonb;
  v_prev_id uuid;
  v_same_line boolean;
  v_before public.claims_records;
  v_after public.claims_records;
  v_key text;
  v_before_diff jsonb := '{}'::jsonb;
  v_after_diff jsonb := '{}'::jsonb;
BEGIN
  IF p_patient_id IS NULL OR p_target_claim_id IS NULL OR p_line_key IS NULL
     OR p_line_key !~ '^[A-Za-z0-9:_.,-]{1,160}$' THEN
    RAISE EXCEPTION 'invalid_import_input: patient/target/line key' USING ERRCODE = 'P0027';
  END IF;

  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO v_clean
  FROM jsonb_each(COALESCE(p_data, '{}'::jsonb))
  WHERE key = ANY (c_financial) AND value <> 'null'::jsonb;

  PERFORM pg_advisory_xact_lock(hashtext('claims-import-patient:' || p_patient_id::text));
  v_doc := public.claim_import_document_id('eob', p_content_sha256, p_file_name, p_page_count, p_actor_id, p_actor_type);

  SELECT id INTO v_prev_id FROM public.claims_records
  WHERE eob_document_id = v_doc AND eob_line_key = p_line_key;
  IF v_prev_id IS NOT NULL AND v_prev_id <> p_target_claim_id THEN
    RAISE EXCEPTION 'source_line_already_saved: %', v_prev_id USING ERRCODE = 'P0024';
  END IF;

  SELECT * INTO v_before FROM public.claims_records WHERE id = p_target_claim_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'claim_record_not_found: %', p_target_claim_id USING ERRCODE = 'P0010';
  END IF;
  IF v_before.patient_id <> p_patient_id THEN
    RAISE EXCEPTION 'claim_record_patient_mismatch: % does not belong to %', p_target_claim_id, p_patient_id USING ERRCODE = 'P0011';
  END IF;
  IF v_before.cms1500_document_id IS NULL THEN
    RAISE EXCEPTION 'cms1500_required: upload the matching CMS1500 first' USING ERRCODE = 'P0022';
  END IF;
  IF v_before.date_of_service IS DISTINCT FROM (p_match ->> 'date_of_service')::date
     OR v_before.cpt_codes IS DISTINCT FROM NULLIF(btrim(p_match ->> 'cpt_codes'), '') THEN
    RAISE EXCEPTION 'claim_record_incompatible: date/CPT differ' USING ERRCODE = 'P0026';
  END IF;
  v_same_line := v_before.eob_document_id IS NOT DISTINCT FROM v_doc
    AND v_before.eob_line_key IS NOT DISTINCT FROM p_line_key;
  IF v_before.eob_document_id IS NOT NULL AND NOT v_same_line
     AND NOT COALESCE(p_confirm_replace, false) THEN
    RAISE EXCEPTION 'already_reconciled: row carries another EOB line' USING ERRCODE = 'P0023';
  END IF;

  v_after := jsonb_populate_record(v_before, v_clean);

  IF NOT COALESCE(p_confirm_replace, false) AND NOT v_same_line THEN
    FOR v_key IN SELECT jsonb_object_keys(v_clean) LOOP
      IF v_key <> 'claim_status'
         AND (to_jsonb(v_before) -> v_key) <> 'null'::jsonb
         AND (to_jsonb(v_before) -> v_key) IS DISTINCT FROM (to_jsonb(v_after) -> v_key) THEN
        RAISE EXCEPTION 'existing_financials: % already has a different value', v_key USING ERRCODE = 'P0028';
      END IF;
    END LOOP;
  END IF;

  v_after.eob_document_id := v_doc;
  v_after.eob_line_key := p_line_key;

  FOR v_key IN SELECT unnest(c_financial || ARRAY['eob_document_id', 'eob_line_key']) LOOP
    IF (to_jsonb(v_before) -> v_key) IS DISTINCT FROM (to_jsonb(v_after) -> v_key) THEN
      v_before_diff := v_before_diff || jsonb_build_object(v_key, to_jsonb(v_before) -> v_key);
      v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
    END IF;
  END LOOP;

  IF v_before_diff = '{}'::jsonb THEN
    RETURN jsonb_build_object('status', 'unchanged', 'claim_id', v_before.id, 'auth_period', v_before.auth_period, 'document_id', v_doc);
  END IF;

  UPDATE public.claims_records SET
    charge_amount = v_after.charge_amount,
    insurance_reimbursement = v_after.insurance_reimbursement,
    payment_received = v_after.payment_received,
    patient_amount_due = v_after.patient_amount_due,
    patient_amount_paid = v_after.patient_amount_paid,
    claim_status = v_after.claim_status,
    oa_claim_number = v_after.oa_claim_number,
    check_date = v_after.check_date,
    check_number_virtual_card = v_after.check_number_virtual_card,
    date_received = v_after.date_received,
    expire_bcbs_claim_number = v_after.expire_bcbs_claim_number,
    eob_document_id = v_after.eob_document_id,
    eob_line_key = v_after.eob_line_key,
    updated_by = p_actor_id,
    updated_by_type = p_actor_type
  WHERE id = v_before.id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data, import_batch_id
  ) VALUES (
    'claim_record', v_before.id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    'CLAIM_RECORD_EOB_APPLY', v_before_diff, v_after_diff, p_import_batch_id
  );

  RETURN jsonb_build_object('status', 'saved', 'claim_id', v_before.id, 'auth_period', v_before.auth_period, 'document_id', v_doc);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_eob_line_with_audit(uuid, text, text, integer, text, uuid, jsonb, boolean, jsonb, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_eob_line_with_audit(uuid, text, text, integer, text, uuid, jsonb, boolean, jsonb, uuid, text, text, uuid) TO service_role;


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

-- ─── P4-P28: import patient identity and pending EOB lines ─────────
-- See supabase/migrations/20261101000000_p4_p28_import_patient_identity_and_pending_eob.sql

-- ─── audit_logs: new entity type ───────────────────────────────────────────
ALTER TABLE public.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_entity_type_check CHECK (
  entity_type IS NULL OR entity_type IN (
    'patient', 'visit_record', 'claim_record', 'insurer_catalog', 'clinic_user', 'pending_eob_line'
  )
);

-- ─── patient_external_ids ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.patient_external_ids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  source_system text NOT NULL CHECK (source_system ~ '^[a-z0-9_]{1,60}$'),
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  birth_date date,
  created_by uuid,
  created_by_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_external_ids_source_id_key UNIQUE (source_system, external_id)
);
CREATE INDEX IF NOT EXISTS idx_patient_external_ids_patient ON public.patient_external_ids (patient_id);

ALTER TABLE public.patient_external_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_external_ids NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.patient_external_ids FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.patient_external_ids TO service_role;

-- ─── pending_eob_lines ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pending_eob_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.claim_import_documents(id),
  line_key text NOT NULL CHECK (line_key ~ '^[A-Za-z0-9:_.,-]{1,160}$'),
  date_of_service date NOT NULL,
  cpt_codes text NOT NULL,
  modifier text,
  units_billed integer,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  target jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  applied_claim_id uuid REFERENCES public.claims_records(id) ON DELETE SET NULL,
  created_by uuid,
  created_by_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT pending_eob_lines_source_line_key UNIQUE (document_id, line_key)
);
CREATE INDEX IF NOT EXISTS idx_pending_eob_lines_open ON public.pending_eob_lines (created_at) WHERE status = 'pending';

ALTER TABLE public.pending_eob_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_eob_lines NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.pending_eob_lines FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pending_eob_lines TO service_role;

-- ─── helper: order-insensitive name key (same rule as shared/nameMatch.ts) ─
CREATE OR REPLACE FUNCTION public.import_patient_name_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT string_agg(t, ' ' ORDER BY t)
  FROM regexp_split_to_table(regexp_replace(regexp_replace(upper(COALESCE(p_name, '')), '[''’]', '', 'g'), '[,.\s-]+', ' ', 'g'), ' ') AS t
  WHERE t <> ''
$$;

REVOKE ALL ON FUNCTION public.import_patient_name_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_patient_name_key(text) TO service_role;

-- ─── link_patient_external_id_with_audit ───────────────────────────────────
-- A reviewed link between an existing patient and an external id. Never
-- changes the patient row. A repeat is a no-op with no audit row.
CREATE OR REPLACE FUNCTION public.link_patient_external_id_with_audit(
  p_patient_id uuid,
  p_source_system text,
  p_external_id text,
  p_birth_date date,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_import_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing uuid;
  v_id uuid;
BEGIN
  IF p_patient_id IS NULL OR p_external_id IS NULL OR btrim(p_external_id) = '' THEN
    RAISE EXCEPTION 'invalid_import_input: patient/external id' USING ERRCODE = 'P0027';
  END IF;
  PERFORM 1 FROM public.patients WHERE id = p_patient_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient_not_found: %', p_patient_id USING ERRCODE = 'P0020';
  END IF;

  INSERT INTO public.patient_external_ids (patient_id, source_system, external_id, birth_date, created_by, created_by_type)
  VALUES (p_patient_id, p_source_system, p_external_id, p_birth_date, p_actor_id, p_actor_type)
  ON CONFLICT ON CONSTRAINT patient_external_ids_source_id_key DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT patient_id INTO v_existing FROM public.patient_external_ids
    WHERE source_system = p_source_system AND external_id = p_external_id;
    IF v_existing <> p_patient_id THEN
      RAISE EXCEPTION 'external_id_taken: belongs to another patient' USING ERRCODE = 'P0031';
    END IF;
    RETURN jsonb_build_object('status', 'unchanged');
  END IF;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data, import_batch_id
  ) VALUES (
    'patient', p_patient_id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    'PATIENT_EXTERNAL_ID_LINK', NULL,
    jsonb_build_object('source_system', p_source_system, 'external_id', p_external_id),
    p_import_batch_id
  );
  RETURN jsonb_build_object('status', 'linked');
END;
$$;

REVOKE ALL ON FUNCTION public.link_patient_external_id_with_audit(uuid, text, text, date, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_patient_external_id_with_audit(uuid, text, text, date, uuid, text, text, uuid) TO service_role;

-- ─── hold_eob_line_with_audit ──────────────────────────────────────────────
-- Keeps one reviewed EOB line pending. p_match: date_of_service, cpt_codes,
-- modifier, units_billed. p_data: the same financial keys
-- apply_eob_line_with_audit accepts. p_target: optional CMS1500 reference from
-- a CSV row (cms1500_sha256, line_key, label, auth_period).
-- Refused (P0032) when a claim row already carries this source line. A retry
-- with the same values is a no-op with no audit row; a corrected re-import of
-- an unresolved line updates it.
CREATE OR REPLACE FUNCTION public.hold_eob_line_with_audit(
  p_patient_id uuid,
  p_content_sha256 text,
  p_file_name text,
  p_page_count integer,
  p_line_key text,
  p_match jsonb,
  p_data jsonb,
  p_target jsonb,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_import_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_financial constant text[] := ARRAY[
    'charge_amount', 'insurance_reimbursement', 'payment_received', 'patient_amount_due',
    'patient_amount_paid', 'claim_status', 'oa_claim_number', 'check_date',
    'check_number_virtual_card', 'date_received', 'expire_bcbs_claim_number'
  ];
  v_doc uuid;
  v_clean jsonb;
  v_dos date;
  v_cpt text;
  v_row public.pending_eob_lines;
BEGIN
  IF p_patient_id IS NULL OR p_line_key IS NULL OR p_line_key !~ '^[A-Za-z0-9:_.,-]{1,160}$' THEN
    RAISE EXCEPTION 'invalid_import_input: patient/line key' USING ERRCODE = 'P0027';
  END IF;
  v_dos := (p_match ->> 'date_of_service')::date;
  v_cpt := NULLIF(btrim(p_match ->> 'cpt_codes'), '');
  IF v_dos IS NULL OR v_cpt IS NULL THEN
    RAISE EXCEPTION 'invalid_import_input: date_of_service and cpt_codes are required' USING ERRCODE = 'P0027';
  END IF;

  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO v_clean
  FROM jsonb_each(COALESCE(p_data, '{}'::jsonb))
  WHERE key = ANY (c_financial) AND value <> 'null'::jsonb;

  PERFORM pg_advisory_xact_lock(hashtext('claims-import-patient:' || p_patient_id::text));
  v_doc := public.claim_import_document_id('eob', p_content_sha256, p_file_name, p_page_count, p_actor_id, p_actor_type);

  IF EXISTS (SELECT 1 FROM public.claims_records WHERE eob_document_id = v_doc AND eob_line_key = p_line_key) THEN
    RAISE EXCEPTION 'pending_not_needed: this line is already on a claim row' USING ERRCODE = 'P0032';
  END IF;

  SELECT * INTO v_row FROM public.pending_eob_lines
  WHERE document_id = v_doc AND line_key = p_line_key FOR UPDATE;

  IF FOUND THEN
    IF v_row.patient_id <> p_patient_id THEN
      RAISE EXCEPTION 'pending_line_patient_mismatch: saved for another patient' USING ERRCODE = 'P0011';
    END IF;
    -- A reviewer closed this line: re-importing the document never reopens it.
    -- Only reopen_dismissed_eob_line_with_audit does, on an explicit decision.
    IF v_row.status = 'dismissed' THEN
      RAISE EXCEPTION 'pending_line_dismissed: reopen it first' USING ERRCODE = 'P0033';
    END IF;
    -- A new reviewed save reopens a line applied to a claim row since deleted
    -- (a row still carrying it was refused above).
    IF v_row.status = 'pending' AND (
      v_row.data = v_clean AND v_row.date_of_service = v_dos AND v_row.cpt_codes = v_cpt
      AND v_row.modifier IS NOT DISTINCT FROM (p_match ->> 'modifier')
      AND v_row.units_billed IS NOT DISTINCT FROM (p_match ->> 'units_billed')::integer
      AND v_row.target IS NOT DISTINCT FROM p_target
    ) THEN
      RETURN jsonb_build_object('status', 'unchanged', 'pending_id', v_row.id, 'document_id', v_doc);
    END IF;
    UPDATE public.pending_eob_lines SET
      date_of_service = v_dos, cpt_codes = v_cpt, modifier = p_match ->> 'modifier',
      units_billed = (p_match ->> 'units_billed')::integer, data = v_clean, target = p_target,
      status = 'pending', applied_claim_id = NULL, resolved_at = NULL
    WHERE id = v_row.id;
    INSERT INTO public.audit_logs (
      entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
      action, before_data, after_data, import_batch_id
    ) VALUES (
      'pending_eob_line', v_row.id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
      'EOB_LINE_PENDING_UPDATE',
      jsonb_build_object('status', v_row.status, 'date_of_service', v_row.date_of_service, 'cpt_codes', v_row.cpt_codes, 'data', v_row.data),
      jsonb_build_object('status', 'pending', 'date_of_service', v_dos, 'cpt_codes', v_cpt, 'data', v_clean),
      p_import_batch_id
    );
    RETURN jsonb_build_object('status', 'updated', 'pending_id', v_row.id, 'document_id', v_doc);
  END IF;

  INSERT INTO public.pending_eob_lines (
    patient_id, document_id, line_key, date_of_service, cpt_codes, modifier, units_billed, data, target,
    created_by, created_by_type
  ) VALUES (
    p_patient_id, v_doc, p_line_key, v_dos, v_cpt, p_match ->> 'modifier', (p_match ->> 'units_billed')::integer, v_clean, p_target,
    p_actor_id, p_actor_type
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data, import_batch_id
  ) VALUES (
    'pending_eob_line', v_row.id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    'EOB_LINE_PENDING_CREATE', NULL,
    jsonb_build_object('date_of_service', v_dos, 'cpt_codes', v_cpt, 'document_id', v_doc, 'line_key', p_line_key, 'data', v_clean),
    p_import_batch_id
  );
  RETURN jsonb_build_object('status', 'created', 'pending_id', v_row.id, 'document_id', v_doc);
END;
$$;

REVOKE ALL ON FUNCTION public.hold_eob_line_with_audit(uuid, text, text, integer, text, jsonb, jsonb, jsonb, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_eob_line_with_audit(uuid, text, text, integer, text, jsonb, jsonb, jsonb, uuid, text, text, uuid) TO service_role;

-- ─── commit_import_with_new_patient ────────────────────────────────────────
-- The whole first save of a group whose patient does not exist yet.
--   p_kind 'cms1500': each p_lines item is { line_key, auth_period, data } as
--     commit_cms1500_line_with_audit takes them.
--   p_kind 'eob': each item is { line_key, match, data, target } as
--     hold_eob_line_with_audit takes them. An EOB never creates a claim row.
-- Returns status 'patient_exists' (with patient_id, and writes nothing) when
-- the external id or this group's creation key is already mapped: the caller
-- then saves through the normal per-line path for that patient, which is what
-- makes retries and concurrent imports converge on one patient.
-- Only name is written to the patient: insurance stays '' and every
-- authorization field stays NULL. Requires at least one line, so a save with
-- nothing to keep can never leave an orphan patient behind.
CREATE OR REPLACE FUNCTION public.commit_import_with_new_patient(
  p_kind text,
  p_patient_name text,
  p_source_system text,
  p_external_id text,
  p_birth_date date,
  p_creation_key text,
  p_allow_same_name boolean,
  p_content_sha256 text,
  p_file_name text,
  p_page_count integer,
  p_sibling_line_keys text[],
  p_lines jsonb,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_import_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_name text := NULLIF(btrim(COALESCE(p_patient_name, '')), '');
  v_existing uuid;
  v_patient uuid;
  v_item jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF p_kind NOT IN ('cms1500', 'eob') OR v_name IS NULL OR char_length(v_name) > 200
     OR p_creation_key IS NULL OR p_creation_key = ''
     OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'invalid_import_input: new patient name, creation key and at least one line are required' USING ERRCODE = 'P0027';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('claims-import-new-patient'));

  IF p_external_id IS NOT NULL AND p_source_system IS NOT NULL THEN
    SELECT patient_id INTO v_existing FROM public.patient_external_ids
    WHERE source_system = p_source_system AND external_id = p_external_id;
  END IF;
  IF v_existing IS NULL THEN
    SELECT patient_id INTO v_existing FROM public.patient_external_ids
    WHERE source_system = 'claims_import_group' AND external_id = p_creation_key;
  END IF;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'patient_exists', 'patient_id', v_existing);
  END IF;

  IF NOT COALESCE(p_allow_same_name, false) AND EXISTS (
    SELECT 1 FROM public.patients WHERE public.import_patient_name_key(name) = public.import_patient_name_key(v_name)
  ) THEN
    RAISE EXCEPTION 'patient_name_exists: re-check the review' USING ERRCODE = 'P0030';
  END IF;

  INSERT INTO public.patients (name, created_by, created_by_type, updated_by, updated_by_type)
  VALUES (v_name, p_actor_id, p_actor_type, p_actor_id, p_actor_type)
  RETURNING id INTO v_patient;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data, import_batch_id
  ) VALUES (
    'patient', v_patient, v_patient, p_actor_id, p_actor_type, p_actor_display,
    'PATIENT_CREATE_FROM_IMPORT', NULL,
    jsonb_build_object('name', v_name, 'source_kind', p_kind, 'source_file', left(p_file_name, 255)),
    p_import_batch_id
  );

  INSERT INTO public.patient_external_ids (patient_id, source_system, external_id, birth_date, created_by, created_by_type)
  VALUES (v_patient, 'claims_import_group', p_creation_key, p_birth_date, p_actor_id, p_actor_type);

  IF p_external_id IS NOT NULL AND p_source_system IS NOT NULL THEN
    PERFORM public.link_patient_external_id_with_audit(
      v_patient, p_source_system, p_external_id, p_birth_date, p_actor_id, p_actor_type, p_actor_display, p_import_batch_id
    );
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF p_kind = 'cms1500' THEN
      v_result := public.commit_cms1500_line_with_audit(
        v_patient, (v_item ->> 'auth_period')::integer, p_content_sha256, p_file_name, p_page_count,
        v_item ->> 'line_key', p_sibling_line_keys, NULL, false, v_item -> 'data',
        p_actor_id, p_actor_type, p_actor_display, p_import_batch_id
      );
    ELSE
      v_result := public.hold_eob_line_with_audit(
        v_patient, p_content_sha256, p_file_name, p_page_count, v_item ->> 'line_key',
        v_item -> 'match', v_item -> 'data', NULLIF(v_item -> 'target', 'null'::jsonb),
        p_actor_id, p_actor_type, p_actor_display, p_import_batch_id
      );
    END IF;
    v_results := v_results || jsonb_build_array(v_result || jsonb_build_object('line_key', v_item ->> 'line_key'));
  END LOOP;

  RETURN jsonb_build_object('status', 'created', 'patient_id', v_patient, 'lines', v_results);
END;
$$;

REVOKE ALL ON FUNCTION public.commit_import_with_new_patient(text, text, text, text, date, text, boolean, text, text, integer, text[], jsonb, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_import_with_new_patient(text, text, text, text, date, text, boolean, text, text, integer, text[], jsonb, uuid, text, text, uuid) TO service_role;

-- ─── apply_pending_eob_line_with_audit ─────────────────────────────────────
-- Applies a pending line through apply_eob_line_with_audit, so every
-- CMS1500-first, double-payment and replace rule is the same one a normal EOB
-- save goes through. A second call on an applied line changes nothing.
CREATE OR REPLACE FUNCTION public.apply_pending_eob_line_with_audit(
  p_pending_id uuid,
  p_target_claim_id uuid,
  p_confirm_replace boolean,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_import_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.pending_eob_lines;
  v_doc public.claim_import_documents;
  v_result jsonb;
BEGIN
  SELECT * INTO v_row FROM public.pending_eob_lines WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending_line_not_found: %', p_pending_id USING ERRCODE = 'P0010';
  END IF;
  IF v_row.status = 'applied' THEN
    RETURN jsonb_build_object('status', 'unchanged', 'claim_id', v_row.applied_claim_id, 'document_id', v_row.document_id,
      'auth_period', (SELECT auth_period FROM public.claims_records WHERE id = v_row.applied_claim_id));
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'pending_not_needed: this line was dismissed' USING ERRCODE = 'P0032';
  END IF;
  SELECT * INTO v_doc FROM public.claim_import_documents WHERE id = v_row.document_id;

  v_result := public.apply_eob_line_with_audit(
    v_row.patient_id, v_doc.content_sha256, v_doc.file_name, v_doc.page_count, v_row.line_key, p_target_claim_id,
    jsonb_build_object('date_of_service', v_row.date_of_service, 'cpt_codes', v_row.cpt_codes),
    p_confirm_replace, v_row.data, p_actor_id, p_actor_type, p_actor_display, p_import_batch_id
  );
  -- Covers the no-op case too, where no claim row changed and the trigger did not fire.
  UPDATE public.pending_eob_lines
  SET status = 'applied', applied_claim_id = (v_result ->> 'claim_id')::uuid, resolved_at = now()
  WHERE id = p_pending_id AND status = 'pending';
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_pending_eob_line_with_audit(uuid, uuid, boolean, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_pending_eob_line_with_audit(uuid, uuid, boolean, uuid, text, text, uuid) TO service_role;

-- ─── dismiss_pending_eob_line_with_audit ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.dismiss_pending_eob_line_with_audit(
  p_pending_id uuid,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.pending_eob_lines;
BEGIN
  SELECT * INTO v_row FROM public.pending_eob_lines WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending_line_not_found: %', p_pending_id USING ERRCODE = 'P0010';
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('status', 'unchanged');
  END IF;
  UPDATE public.pending_eob_lines SET status = 'dismissed', resolved_at = now() WHERE id = p_pending_id;
  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'pending_eob_line', v_row.id, v_row.patient_id, p_actor_id, p_actor_type, p_actor_display,
    'EOB_LINE_PENDING_DISMISS', jsonb_build_object('status', 'pending', 'data', v_row.data), jsonb_build_object('status', 'dismissed')
  );
  RETURN jsonb_build_object('status', 'dismissed');
END;
$$;

REVOKE ALL ON FUNCTION public.dismiss_pending_eob_line_with_audit(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_pending_eob_line_with_audit(uuid, uuid, text, text) TO service_role;

-- ─── reopen_dismissed_eob_line_with_audit ──────────────────────────────────
-- The only way back for a dismissed line: a reviewer's explicit decision, with
-- its own audit row. It only returns the line to pending; applying it still
-- goes through apply_eob_line_with_audit.
CREATE OR REPLACE FUNCTION public.reopen_dismissed_eob_line_with_audit(
  p_pending_id uuid,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_import_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.pending_eob_lines;
BEGIN
  SELECT * INTO v_row FROM public.pending_eob_lines WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending_line_not_found: %', p_pending_id USING ERRCODE = 'P0010';
  END IF;
  IF v_row.status <> 'dismissed' THEN
    RETURN jsonb_build_object('status', 'unchanged');
  END IF;
  UPDATE public.pending_eob_lines SET status = 'pending', resolved_at = NULL WHERE id = p_pending_id;
  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data, import_batch_id
  ) VALUES (
    'pending_eob_line', v_row.id, v_row.patient_id, p_actor_id, p_actor_type, p_actor_display,
    'EOB_LINE_PENDING_REOPEN', jsonb_build_object('status', 'dismissed'), jsonb_build_object('status', 'pending'),
    p_import_batch_id
  );
  RETURN jsonb_build_object('status', 'reopened');
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_dismissed_eob_line_with_audit(uuid, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_dismissed_eob_line_with_audit(uuid, uuid, text, text, uuid) TO service_role;

-- ─── a dismissed line can never land on a claim row ────────────────────────
-- Enforced on the row itself, so every path that writes EOB provenance is
-- covered (apply_eob_line_with_audit is shared and does not know about
-- pending lines).
CREATE OR REPLACE FUNCTION public.claims_records_refuse_dismissed_eob()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pending_eob_lines
    WHERE document_id = NEW.eob_document_id AND line_key = NEW.eob_line_key AND status = 'dismissed'
  ) THEN
    RAISE EXCEPTION 'pending_line_dismissed: reopen it first' USING ERRCODE = 'P0033';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.claims_records_refuse_dismissed_eob() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_claims_records_refuse_dismissed_eob ON public.claims_records;
CREATE TRIGGER trg_claims_records_refuse_dismissed_eob
  BEFORE UPDATE OF eob_document_id, eob_line_key ON public.claims_records
  FOR EACH ROW
  WHEN (NEW.eob_document_id IS NOT NULL AND (OLD.eob_document_id IS DISTINCT FROM NEW.eob_document_id OR OLD.eob_line_key IS DISTINCT FROM NEW.eob_line_key))
  EXECUTE FUNCTION public.claims_records_refuse_dismissed_eob();

-- ─── a pending line resolves when its source line lands on a claim row ─────
CREATE OR REPLACE FUNCTION public.claims_records_resolve_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.pending_eob_lines
  SET status = 'applied', applied_claim_id = NEW.id, resolved_at = now()
  WHERE document_id = NEW.eob_document_id AND line_key = NEW.eob_line_key AND status = 'pending';
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claims_records_resolve_pending() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_claims_records_resolve_pending ON public.claims_records;
CREATE TRIGGER trg_claims_records_resolve_pending
  AFTER UPDATE OF eob_document_id, eob_line_key ON public.claims_records
  FOR EACH ROW
  WHEN (NEW.eob_document_id IS NOT NULL AND (OLD.eob_document_id IS DISTINCT FROM NEW.eob_document_id OR OLD.eob_line_key IS DISTINCT FROM NEW.eob_line_key))
  EXECUTE FUNCTION public.claims_records_resolve_pending();

-- ─── P4-P29: Patient Data CSV import (see supabase/migrations/20261113000000) ─
CREATE OR REPLACE FUNCTION public.import_patient_csv_group_with_audit(
  p_patient_name text,
  p_insurance text,
  p_auth_date date,
  p_visits jsonb,
  p_file_name text,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_import_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_name text := NULLIF(regexp_replace(btrim(COALESCE(p_patient_name, '')), '\s+', ' ', 'g'), '');
  v_insurance text := COALESCE(btrim(p_insurance), '');
  v_existing uuid;
  v_patient uuid;
  v_item jsonb;
  v_count integer := 0;
BEGIN
  IF v_name IS NULL OR char_length(v_name) > 200
     OR char_length(v_insurance) > 120
     OR p_visits IS NULL OR jsonb_typeof(p_visits) <> 'array' OR jsonb_array_length(p_visits) > 1000
     OR p_import_batch_id IS NULL THEN
    RAISE EXCEPTION 'invalid_patient_import_input' USING ERRCODE = 'P0027';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('claims-import-new-patient'));

  SELECT id INTO v_existing FROM public.patients
  WHERE public.import_patient_name_key(name) = public.import_patient_name_key(v_name)
  ORDER BY created_at
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'patient_exists', 'patient_id', v_existing, 'sessions', 0);
  END IF;

  INSERT INTO public.patients (name, insurance, auth_date, created_by, created_by_type, updated_by, updated_by_type)
  VALUES (v_name, v_insurance, p_auth_date, p_actor_id, p_actor_type, p_actor_id, p_actor_type)
  RETURNING id INTO v_patient;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data, import_batch_id
  ) VALUES (
    'patient', v_patient, v_patient, p_actor_id, p_actor_type, p_actor_display,
    'PATIENT_CREATE_FROM_IMPORT', NULL,
    jsonb_build_object(
      'name', v_name, 'insurance', v_insurance, 'auth_date', p_auth_date,
      'import_source', 'patient_csv', 'import_file', left(COALESCE(p_file_name, ''), 255)
    ),
    p_import_batch_id
  );

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_visits) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'invalid_patient_import_input: session' USING ERRCODE = 'P0027';
    END IF;
    PERFORM public.write_visit_record_with_audit(
      NULL,
      v_patient,
      jsonb_build_object(
        'sessions_authorized', v_item -> 'sessions_authorized',
        'sessions_remaining', v_item -> 'sessions_remaining',
        'session_number', v_item -> 'session_number',
        'auth_period', 1,
        'date_of_service', v_item -> 'date_of_service',
        'new_auth', v_item -> 'new_auth',
        'date_ash_submitted', v_item -> 'date_ash_submitted',
        'auth_status', 'none'
      ),
      p_actor_id, p_actor_type, p_actor_display, 'VISIT_RECORD_CREATE'
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('status', 'created', 'patient_id', v_patient, 'sessions', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.import_patient_csv_group_with_audit(text, text, date, jsonb, text, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_patient_csv_group_with_audit(text, text, date, jsonb, text, uuid, text, text, uuid) TO service_role;
