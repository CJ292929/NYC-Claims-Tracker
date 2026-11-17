-- ============================================================================
-- P4-P32: Sessions Authorized after patient creation
--
-- A patient can be created before the payer approves an authorization, with
-- no session count and therefore no visit_records rows. Two gaps:
--
--   * approve_authorization_with_audit needs an existing period to approve
--     (P0034 otherwise), so the New Authorization flow could not record the
--     FIRST approval.
--   * the only way to change an existing period's count was the per-row
--     "# Authorized" cell, which edits one row and never adds or removes the
--     period's session rows.
--
-- This migration adds two audited, atomic RPCs. Session counts stay owned by
-- their authorization period (visit_records.sessions_authorized); there is
-- no patient-level count.
--
-- 1. create_initial_authorization_with_audit
--    Records an approval received for a patient with NO visit rows: creates
--    period 1 with p_sessions_authorized empty session rows (same shape as an
--    approval batch: session_number 1..N, sessions_remaining N..1,
--    auth_status 'none') and applies the optional auth date / insurer /
--    valid-until to the patient exactly as approve_authorization_with_audit
--    does. Refused (P0044) once ANY visit row exists, so a retry or double
--    submit can't create a second period and this path can never act as a
--    renewal. One AUTHORIZATION_APPROVED audit row ({initial: true}).
--
-- 2. correct_auth_period_sessions_with_audit
--    Corrects ONE period's authorized count, under the same patient-then-
--    visit-rows lock order as approve / mark / restore:
--      * refused for an Expired period (P0040). A count edit never changes
--        period_expired_at, so it can't reactivate a period; restore first.
--      * refused below the period's completed (dated) sessions (P0041).
--      * refused when the caller's expected current count is stale (P0043),
--        so two editors can't silently overwrite each other.
--      * every row of the period that carries a count gets the new count;
--        stored per-row sessions_remaining values move by the same delta
--        (never below 0). Dates of service, clinical/workflow fields,
--        statuses, money and claims are not written.
--      * a period laid out one row per session (row count >= old count)
--        keeps that layout: an increase appends empty rows, a decrease
--        removes the highest-numbered UNDATED rows. A row picked for removal
--        that holds anything meaningful (authorization request date, a
--        pending/denied/approved status not shared by the whole period, a
--        New Auth note, money, Assignment of Benefits, Submission Status,
--        Remarks) refuses the whole correction (P0042) and names the
--        sessions. Nothing is changed in that case.
--      * a period stored as a single count row (Add Patient) is never given
--        extra rows; only its count changes.
--      * unchanged count: no-op, nothing written, nothing audited.
--    One AUTHORIZATION_PERIOD_SESSIONS_CORRECTED audit row per change.
--
-- Both are SECURITY DEFINER, service_role only (same grants as every other
-- *_with_audit RPC). No table, column, constraint or existing function is
-- changed, so existing rows are untouched.
--
-- Deploy order: apply this migration FIRST, then deploy the app (the app
-- calls both functions). The old app never calls them, so applying early is
-- safe. Idempotent (CREATE OR REPLACE), safe to re-run. Run in READ COMMITTED
-- (the default).
--
-- Rollback (after the app is rolled back):
--   DROP FUNCTION public.create_initial_authorization_with_audit(uuid, integer, date, text, boolean, bigint, uuid, text, text);
--   DROP FUNCTION public.correct_auth_period_sessions_with_audit(uuid, integer, integer, integer, text, uuid, text, text);
-- ============================================================================

BEGIN;

