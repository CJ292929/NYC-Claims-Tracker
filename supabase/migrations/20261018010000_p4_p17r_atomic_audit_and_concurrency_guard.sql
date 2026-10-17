-- ============================================================================
-- P4-P17R: Complete audit coverage + close the last-admin race + make
-- authorization approval atomic
--
-- Follow-up to 20261018000000_p4_p17_account_management_and_audit.sql. That
-- migration explicitly scoped visit_records' own create/update and
-- insurer_catalog's create/deactivate/reactivate OUT of a mutation+audit
-- RPC (stamping only). This migration closes that gap for the single-row
-- paths (NOT bulkCreateVisitRecords, which stays intentionally unaudited
-- per-row — see that migration's comment on noise):
--
-- 1. write_visit_record_with_audit — same jsonb_populate_record diff
--    pattern as write_patient_with_audit/write_claim_record_with_audit, for
--    visits.create/update (single row).
-- 2. write_insurer_catalog_with_audit — same pattern, for insurance.create/
--    delete/reactivate.
-- 3. approve_authorization_with_audit — folds approveAndCreateNewBatch's
--    writes (mark period approved, patch patient, insert next batch) AND
--    its audit_logs entry into ONE Postgres transaction/RPC call, replacing
--    the sequential multi-request version in server/db.ts. The read-only
--    "which period is active" business rule (shared/authPeriodMetrics.ts)
--    stays in the application layer and is passed in as p_target_period —
--    duplicating that rule in plpgsql would risk the two implementations
--    silently drifting apart, so instead this function RE-VALIDATES
--    p_target_period against the patient's actual visit_records under lock
--    (rejecting a stale/wrong period rather than trusting the caller
--    blindly) and recomputes the next period itself from MAX(auth_period),
--    which has no such business-rule ambiguity.
--
-- 4. Fixes a genuine TOCTOU race in the P4-P17 "last active account
--    manager" guard: update_clinic_user_role_with_audit and
--    archive_clinic_user_with_audit each counted OTHER active admins with a
--    plain SELECT COUNT(*) (no row lock). With exactly two active admins A
--    and B, a transaction demoting A and a concurrent transaction demoting
--    B each see "1 other active admin" under READ COMMITTED (neither has
--    committed yet) and both pass the guard — result: zero active admins,
--    the exact state the guard exists to prevent. The fix locks the ENTIRE
--    active-admin row set with SELECT ... FOR UPDATE (not just "other"
--    rows) before counting. Two concurrent callers targeting an overlapping
--    admin set now contend for the same row locks and serialize: the second
--    blocks until the first commits, then re-reads the post-commit state,
--    so it correctly sees the now-reduced admin count and is rejected.
--
-- Written idempotently (CREATE OR REPLACE), matching prior migrations.
-- ============================================================================

BEGIN;

-- ─── 1: write_visit_record_with_audit ──────────────────────────────────────
-- p_id NULL => insert; otherwise update. Mirrors write_claim_record_with_audit's
-- ownership check (p_patient_id must match the existing row) and no-op skip
-- (an update whose diff is empty writes no audit row).
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
      created_by, created_by_type, updated_by, updated_by_type
    ) VALUES (
      p_patient_id, v_after.sessions_authorized, v_after.sessions_remaining, v_after.session_number,
      COALESCE(v_after.auth_period, 1), v_after.date_of_service, v_after.new_auth, v_after.date_ash_submitted,
      COALESCE(v_after.auth_status, 'none'), v_after.insurance_company, v_after.total_insurance_reimbursement,
      v_after.total_patient_due, v_after.total_patient_paid,
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
    -- p_patient_id is optional on update: the row id already uniquely
    -- identifies it, so callers that don't have the patient id handy (e.g.
    -- a plain visits.update by row id) may pass NULL. When a caller DOES
    -- supply one, it's checked as a belt-and-suspenders ownership guard.
    IF p_patient_id IS NOT NULL AND v_before.patient_id <> p_patient_id THEN
      RAISE EXCEPTION 'visit_record_patient_mismatch: % does not belong to %', p_id, p_patient_id
        USING ERRCODE = 'P0031';
    END IF;

    v_after := jsonb_populate_record(v_before, p_data);

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
        'visit_record', p_id, v_before.patient_id, p_actor_id, p_actor_type, p_actor_display,
        p_action, v_before_diff, v_after_diff
      );
    END IF;

    RETURN p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.write_visit_record_with_audit(uuid, uuid, jsonb, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_visit_record_with_audit(uuid, uuid, jsonb, uuid, text, text, text) TO service_role;

-- ─── 2: write_insurer_catalog_with_audit ────────────────────────────────────
-- p_id NULL => insert (p_data must contain "name"); otherwise update
-- (deactivate/reactivate toggle is_active + the deactivated_*/reactivated_*
-- columns). normalized_name is a GENERATED column and never part of p_data.
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
    SELECT * INTO v_before FROM public.insurer_catalog WHERE id = p_id FOR UPDATE;
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

-- ─── 3: approve_authorization_with_audit ───────────────────────────────────
-- Replaces approveAndCreateNewBatch's 4 sequential Supabase requests (approve
-- update, patient update, batch insert, audit insert) with one transaction.
-- p_auth_date: only applied when NOT NULL (matches the old "if (authDate)"
-- app-level check — there was never a way to explicitly clear auth_date via
-- this path). p_new_insurance: only applied when non-blank after trim.
-- p_auth_valid_until_provided distinguishes "caller didn't pass this field"
-- from "caller explicitly passed null to clear it" (authValidUntil ?? null
-- in the old app code) -- a plain nullable int param can't express that.
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

  -- Lock the patient row and every visit row for this patient up front so a
  -- concurrent approval (or edit) for the SAME patient serializes instead of
  -- interleaving with this one.
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

