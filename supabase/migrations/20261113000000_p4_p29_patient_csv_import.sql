-- ============================================================================
-- P4-P29: restore "Bulk Upload Patients" (Patient Data CSV) on Patient Records.
--
-- New, additive only:
--   import_patient_csv_group_with_audit(...)  one transaction per patient: the
--     patient row, its PATIENT_CREATE_FROM_IMPORT audit row, and each session
--     (through write_visit_record_with_audit, which writes its own audit row).
--     Any failure rolls all of it back, so a patient never exists without its
--     sessions, and a half-saved patient can never be retried into a duplicate.
--
-- Duplicates and retries: takes the same transaction-scoped advisory lock as
-- commit_import_with_new_patient (P4-P28) and then checks the same
-- import_patient_name_key rule. A patient whose name key already exists is
-- never changed: the function returns status 'patient_exists' and writes
-- nothing. So a retried save, two people saving the same file at once, and a
-- CMS1500 import creating the same person concurrently all converge on one
-- patient.
--
-- Only demographic and session-count columns are written. No money, claim
-- status, claim row, external id or pending EOB line is ever touched; each
-- session is built from an explicit key list, never from the caller's JSON
-- as-is.
--
-- Compatibility: nothing existing is altered, so the currently deployed app
-- keeps working against this schema. The new app code REQUIRES this
-- migration: apply it first. Written idempotently, safe to re-run.
--
-- Rollback (manual, only after the app is rolled back; patients already
-- imported are kept):
--   DROP FUNCTION IF EXISTS public.import_patient_csv_group_with_audit(text, text, date, jsonb, text, uuid, text, text, uuid);
-- ============================================================================

BEGIN;

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

COMMIT;