-- ─── 1: initial authorization ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_initial_authorization_with_audit(
  p_patient_id uuid,
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
  v_batch_insurance text;
  v_new_ids uuid[];
BEGIN
  IF p_sessions_authorized IS NULL OR p_sessions_authorized < 1 OR p_sessions_authorized > 200 THEN
    RAISE EXCEPTION 'invalid_sessions_authorized: %', p_sessions_authorized USING ERRCODE = 'P0033';
  END IF;

  -- Same lock order as approve / mark / restore. Holding the patient row
  -- FOR UPDATE serialises two initial approvals of one patient; the second
  -- then sees the first one's rows below and is refused.
  PERFORM 1 FROM public.patients WHERE id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient_not_found: %', p_patient_id USING ERRCODE = 'P0020';
  END IF;

  IF EXISTS (SELECT 1 FROM public.visit_records WHERE patient_id = p_patient_id) THEN
    RAISE EXCEPTION 'initial_authorization_exists: patient % already has authorization periods', p_patient_id
      USING ERRCODE = 'P0044';
  END IF;

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
      1, NULL, NULL, NULL, 'none',
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
    jsonb_build_object('auth_period', NULL, 'initial', true),
    jsonb_build_object('new_auth_period', 1, 'initial', true, 'sessions_authorized', p_sessions_authorized, 'new_visit_ids', to_jsonb(v_new_ids))
  );

  RETURN QUERY SELECT unnest(v_new_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.create_initial_authorization_with_audit(uuid, integer, date, text, boolean, bigint, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_initial_authorization_with_audit(uuid, integer, date, text, boolean, bigint, uuid, text, text) TO service_role;

-- ─── 2: period count correction ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.correct_auth_period_sessions_with_audit(
  p_patient_id uuid,
  p_auth_period integer,
  p_sessions_authorized integer,
  p_expected_current integer,
  p_reason text,
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
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_row_count integer;
  v_current integer;
  v_completed integer;
  v_expired boolean;
  v_max_session integer;
  v_period_status text;
  v_uniform_status boolean;
  v_insurance text;
  v_delta integer;
  v_materialized boolean;
  v_remove_ids uuid[] := ARRAY[]::uuid[];
  v_blocked text;
  v_added_ids uuid[] := ARRAY[]::uuid[];
  v_count_rows integer;
BEGIN
  IF p_sessions_authorized IS NULL OR p_sessions_authorized < 1 OR p_sessions_authorized > 200 THEN
    RAISE EXCEPTION 'invalid_sessions_authorized: %', p_sessions_authorized USING ERRCODE = 'P0033';
  END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reason_too_long' USING ERRCODE = '22023';
  END IF;

  -- Lock order: patient, then every visit row of that patient.
  PERFORM 1 FROM public.patients WHERE id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient_not_found: %', p_patient_id USING ERRCODE = 'P0020';
  END IF;
  PERFORM 1 FROM public.visit_records WHERE patient_id = p_patient_id FOR UPDATE;

  SELECT count(*)::integer,
         count(date_of_service)::integer,
         bool_or(period_expired_at IS NOT NULL),
         max(session_number),
         count(sessions_authorized)::integer,
         min(auth_status),
         (count(DISTINCT auth_status) = 1)
    INTO v_row_count, v_completed, v_expired, v_max_session, v_count_rows, v_period_status, v_uniform_status
  FROM public.visit_records
  WHERE patient_id = p_patient_id AND auth_period = p_auth_period;

  IF v_row_count = 0 THEN
    RAISE EXCEPTION 'auth_period_not_found: %', p_auth_period USING ERRCODE = 'P0034';
  END IF;

  -- The count the app shows (shared/authPeriodMetrics.ts getPeriodMetrics):
  -- the first row, in session order, that carries one; 0 when none does.
  SELECT sessions_authorized INTO v_current
  FROM public.visit_records
  WHERE patient_id = p_patient_id AND auth_period = p_auth_period AND sessions_authorized IS NOT NULL
  ORDER BY session_number ASC NULLS LAST, id
  LIMIT 1;
  v_current := COALESCE(v_current, 0);

  IF v_expired THEN
    RAISE EXCEPTION 'auth_period_expired: period % is marked Expired; restore it before correcting its count', p_auth_period
      USING ERRCODE = 'P0040';
  END IF;

  IF p_expected_current IS NOT NULL AND p_expected_current <> v_current THEN
    RAISE EXCEPTION 'auth_period_count_changed: period % now has % authorized (expected %)', p_auth_period, v_current, p_expected_current
      USING ERRCODE = 'P0043';
  END IF;

  IF p_sessions_authorized < v_completed THEN
    RAISE EXCEPTION 'sessions_below_completed: % is below the % completed sessions of period %', p_sessions_authorized, v_completed, p_auth_period
      USING ERRCODE = 'P0041';
  END IF;

  -- No-op: nothing written, nothing audited.
  IF p_sessions_authorized = v_current THEN
    RETURN jsonb_build_object('changed', false, 'sessions_authorized', v_current, 'added', 0, 'removed', 0);
  END IF;

  v_delta := p_sessions_authorized - v_current;
  v_materialized := v_row_count >= v_current;

  -- ── Rows to remove: only for a one-row-per-session period with more rows
  -- than the new count; the highest-numbered UNDATED rows. ──
  IF v_materialized AND v_row_count > p_sessions_authorized THEN
    SELECT array_agg(id) INTO v_remove_ids FROM (
      SELECT id FROM public.visit_records
      WHERE patient_id = p_patient_id AND auth_period = p_auth_period AND date_of_service IS NULL
      ORDER BY session_number DESC NULLS FIRST, id DESC
      LIMIT (v_row_count - p_sessions_authorized)
    ) picked;
    v_remove_ids := COALESCE(v_remove_ids, ARRAY[]::uuid[]);

    SELECT string_agg(COALESCE(session_number::text, '(unnumbered)'), ', ' ORDER BY session_number NULLS LAST)
      INTO v_blocked
    FROM public.visit_records
    WHERE id = ANY (v_remove_ids)
      AND (
        date_ash_submitted IS NOT NULL
        OR (auth_status <> 'none' AND NOT v_uniform_status)
        OR (new_auth IS NOT NULL AND upper(btrim(new_auth)) NOT IN ('', 'NO'))
        OR total_insurance_reimbursement IS NOT NULL
        OR total_patient_due IS NOT NULL
        OR total_patient_paid IS NOT NULL
        OR assignment_of_benefits IS NOT NULL
        OR submission_status IS NOT NULL
        OR NULLIF(btrim(COALESCE(remarks, '')), '') IS NOT NULL
      );

    IF v_blocked IS NOT NULL THEN
      RAISE EXCEPTION 'session_rows_hold_data: reducing period % to % would remove session(s) % which hold recorded data', p_auth_period, p_sessions_authorized, v_blocked
        USING ERRCODE = 'P0042', DETAIL = v_blocked;
    END IF;
  END IF;

  -- ── Rewrite the count (and shift stored remaining) on the rows that keep it. ──
  IF v_count_rows = 0 THEN
    -- No row carries a count yet: put it on the first row in session order.
    UPDATE public.visit_records SET
      sessions_authorized = p_sessions_authorized,
      updated_by = p_actor_id, updated_by_type = p_actor_type
    WHERE id = (
      SELECT id FROM public.visit_records
      WHERE patient_id = p_patient_id AND auth_period = p_auth_period AND NOT (id = ANY (v_remove_ids))
      ORDER BY session_number ASC NULLS LAST, id LIMIT 1
    );
  END IF;

  UPDATE public.visit_records SET
    sessions_authorized = CASE WHEN sessions_authorized IS NULL THEN NULL ELSE p_sessions_authorized END,
    sessions_remaining = CASE WHEN sessions_remaining IS NULL THEN NULL ELSE GREATEST(0, sessions_remaining + v_delta) END,
    updated_by = p_actor_id,
    updated_by_type = p_actor_type
  WHERE patient_id = p_patient_id AND auth_period = p_auth_period
    AND NOT (id = ANY (v_remove_ids))
    AND ((sessions_authorized IS NOT NULL AND sessions_authorized <> p_sessions_authorized)
         OR sessions_remaining IS NOT NULL);

  IF array_length(v_remove_ids, 1) > 0 THEN
    DELETE FROM public.visit_records WHERE id = ANY (v_remove_ids);
  END IF;

  -- ── Append empty rows: only for a one-row-per-session period. ──
  IF v_materialized AND v_row_count < p_sessions_authorized THEN
    SELECT insurance_company INTO v_insurance
    FROM public.visit_records
    WHERE patient_id = p_patient_id AND auth_period = p_auth_period AND insurance_company IS NOT NULL
    ORDER BY session_number ASC NULLS LAST, id LIMIT 1;

    WITH inserted AS (
      INSERT INTO public.visit_records (
        patient_id, sessions_authorized, sessions_remaining, session_number,
        auth_period, date_of_service, new_auth, date_ash_submitted, auth_status,
        insurance_company, created_by, created_by_type, updated_by, updated_by_type
      )
      SELECT
        p_patient_id, p_sessions_authorized,
        GREATEST(0, p_sessions_authorized - (COALESCE(v_max_session, 0) + gs - 1)),
        COALESCE(v_max_session, 0) + gs,
        p_auth_period, NULL, NULL, NULL,
        CASE WHEN v_uniform_status THEN v_period_status ELSE 'none' END,
        v_insurance, p_actor_id, p_actor_type, p_actor_id, p_actor_type
      FROM generate_series(1, p_sessions_authorized - v_row_count) AS gs
      RETURNING id
    )
    SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_added_ids FROM inserted;
  END IF;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'visit_record', p_patient_id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    'AUTHORIZATION_PERIOD_SESSIONS_CORRECTED',
    jsonb_build_object('auth_period', p_auth_period, 'sessions_authorized', v_current, 'session_rows', v_row_count),
    jsonb_build_object(
      'auth_period', p_auth_period,
      'sessions_authorized', p_sessions_authorized,
      'sessions_completed', v_completed,
      'session_rows', v_row_count - COALESCE(array_length(v_remove_ids, 1), 0) + COALESCE(array_length(v_added_ids, 1), 0),
      'added_visit_ids', to_jsonb(v_added_ids),
      'removed_visit_ids', to_jsonb(v_remove_ids),
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'changed', true,
    'sessions_authorized', p_sessions_authorized,
    'added', COALESCE(array_length(v_added_ids, 1), 0),
    'removed', COALESCE(array_length(v_remove_ids, 1), 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.correct_auth_period_sessions_with_audit(uuid, integer, integer, integer, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.correct_auth_period_sessions_with_audit(uuid, integer, integer, integer, text, uuid, text, text) TO service_role;

COMMIT;
