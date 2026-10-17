-- ============================================================================
-- P4-P17: Individual accounts and record activity history
--
-- 1. Generalizes public.audit_logs from a patient-only field-change log into
--    a generic entity event log (entity_type/entity_id), tagged with WHICH
--    identity table the actor came from (actor_type) and a point-in-time
--    display name snapshot (actor_display) so historical attribution
--    survives a later account deactivation/rename. Adds import_batch_id so
--    related events from one bulk import/extraction can be grouped, and
--    before_data/after_data jsonb for a controlled field-level diff (never
--    the full row — callers choose exactly which keys go in).
--
-- 2. Locks audit_logs down the same way insurer_catalog already is: RLS
--    enabled with zero policies (default-deny for anon/authenticated),
--    privileges revoked from PUBLIC/anon/authenticated, granted only to
--    service_role. Previously this table had NO such lockdown — a real gap
--    given it's now a cross-entity activity log, not just a narrow
--    patient-name trail.
--
-- 3. Adds created_by/created_by_type/updated_by/updated_by_type to
--    patients, visit_records, claims_records, insurer_catalog — cheap,
--    single-statement attribution (set in the same INSERT/UPDATE as the
--    business write, so it's atomic by construction) that backs the
--    "Created by / Last updated by" UI without needing a join against
--    audit_logs for the common case. NULL on pre-existing rows is
--    intentional — the UI renders "Unknown — recorded before tracking"
--    for those, never a guess.
--
-- 4. Adds atomic mutation+audit RPCs (single Postgres transaction per call,
--    same pattern as the existing delete_claim_record_with_audit) for the
--    mutations that write both a business table AND audit_logs:
--      - write_patient_with_audit      (patients create/update)
--      - write_claim_record_with_audit (claims create/update/upsert,
--        reused by CMS1500 enrichment and the reimbursement/CMS1500 bulk
--        import paths, since all of those ultimately write claims_records)
--      - create_clinic_user_with_audit / update_clinic_user_role_with_audit /
--        admin_reset_clinic_user_password_with_audit /
--        archive_clinic_user_with_audit / reactivate_clinic_user_with_audit
--        (staff account management)
--    delete_claim_record_with_audit is updated in place to also populate
--    entity_type/entity_id/actor_type/actor_display (existing rows keep
--    their old patient-scoped shape; only new columns are added).
--
--    Scope note: visit_records' own create/update/bulkCreate and
--    insurer_catalog's create/deactivate/reactivate are NOT routed through
--    a mutation+audit RPC in this migration — they get created_by/updated_by
--    stamping (atomic, single statement) but not a separate audit_logs
--    timeline entry. insurer_catalog already carries its own
--    deactivated_at/by + reactivated_at/by columns, which is its complete
--    history. Visit-record session rows are typically created dozens at a
--    time (initial scheduling) and a per-row audit_logs entry for every one
--    would be noise rather than a meaningful event; the authorization-level
--    actions that actually matter (approve authorization, mark requested)
--    are covered via application-level audit_logs inserts in server/db.ts
--    instead (sequential, not RPC-atomic — see server/db.ts comments).
--
-- 5. Adds a "last active account manager" guard inside
--    update_clinic_user_role_with_audit / archive_clinic_user_with_audit:
--    demoting or archiving the last remaining active admin clinic_user is
--    rejected, independent of who's performing the action.
--
-- Written idempotently (IF NOT EXISTS / CREATE OR REPLACE / DO blocks)
-- matching the style of every prior migration in this repo, and kept in
-- sync with references/local-setup-schema.sql.
-- ============================================================================

BEGIN;

-- ─── 1+2: audit_logs generalization + lockdown ─────────────────────────────

ALTER TABLE public.audit_logs
  ALTER COLUMN patient_id DROP NOT NULL;

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS entity_type text,
  ADD COLUMN IF NOT EXISTS entity_id uuid,
  ADD COLUMN IF NOT EXISTS actor_type text,
  ADD COLUMN IF NOT EXISTS actor_display text,
  ADD COLUMN IF NOT EXISTS before_data jsonb,
  ADD COLUMN IF NOT EXISTS after_data jsonb,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid;

-- Backfill existing rows (all pre-date entity_type — they're all the
-- patient-name-edit / claim-delete events the table originally held).
UPDATE public.audit_logs
SET entity_type = 'patient', entity_id = patient_id
WHERE entity_type IS NULL AND patient_id IS NOT NULL;

UPDATE public.audit_logs
SET entity_type = 'claim_record', entity_id = (old_value)::uuid
WHERE entity_type IS NULL AND action = 'CLAIM_RECORD_DELETE' AND old_value ~ '^[0-9a-f-]{36}$';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_entity_type_check') THEN
    ALTER TABLE public.audit_logs
      ADD CONSTRAINT audit_logs_entity_type_check CHECK (
        entity_type IS NULL OR entity_type IN (
          'patient', 'visit_record', 'claim_record', 'insurer_catalog', 'clinic_user'
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_actor_type_check') THEN
    ALTER TABLE public.audit_logs
      ADD CONSTRAINT audit_logs_actor_type_check CHECK (
        actor_type IS NULL OR actor_type IN ('clinic_user', 'owner')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_import_batch ON public.audit_logs(import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at DESC);

-- Same lockdown pattern as insurer_catalog (20261004000000_insurer_catalog.sql):
-- RLS enabled with zero policies = default-deny for every RLS-subject role;
-- NOT FORCEd so the table owner (Supabase SQL Editor) keeps direct access;
-- privileges revoked from PUBLIC/anon/authenticated and granted only to
-- service_role, since every legitimate reader/writer goes through
-- server/db.ts's service-role client.
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_logs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.audit_logs TO service_role;

-- ─── 3: created_by / updated_by columns ────────────────────────────────────

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS created_by_type text,
  ADD COLUMN IF NOT EXISTS updated_by uuid,
  ADD COLUMN IF NOT EXISTS updated_by_type text;

ALTER TABLE public.visit_records
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS created_by_type text,
  ADD COLUMN IF NOT EXISTS updated_by uuid,
  ADD COLUMN IF NOT EXISTS updated_by_type text;

ALTER TABLE public.claims_records
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS created_by_type text,
  ADD COLUMN IF NOT EXISTS updated_by uuid,
  ADD COLUMN IF NOT EXISTS updated_by_type text;

ALTER TABLE public.insurer_catalog
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS created_by_type text;

-- ─── 4a: write_patient_with_audit ───────────────────────────────────────────
-- p_id NULL => insert a new patient; otherwise updates the given row.
-- p_data keys are snake_case patient columns the caller wants to set; keys
-- omitted entirely are left untouched (jsonb_populate_record uses the
-- existing row, or NULL defaults on insert, as its base). Only the keys
-- actually present in p_data are compared/stored in the audit diff, and the
-- audit row is skipped entirely when nothing in that set actually changed
-- (so a retried/no-op save never produces a misleading duplicate entry).
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

-- ─── 4b: write_claim_record_with_audit ──────────────────────────────────────
-- Same shape as write_patient_with_audit, for claims_records. Used by
-- claims.create/update/upsert, CMS1500 enrichment, and both bulk-import
-- paths (reimbursement + CMS1500) — every one of those ultimately resolves
-- to "insert or patch one claims_records row", so they all funnel through
-- this one function. p_patient_id is required even on update as a
-- belt-and-suspenders ownership check (mirrors delete_claim_record_with_audit).
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

-- ─── 4c: delete_claim_record_with_audit — add entity/actor columns ─────────
-- Same locking/validation behavior as before; now also populates
-- entity_type/entity_id/actor_type/actor_display on the audit row it writes.
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

-- Old 3-arg signature is superseded by the 5-arg one above (last 2 params
-- have defaults, so existing callers that only pass 3 args keep working
-- against the new definition without needing a separate overload).

-- ─── 4d: staff account management RPCs ──────────────────────────────────────
-- Each wraps the existing CAS-guarded clinic_users update (unchanged logic)
-- together with its audit_logs entry in one transaction. Password hashes
-- are NEVER written into before_data/after_data — admin_reset's audit row
-- carries no before/after payload at all, only actor/entity/action/timestamp.

CREATE OR REPLACE FUNCTION public.create_clinic_user_with_audit(
  p_username text,
  p_password_hash text,
  p_name text,
  p_email text,
  p_department text,
  p_role text,
  p_status text,
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
  p_id uuid,
  p_role text,
  p_expected_token_version integer,
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

  -- Last-active-account-manager guard: demoting the last remaining active
  -- admin is rejected regardless of who's performing the demotion.
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
  p_id uuid,
  p_password_hash text,
  p_expected_token_version integer,
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

  -- No before/after payload -- never store password hashes or any
  -- credential-shaped value in the audit trail, only that a reset happened.
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
  p_id uuid,
  p_expected_token_version integer,
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

COMMIT;

-- ============================================================================
-- ROLLBACK (for reference — not executed by this file)
-- ============================================================================
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.reactivate_clinic_user_with_audit(uuid, uuid, text, text);
-- DROP FUNCTION IF EXISTS public.archive_clinic_user_with_audit(uuid, integer, uuid, text, text);
-- DROP FUNCTION IF EXISTS public.admin_reset_clinic_user_password_with_audit(uuid, text, integer, uuid, text, text);
-- DROP FUNCTION IF EXISTS public.update_clinic_user_role_with_audit(uuid, text, integer, uuid, text, text);
-- DROP FUNCTION IF EXISTS public.create_clinic_user_with_audit(text, text, text, text, text, text, text, uuid, text, text);
-- DROP FUNCTION IF EXISTS public.write_claim_record_with_audit(uuid, uuid, jsonb, uuid, text, text, text, uuid);
-- DROP FUNCTION IF EXISTS public.write_patient_with_audit(uuid, jsonb, uuid, text, text, text);
-- ALTER TABLE public.insurer_catalog DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS created_by_type;
-- ALTER TABLE public.claims_records DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS created_by_type, DROP COLUMN IF EXISTS updated_by, DROP COLUMN IF EXISTS updated_by_type;
-- ALTER TABLE public.visit_records DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS created_by_type, DROP COLUMN IF EXISTS updated_by, DROP COLUMN IF EXISTS updated_by_type;
-- ALTER TABLE public.patients DROP COLUMN IF EXISTS created_by, DROP COLUMN IF EXISTS created_by_type, DROP COLUMN IF EXISTS updated_by, DROP COLUMN IF EXISTS updated_by_type;
-- ALTER TABLE public.audit_logs DISABLE ROW LEVEL SECURITY;
-- GRANT ALL ON public.audit_logs TO PUBLIC;
-- ALTER TABLE public.audit_logs DROP COLUMN IF EXISTS import_batch_id, DROP COLUMN IF EXISTS after_data, DROP COLUMN IF EXISTS before_data, DROP COLUMN IF EXISTS actor_display, DROP COLUMN IF EXISTS actor_type, DROP COLUMN IF EXISTS entity_id, DROP COLUMN IF EXISTS entity_type;
-- ALTER TABLE public.audit_logs ALTER COLUMN patient_id SET NOT NULL;
-- COMMIT;
