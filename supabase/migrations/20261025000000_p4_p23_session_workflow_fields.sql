-- ============================================================================
-- P4-P23: Per-session workflow fields on visit_records
--
-- The Patient Records authorization/session table replaces its three
-- financial total columns (which stay stored, unchanged, and become Super
-- Admin only at the API layer) with three per-session workflow fields:
--
--   assignment_of_benefits  'yes' | 'no'                          | NULL
--   submission_status       'ready_to_file' | 'hold' | 'do_not_file' | NULL
--   remarks                 free text, at most 2000 characters    | NULL
--
-- All three are NULLABLE WITH NO DEFAULT. Existing rows read as "unset":
-- a missing Assignment of Benefits is NOT an implied 'no', and no existing
-- session is defaulted to 'ready_to_file'. Adding nullable columns with no
-- default is a metadata-only change in Postgres (no table rewrite); the
-- CHECK constraints validate trivially because every existing value is NULL.
--
-- write_visit_record_with_audit is replaced (CREATE OR REPLACE, SAME
-- signature and return type) so its INSERT/UPDATE also carry the new
-- columns. Compatibility during the migration-before-deploy window: the
-- currently deployed app never sends the new keys, and jsonb_populate_record
-- keeps the stored value for any key absent from p_data, so old code keeps
-- working unchanged against the new function. The new app code REQUIRES
-- this migration (it reads/writes the new columns) — apply this first.
--
-- One behavior tightening in the replaced function: an update whose diff is
-- empty (a no-op save) now skips the UPDATE itself as well as the audit
-- row, so a no-op no longer re-stamps updated_by/updated_by_type with an
-- actor who changed nothing. Every real change still updates and audits in
-- one transaction exactly as before (any audit INSERT failure raises and
-- rolls the row update back with it).
--
-- Written idempotently (IF NOT EXISTS / guarded constraints / CREATE OR
-- REPLACE), matching prior migrations, so it is safe to re-run.
--
-- Rollback (manual, only if the app is rolled back first):
--   restore write_visit_record_with_audit from
--     20261018010000_p4_p17r_atomic_audit_and_concurrency_guard.sql
--   ALTER TABLE public.visit_records
--     DROP CONSTRAINT IF EXISTS visit_records_assignment_of_benefits_check,
--     DROP CONSTRAINT IF EXISTS visit_records_submission_status_check,
--     DROP CONSTRAINT IF EXISTS visit_records_remarks_length_check,
--     DROP COLUMN IF EXISTS assignment_of_benefits,
--     DROP COLUMN IF EXISTS submission_status,
--     DROP COLUMN IF EXISTS remarks;
--   (dropping the columns discards any values staff entered.)
-- ============================================================================

BEGIN;

ALTER TABLE public.visit_records
  ADD COLUMN IF NOT EXISTS assignment_of_benefits text,
  ADD COLUMN IF NOT EXISTS submission_status text,
  ADD COLUMN IF NOT EXISTS remarks text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'visit_records_assignment_of_benefits_check'
      AND conrelid = 'public.visit_records'::regclass
  ) THEN
    ALTER TABLE public.visit_records
      ADD CONSTRAINT visit_records_assignment_of_benefits_check
      CHECK (assignment_of_benefits IS NULL OR assignment_of_benefits IN ('yes', 'no'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'visit_records_submission_status_check'
      AND conrelid = 'public.visit_records'::regclass
  ) THEN
    ALTER TABLE public.visit_records
      ADD CONSTRAINT visit_records_submission_status_check
      CHECK (submission_status IS NULL OR submission_status IN ('ready_to_file', 'hold', 'do_not_file'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'visit_records_remarks_length_check'
      AND conrelid = 'public.visit_records'::regclass
  ) THEN
    ALTER TABLE public.visit_records
      ADD CONSTRAINT visit_records_remarks_length_check
      CHECK (remarks IS NULL OR char_length(remarks) <= 2000);
  END IF;
END $$;

COMMENT ON COLUMN public.visit_records.assignment_of_benefits IS
  'P4-P23: per-session Assignment of Benefits (yes/no). NULL = not yet set — never an implied no.';
COMMENT ON COLUMN public.visit_records.submission_status IS
  'P4-P23: per-session submission status (ready_to_file/hold/do_not_file). NULL = not yet set.';
COMMENT ON COLUMN public.visit_records.remarks IS
  'P4-P23: per-session staff remarks, at most 2000 characters. NULL = none.';

-- p_id NULL => insert; otherwise update. Same signature as P4-P17R.
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

COMMIT;