-- ─── 4: last-active-account-manager race fix ───────────────────────────────
-- Both functions below are CREATE OR REPLACE of the exact same signatures
-- from the P4-P17 migration — only the guard query changes (locks the WHOLE
-- active-admin set, including the row already locked by the earlier
-- `SELECT * ... FOR UPDATE` on p_id, rather than just "other" rows).

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
  v_total_active_admins integer;
BEGIN
  SELECT * INTO v_before FROM public.clinic_users WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clinic_user_not_found: %', p_id USING ERRCODE = 'P0021';
  END IF;
  IF v_before.token_version <> p_expected_token_version THEN
    RAISE EXCEPTION 'clinic_user_conflict: % token_version moved', p_id USING ERRCODE = 'P0022';
  END IF;

  -- Last-active-account-manager guard: demoting the last remaining active
  -- admin is rejected regardless of who's performing the demotion. Locks
  -- EVERY active-admin row (not just "other" ones) so a second, concurrent
  -- demote/archive targeting a different admin in the same set blocks here
  -- until this transaction commits or rolls back, instead of both reading a
  -- stale pre-commit count and both passing.
  IF v_before.role = 'admin' AND p_role <> 'admin' AND v_before.status = 'active' THEN
    -- FOR UPDATE can't be combined with an aggregate in the same SELECT, so
    -- the lock and the count are two statements: lock every matching row
    -- first (blocking here if a concurrent call holds one of them), THEN
    -- count — by the time count() runs, every row it can see is one this
    -- transaction itself holds the lock on, so the count is race-free.
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
    -- FOR UPDATE can't be combined with an aggregate in the same SELECT, so
    -- the lock and the count are two statements: lock every matching row
    -- first (blocking here if a concurrent call holds one of them), THEN
    -- count — by the time count() runs, every row it can see is one this
    -- transaction itself holds the lock on, so the count is race-free.
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

COMMIT;

-- ============================================================================
-- ROLLBACK (for reference — not executed by this file)
-- ============================================================================
-- BEGIN;
-- -- Restores the P4-P17 (pre-P4-P17R) guard bodies by re-running this
-- -- migration's CREATE OR REPLACE blocks with the old unlocked COUNT query,
-- -- or simply re-apply 20261018000000's definitions verbatim.
-- DROP FUNCTION IF EXISTS public.approve_authorization_with_audit(uuid, integer, integer, date, text, boolean, bigint, uuid, text, text);
-- DROP FUNCTION IF EXISTS public.write_insurer_catalog_with_audit(uuid, jsonb, uuid, text, text, text);
-- DROP FUNCTION IF EXISTS public.write_visit_record_with_audit(uuid, uuid, jsonb, uuid, text, text, text);
-- COMMIT;
